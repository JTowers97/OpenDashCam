package org.opendashcam.storage

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.opendashcam.backup.BackupStatus
import org.opendashcam.backup.OdcEncryption
import org.opendashcam.recording.RecordingService
import java.io.File

/**
 * Encrypts clips on the phone when the user asks, using the same .odcenc format as encrypted uploads
 * (so tools/odc_decrypt.py opens both). The GPS track and subtitles are encrypted too, since they
 * reveal where you've been. Encrypted output is written to a temp file and size-checked before the
 * original is deleted, so an interruption never loses footage.
 */
object ClipCrypto {
    data class Job(
        val running: Boolean = false,
        val verb: String = "",
        val done: Int = 0,
        val total: Int = 0,
        val progress: Float = 0f,
        val error: String? = null,
    )

    private val _job = MutableStateFlow(Job())
    val job: StateFlow<Job> = _job.asStateFlow()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()

    /** Encrypts the given clips in the background (skipping ones already encrypted or in use). */
    fun encrypt(clips: List<Clip>, passphrase: String) {
        scope.launch {
            lock.withLock {
                val todo = clips.filter { !it.encrypted && it.file.exists() && !inUse(it) }
                _job.value = Job(running = true, verb = "Encrypting", total = todo.size)
                var failed = 0
                todo.forEachIndexed { i, clip ->
                    try {
                        encryptClip(clip, passphrase) { p -> _job.value = _job.value.copy(progress = p) }
                    } catch (e: Exception) {
                        failed++
                    }
                    _job.value = _job.value.copy(done = i + 1, progress = 0f)
                }
                _job.value = Job(error = if (failed > 0) "$failed clips couldn't be encrypted." else null)
            }
        }
    }

    /** Turns encrypted clips back into normal video files. */
    fun decryptInPlace(clips: List<Clip>, passphrase: String) {
        scope.launch {
            lock.withLock {
                val todo = clips.filter { it.encrypted && it.file.exists() }
                _job.value = Job(running = true, verb = "Decrypting", total = todo.size)
                var failed = 0
                todo.forEachIndexed { i, clip ->
                    try {
                        decryptClip(clip, passphrase) { p -> _job.value = _job.value.copy(progress = p) }
                    } catch (e: Exception) {
                        failed++
                    }
                    _job.value = _job.value.copy(done = i + 1, progress = 0f)
                }
                _job.value = Job(error = if (failed > 0) "$failed clips couldn't be decrypted (wrong passphrase?)." else null)
            }
        }
    }

    /** Decrypts a clip to the app's private cache for playback. Blocking; call off the main thread. */
    fun decryptForPlayback(context: Context, clip: Clip, passphrase: String, onProgress: (Float) -> Unit): File {
        val dir = File(context.cacheDir, "playback").apply { mkdirs() }
        val out = File(dir, clip.file.nameWithoutExtension + ".mp4")
        if (out.exists() && out.lastModified() >= clip.file.lastModified()) return out
        val tmp = File(dir, out.name + ".tmp")
        OdcEncryption.decryptFile(clip.file, tmp, passphrase, onProgress)
        tmp.renameTo(out)
        return out
    }

    /** Deletes decrypted playback copies. */
    fun clearPlaybackCache(context: Context) {
        File(context.cacheDir, "playback").listFiles().orEmpty().forEach { it.delete() }
    }

    private fun inUse(clip: Clip): Boolean =
        clip.file.absolutePath in RecordingService.state.value.activeFiles ||
            BackupStatus.state.value.currentClip == clip.name

    private fun encryptClip(clip: Clip, passphrase: String, onProgress: (Float) -> Unit) {
        val src = clip.file
        val dst = File(src.parentFile, src.nameWithoutExtension + "." + ClipStorage.ENCRYPTED_EXT)
        val tmp = File(dst.path + ".tmp")
        OdcEncryption.encryptFile(src, tmp, passphrase, onProgress)
        // Sidecars that reveal location: encrypt them alongside.
        listOf("gpx", "srt").forEach { ext ->
            val sc = ClipStorage.sidecar(src, ext)
            if (sc.exists()) {
                val encSc = File(sc.path + "." + ClipStorage.ENCRYPTED_EXT)
                OdcEncryption.encryptFile(sc, encSc, passphrase)
                sc.delete()
            }
        }
        val modified = src.lastModified()
        if (!tmp.renameTo(dst)) throw IllegalStateException("Couldn't finish encrypting ${src.name}")
        dst.setLastModified(modified) // keep its place in loop recording order
        src.delete()
    }

    private fun decryptClip(clip: Clip, passphrase: String, onProgress: (Float) -> Unit) {
        val src = clip.file
        val dst = File(src.parentFile, src.nameWithoutExtension + ".mp4")
        val tmp = File(dst.path + ".tmp")
        OdcEncryption.decryptFile(src, tmp, passphrase, onProgress)
        listOf("gpx", "srt").forEach { ext ->
            val encSc = ClipStorage.sidecar(src, "$ext.${ClipStorage.ENCRYPTED_EXT}")
            if (encSc.exists()) {
                OdcEncryption.decryptFile(encSc, ClipStorage.sidecar(src, ext), passphrase)
                encSc.delete()
            }
        }
        val modified = src.lastModified()
        if (!tmp.renameTo(dst)) throw IllegalStateException("Couldn't finish decrypting ${src.name}")
        dst.setLastModified(modified)
        src.delete()
    }
}
