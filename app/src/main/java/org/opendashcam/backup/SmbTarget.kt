package org.opendashcam.backup

import com.hierynomus.msdtyp.AccessMask
import com.hierynomus.msfscc.FileAttributes
import com.hierynomus.mssmb2.SMB2CreateDisposition
import com.hierynomus.mssmb2.SMB2CreateOptions
import com.hierynomus.mssmb2.SMB2ShareAccess
import com.hierynomus.smbj.SMBClient
import com.hierynomus.smbj.auth.AuthenticationContext
import com.hierynomus.smbj.connection.Connection
import com.hierynomus.smbj.session.Session
import com.hierynomus.smbj.share.DiskShare
import org.opendashcam.settings.SmbConfig
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.EnumSet
import java.util.concurrent.TimeUnit
import com.hierynomus.smbj.SmbConfig as SmbjConfig
import com.hierynomus.smbj.share.File as SmbFile

class UploadStoppedException : Exception("Upload paused")

/** One connection to an SMB share. Not thread-safe; use from a single worker. */
class SmbTarget(private val config: SmbConfig) : Closeable {

    private val client = SMBClient(
        SmbjConfig.builder()
            .withTimeout(60, TimeUnit.SECONDS)
            .withSoTimeout(90, TimeUnit.SECONDS)
            .build()
    )
    private var connection: Connection? = null
    private var session: Session? = null
    private var share: DiskShare? = null

    fun connect() {
        val (host, port) = parseHost(config.host)
        val conn = if (port != null) client.connect(host, port) else client.connect(host)
        connection = conn
        val auth = if (config.username.isBlank()) {
            AuthenticationContext.anonymous()
        } else {
            AuthenticationContext(config.username, config.password.toCharArray(), config.domain.ifBlank { null })
        }
        val s = conn.authenticate(auth)
        session = s
        share = s.connectShare(config.share) as? DiskShare
            ?: throw IllegalStateException("\"${config.share}\" is not a file share")
    }

    /**
     * Whether traffic is encrypted (SMB 3 encryption, required by the session or the share), or null if it
     * can't be determined. Looked up by name so it works across library versions.
     */
    fun encrypted(): Boolean? {
        fun flag(obj: Any?, vararg path: String): Boolean? = try {
            var o: Any? = obj
            for (m in path) o = o?.javaClass?.getMethod(m)?.invoke(o)
            o as? Boolean
        } catch (_: Exception) {
            null
        }
        val sessionFlag = flag(session, "getSessionContext", "isEncryptData")
        val shareFlag = flag(share, "getTreeConnect", "isEncryptData")
        return when {
            sessionFlag == true || shareFlag == true -> true
            sessionFlag == null && shareFlag == null -> null
            else -> false
        }
    }

    /** Connects, creates the folder, writes and deletes a small test file. Returns whether traffic is encrypted. */
    fun test(): Boolean? {
        connect()
        val dir = basePath()
        ensureDir(dir)
        val path = join(dir, ".odc-write-test")
        openFile(path, SMB2CreateDisposition.FILE_OVERWRITE_IF).use { f ->
            val bytes = "Open Dash Cam write test".toByteArray()
            f.write(bytes, 0, 0, bytes.size)
        }
        share!!.rm(path)
        return encrypted()
    }

    fun basePath(): String = config.path.trim('/', ' ').replace('/', '\\')

    fun ensureDir(path: String) {
        val s = share!!
        var current = ""
        path.split('\\', '/').filter { it.isNotBlank() }.forEach { part ->
            current = if (current.isEmpty()) part else "$current\\$part"
            if (!s.folderExists(current)) s.mkdir(current)
        }
    }

    fun remoteSize(path: String): Long? {
        val s = share!!
        return if (s.fileExists(path)) s.getFileInformation(path).standardInformation.endOfFile else null
    }

    /**
     * Uploads [local] to [remotePath], resuming a previous partial upload if one exists.
     * Writes to "<name>.part" and renames it only once the full size has been written.
     * With [passphrase], the file is encrypted in the .odcenc format on the way.
     *
     * @return the SHA-256 of the local (plaintext) file.
     */
    fun upload(
        local: File,
        remotePath: String,
        passphrase: String?,
        onBytes: (Long) -> Unit,
        shouldStop: () -> Boolean,
    ): String {
        val sha256 = sha256(local)
        val partPath = "$remotePath.part"
        val plainSize = local.length()

        if (passphrase == null) {
            if (remoteSize(remotePath) == plainSize) return sha256 // already there
            var offset = remoteSize(partPath) ?: 0L
            if (offset > plainSize) offset = 0L
            openFile(partPath, SMB2CreateDisposition.FILE_OPEN_IF).use { f ->
                if (offset == 0L) f.setLength(0)
                RandomAccessFile(local, "r").use { raf ->
                    raf.seek(offset)
                    val buf = ByteArray(CHUNK)
                    while (offset < plainSize) {
                        if (shouldStop()) throw UploadStoppedException()
                        val n = raf.read(buf)
                        if (n <= 0) break
                        f.write(buf, offset, 0, n)
                        offset += n
                        onBytes(n.toLong())
                    }
                }
            }
            finish(partPath, remotePath, plainSize)
            return sha256
        }

        // Encrypted upload, resumable at chunk boundaries.
        var enc: OdcEncryption? = null
        var startChunk = 0L
        val existing = remoteSize(partPath) ?: 0L
        if (existing >= OdcEncryption.HEADER_LEN) {
            val header = ByteArray(OdcEncryption.HEADER_LEN)
            openFile(partPath, SMB2CreateDisposition.FILE_OPEN).use { f -> f.read(header, 0) }
            enc = OdcEncryption.resume(passphrase, header)
            if (enc != null) startChunk = (existing - OdcEncryption.HEADER_LEN) / enc.encryptedChunkSize
        }
        val e = enc ?: OdcEncryption.create(passphrase)
        if (enc == null) startChunk = 0L
        val expected = e.encryptedSize(plainSize)
        if (remoteSize(remotePath) == expected) return sha256

        openFile(partPath, SMB2CreateDisposition.FILE_OPEN_IF).use { f ->
            if (startChunk == 0L) {
                f.setLength(0)
                f.write(e.header, 0, 0, e.header.size)
            }
            val chunks = maxOf(1L, (plainSize + e.chunkSize - 1) / e.chunkSize)
            RandomAccessFile(local, "r").use { raf ->
                val buf = ByteArray(e.chunkSize)
                for (i in startChunk until chunks) {
                    if (shouldStop()) throw UploadStoppedException()
                    raf.seek(i * e.chunkSize)
                    val want = minOf(e.chunkSize.toLong(), plainSize - i * e.chunkSize).toInt()
                    raf.readFully(buf, 0, want)
                    val out = e.encryptChunk(i, buf, want, isFinal = i == chunks - 1)
                    f.write(out, OdcEncryption.HEADER_LEN + i * e.encryptedChunkSize, 0, out.size)
                    onBytes(out.size.toLong())
                }
            }
            f.setLength(expected)
        }
        finish(partPath, remotePath, expected)
        return sha256
    }

    /** Small files (GPX, subtitles, checksums): plain overwrite. Encrypted when a passphrase is given. */
    fun uploadSmall(bytes: ByteArray, remotePath: String, passphrase: String?) {
        val data = if (passphrase == null) bytes else {
            val e = OdcEncryption.create(passphrase)
            e.header + e.encryptChunk(0, bytes, bytes.size, isFinal = true)
        }
        openFile(remotePath, SMB2CreateDisposition.FILE_OVERWRITE_IF).use { f ->
            f.write(data, 0, 0, data.size)
        }
    }

    private fun finish(partPath: String, finalPath: String, expectedSize: Long) {
        val written = remoteSize(partPath)
        if (written != expectedSize) {
            throw IllegalStateException("Upload verification failed: server has $written bytes, expected $expectedSize")
        }
        openFile(partPath, SMB2CreateDisposition.FILE_OPEN).use { f -> f.rename(finalPath, true) }
    }

    private fun openFile(path: String, disposition: SMB2CreateDisposition): SmbFile =
        share!!.openFile(
            path,
            EnumSet.of(AccessMask.GENERIC_READ, AccessMask.GENERIC_WRITE, AccessMask.DELETE),
            EnumSet.of(FileAttributes.FILE_ATTRIBUTE_NORMAL),
            SMB2ShareAccess.ALL,
            disposition,
            EnumSet.noneOf(SMB2CreateOptions::class.java),
        )

    override fun close() {
        try { share?.close() } catch (_: Exception) {}
        try { session?.close() } catch (_: Exception) {}
        try { connection?.close() } catch (_: Exception) {}
        try { client.close() } catch (_: Exception) {}
    }

    companion object {
        private const val CHUNK = 1024 * 1024

        fun join(vararg parts: String): String =
            parts.map { it.trim('\\', '/') }.filter { it.isNotEmpty() }.joinToString("\\")

        private fun parseHost(raw: String): Pair<String, Int?> {
            val h = raw.trim().removePrefix("smb://").removePrefix("\\\\").substringBefore('/')
            val idx = h.lastIndexOf(':')
            return if (idx > 0 && h.count { it == ':' } == 1) {
                h.substring(0, idx) to h.substring(idx + 1).toIntOrNull()
            } else {
                h to null
            }
        }

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buf = ByteArray(1024 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n <= 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
