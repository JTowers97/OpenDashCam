package org.opendashcam.backup

import java.io.File
import java.nio.ByteBuffer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * ODC encrypted file format (.odcenc), designed for streaming and resumable uploads:
 *
 *   header (53 bytes):
 *     magic "ODCENC1\n" (8) | version u8 = 1 | salt (16) | PBKDF2 iterations u32 BE | chunk size u32 BE
 *     | nonce prefix (4) | key check (16) = first 16 bytes of HMAC-SHA256(key, "ODC key check")
 *   then chunks, each: nonce (12) = prefix | chunk index u64 BE, followed by AES-256-GCM ciphertext + 16-byte tag.
 *     AAD = header | chunk index u64 BE | final flag u8 (1 on the last chunk, 0 otherwise)
 *
 * Key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 256 bits). Every chunk except the last
 * holds exactly chunkSize bytes of plaintext. tools/odc_decrypt.py decrypts these files.
 */
class OdcEncryption private constructor(val header: ByteArray, private val key: SecretKeySpec, val chunkSize: Int) {

    private val noncePrefix = header.copyOfRange(33, 37)

    val encryptedChunkSize: Int get() = chunkSize + OVERHEAD

    fun encryptedSize(plainSize: Long): Long {
        val chunks = maxOf(1L, (plainSize + chunkSize - 1) / chunkSize)
        return HEADER_LEN + chunks * OVERHEAD + plainSize
    }

    fun decryptChunk(index: Long, chunk: ByteArray, length: Int, isFinal: Boolean): ByteArray {
        val nonce = ByteBuffer.allocate(12).put(noncePrefix).putLong(index).array()
        for (i in 0 until 12) if (chunk[i] != nonce[i]) throw IllegalStateException("Chunk $index is out of order")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD(header)
        cipher.updateAAD(ByteBuffer.allocate(9).putLong(index).put(if (isFinal) 1 else 0).array())
        return cipher.doFinal(chunk, 12, length - 12)
    }

    fun encryptChunk(index: Long, data: ByteArray, length: Int, isFinal: Boolean): ByteArray {
        val nonce = ByteBuffer.allocate(12).put(noncePrefix).putLong(index).array()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, nonce))
        cipher.updateAAD(header)
        cipher.updateAAD(ByteBuffer.allocate(9).putLong(index).put(if (isFinal) 1 else 0).array())
        val ct = cipher.doFinal(data, 0, length)
        return nonce + ct
    }

    companion object {
        const val HEADER_LEN = 53
        const val OVERHEAD = 12 + 16
        const val EXTENSION = "odcenc"
        private val MAGIC = "ODCENC1\n".toByteArray(Charsets.US_ASCII)
        private const val ITERATIONS = 200_000
        private const val CHUNK = 1024 * 1024

        /** Starts a new encrypted file with a fresh random salt and nonce prefix. */
        fun create(passphrase: String): OdcEncryption {
            val rnd = SecureRandom()
            val salt = ByteArray(16).also { rnd.nextBytes(it) }
            val prefix = ByteArray(4).also { rnd.nextBytes(it) }
            val key = deriveKey(passphrase, salt, ITERATIONS)
            val header = ByteBuffer.allocate(HEADER_LEN)
                .put(MAGIC).put(1.toByte()).put(salt).putInt(ITERATIONS).putInt(CHUNK).put(prefix)
                .put(keyCheck(key))
                .array()
            return OdcEncryption(header, key, CHUNK)
        }

        /**
         * Continues a partially uploaded file using the header already on the server.
         * Returns null if the header is invalid or was made with a different passphrase.
         */
        fun resume(passphrase: String, existingHeader: ByteArray): OdcEncryption? {
            if (existingHeader.size < HEADER_LEN) return null
            if (!existingHeader.copyOfRange(0, 8).contentEquals(MAGIC)) return null
            val buf = ByteBuffer.wrap(existingHeader)
            buf.position(9)
            val salt = ByteArray(16).also { buf.get(it) }
            val iterations = buf.int
            val chunk = buf.int
            if (iterations !in 10_000..5_000_000 || chunk !in 4096..(64 * 1024 * 1024)) return null
            val key = deriveKey(passphrase, salt, iterations)
            val check = existingHeader.copyOfRange(37, 53)
            if (!check.contentEquals(keyCheck(key))) return null
            return OdcEncryption(existingHeader.copyOf(HEADER_LEN), key, chunk)
        }

        /** Encrypts a whole file. Writes to [dst]; the caller replaces the original afterwards. */
        fun encryptFile(src: File, dst: File, passphrase: String, onProgress: (Float) -> Unit = {}) {
            val e = create(passphrase)
            val plainSize = src.length()
            val chunks = maxOf(1L, (plainSize + e.chunkSize - 1) / e.chunkSize)
            src.inputStream().buffered(e.chunkSize).use { input ->
                dst.outputStream().buffered(e.encryptedChunkSize).use { out ->
                    out.write(e.header)
                    val buf = ByteArray(e.chunkSize)
                    for (i in 0 until chunks) {
                        val want = minOf(e.chunkSize.toLong(), plainSize - i * e.chunkSize).toInt()
                        readFully(input, buf, want)
                        out.write(e.encryptChunk(i, buf, want, isFinal = i == chunks - 1))
                        onProgress((i + 1).toFloat() / chunks)
                    }
                }
            }
            if (dst.length() != e.encryptedSize(plainSize)) {
                dst.delete()
                throw IllegalStateException("Encrypted file has the wrong size")
            }
        }

        /** True if [passphrase] opens this .odcenc file (checks the header only; fast). */
        fun checkPassphrase(file: File, passphrase: String): Boolean = try {
            val header = ByteArray(HEADER_LEN)
            file.inputStream().use { readFully(it, header, HEADER_LEN) }
            resume(passphrase, header) != null
        } catch (e: Exception) {
            false
        }

        /** Decrypts a whole .odcenc file to [dst]. Throws if the passphrase is wrong or the file is damaged. */
        fun decryptFile(src: File, dst: File, passphrase: String, onProgress: (Float) -> Unit = {}) {
            val total = src.length()
            src.inputStream().buffered(CHUNK + OVERHEAD).use { input ->
                val header = ByteArray(HEADER_LEN)
                readFully(input, header, HEADER_LEN)
                val e = resume(passphrase, header) ?: throw WrongPassphraseException()
                var remaining = total - HEADER_LEN
                val buf = ByteArray(e.encryptedChunkSize)
                var index = 0L
                dst.outputStream().buffered(e.chunkSize).use { out ->
                    while (true) {
                        val len = minOf(remaining, e.encryptedChunkSize.toLong()).toInt()
                        if (len < OVERHEAD) throw IllegalStateException("File is incomplete")
                        readFully(input, buf, len)
                        remaining -= len
                        val final = remaining == 0L
                        out.write(e.decryptChunk(index, buf, len, final))
                        index++
                        onProgress(1f - remaining.toFloat() / total)
                        if (final) break
                    }
                }
            }
        }

        private fun readFully(input: java.io.InputStream, buf: ByteArray, len: Int) {
            var read = 0
            while (read < len) {
                val n = input.read(buf, read, len - read)
                if (n < 0) throw java.io.EOFException("Unexpected end of file")
                read += n
            }
        }

        private fun deriveKey(passphrase: String, salt: ByteArray, iterations: Int): SecretKeySpec {
            val spec = PBEKeySpec(passphrase.toCharArray(), salt, iterations, 256)
            val bytes = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            return SecretKeySpec(bytes, "AES")
        }

        private fun keyCheck(key: SecretKeySpec): ByteArray {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(key.encoded, "HmacSHA256"))
            return mac.doFinal("ODC key check".toByteArray(Charsets.US_ASCII)).copyOf(16)
        }
    }
}

class WrongPassphraseException : Exception("Wrong passphrase")
