package org.opendashcam.storage

import android.content.Context
import android.os.Environment
import org.opendashcam.settings.OdcSettings
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class Clip(val file: File, val locked: Boolean) {
    val name: String get() = file.name
    val sizeBytes: Long get() = file.length()
    val parking: Boolean get() = file.name.contains("-park")
    val camera: String get() = if (file.name.contains("_front")) "Front" else "Rear"
    val hasTrack: Boolean
        get() = ClipStorage.sidecar(file, "gpx").exists() || ClipStorage.sidecar(file, "gpx.odcenc").exists()
    /** Encrypted on this phone (.odcenc); needs the passphrase to play. */
    val encrypted: Boolean get() = file.extension == ClipStorage.ENCRYPTED_EXT
    val impact: Boolean get() = ClipStorage.sidecar(file, "impact").exists()
    val backedUp: Boolean get() = ClipStorage.sidecar(file, "backup").exists()
    /** "Keep on device": never deleted after upload. */
    val keep: Boolean get() = ClipStorage.sidecar(file, "keep").exists()

    /** Start time parsed from the file name (ODC_yyyyMMdd_HHmmss_...), falling back to last modified. */
    val startTime: Long
        get() = try {
            val stamp = file.name.removePrefix("ODC_").take(15)
            SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).parse(stamp)?.time ?: file.lastModified()
        } catch (e: Exception) {
            file.lastModified()
        }
}

data class OdcVolume(val index: Int, val dir: File, val label: String, val freeBytes: Long, val totalBytes: Long)

data class LoopResult(
    val deleted: Int,
    val unlockedBytes: Long,
    val lockedBytes: Long,
    val capBytes: Long,
    val freeBytes: Long,
) {
    val totalBytes get() = unlockedBytes + lockedBytes
    val nearCap get() = totalBytes >= capBytes * 0.9
    val lockedNearCap get() = lockedBytes >= capBytes * 0.9
}

/**
 * Footage lives in ODC's app folder on the chosen volume:
 *   <volume>/Android/data/org.opendashcam/files/Movies/ODC/clips   (loop-deletable)
 *   <volume>/Android/data/org.opendashcam/files/Movies/ODC/locked  (never auto-deleted)
 */
class ClipStorage(private val context: Context, private val settings: OdcSettings) {

    fun volumes(): List<OdcVolume> =
        context.getExternalFilesDirs(Environment.DIRECTORY_MOVIES).toList().mapIndexedNotNull { i, dir ->
            dir?.let {
                OdcVolume(
                    index = i,
                    dir = it,
                    label = if (i == 0) "Internal storage" else "External drive $i",
                    freeBytes = it.usableSpace,
                    totalBytes = it.totalSpace,
                )
            }
        }

    val root: File
        get() {
            val v = volumes()
            val dir = (v.getOrNull(settings.storageVolumeIndex) ?: v.first()).dir
            return File(dir, "ODC")
        }

    private val clipsDir: File get() = File(root, "clips").apply { mkdirs() }
    private val lockedDir: File get() = File(root, "locked").apply { mkdirs() }

    @Synchronized
    fun newSegmentFile(label: String, time: Long = System.currentTimeMillis()): File {
        val base = "ODC_${STAMP.format(Date(time))}_$label"
        var f = File(clipsDir, "$base.mp4")
        var n = 1
        while (f.exists()) {
            f = File(clipsDir, "${base}_$n.mp4")
            n++
        }
        return f
    }

    /** Renames a segment so its name reflects when recording into it actually began. */
    fun renameToNow(file: File, label: String): File {
        val target = newSegmentFile(label)
        return if (file.renameTo(target)) target else file
    }

    fun allClips(): List<Clip> {
        val unlocked = clipsDir.listFiles { f -> isClipFile(f) }.orEmpty().map { Clip(it, false) }
        val locked = lockedDir.listFiles { f -> isClipFile(f) }.orEmpty().map { Clip(it, true) }
        return (unlocked + locked).sortedByDescending { it.startTime }
    }

    fun lock(clip: Clip): Boolean = moveWithSidecars(clip.file, lockedDir)
    fun unlock(clip: Clip): Boolean = moveWithSidecars(clip.file, clipsDir)
    fun delete(clip: Clip): Boolean = deleteWithSidecars(clip.file)

    /** Locks a finished segment by path. With impact = true it is also tagged as an impact clip. */
    fun lockFile(file: File, impact: Boolean): Boolean {
        if (!file.exists()) return false
        if (impact) try { sidecar(file, "impact").createNewFile() } catch (_: Exception) {}
        if (file.parentFile == lockedDir) return true
        return moveWithSidecars(file, lockedDir)
    }

    fun setKeep(clip: Clip, keep: Boolean) {
        val marker = sidecar(clip.file, "keep")
        if (keep) try { marker.createNewFile() } catch (_: Exception) {} else marker.delete()
    }

    fun deleteWithSidecars(file: File): Boolean {
        SIDECARS.forEach { sidecar(file, it).delete() }
        return file.delete()
    }

    private fun moveWithSidecars(file: File, dir: File): Boolean {
        val ok = file.renameTo(File(dir, file.name))
        if (ok) SIDECARS.forEach { ext ->
            val sc = sidecar(file, ext)
            if (sc.exists()) sc.renameTo(File(dir, sc.name))
        }
        return ok
    }

    /** Removes half-written encryption output left by an interrupted encrypt/decrypt. */
    fun cleanupTemp() {
        listOf(clipsDir, lockedDir).forEach { dir ->
            dir.listFiles { f -> f.name.endsWith(".tmp") }.orEmpty().forEach { it.delete() }
        }
    }

        /** Removes zero-byte leftovers from interrupted sessions. */
    fun cleanupEmpty(active: Set<String>) {
        clipsDir.listFiles { f -> f.extension == "mp4" }.orEmpty()
            .filter { it.length() == 0L && it.absolutePath !in active }
            .forEach { deleteWithSidecars(it) }
    }

    /**
     * Loop recording: delete the oldest unlocked segments until footage fits under the cap
     * and at least MIN_FREE_BYTES stays free. Files currently being written are never touched.
     */
    @Synchronized
    fun enforceLoop(active: Set<String>): LoopResult {
        val unlocked = clipsDir.listFiles { f -> isClipFile(f) }.orEmpty().sortedBy { it.lastModified() }
        val lockedBytes = lockedDir.listFiles().orEmpty().sumOf { it.length() }
        var unlockedBytes = unlocked.sumOf { it.length() }
        var free = root.usableSpace

        val cap = if (settings.storageCapGb > 0) {
            settings.storageCapGb.toLong() * 1024 * 1024 * 1024
        } else {
            ((free + unlockedBytes + lockedBytes) * 0.8).toLong()
        }

        var deleted = 0
        for (f in unlocked) {
            if (unlockedBytes + lockedBytes <= cap && free >= MIN_FREE_BYTES) break
            if (f.absolutePath in active) continue
            val len = f.length()
            if (deleteWithSidecars(f)) {
                unlockedBytes -= len
                free += len
                deleted++
            }
        }
        return LoopResult(deleted, unlockedBytes, lockedBytes, cap, free)
    }

    companion object {
        /** Files that travel with a clip: GPS track, subtitle overlay, impact marker. */
        val SIDECARS = listOf("gpx", "srt", "gpx.odcenc", "srt.odcenc", "impact", "backup", "keep")
        const val ENCRYPTED_EXT = "odcenc"

        fun isClipFile(f: File) = f.extension == "mp4" || f.extension == ENCRYPTED_EXT
        fun sidecar(video: File, ext: String) = File(video.parentFile, video.nameWithoutExtension + "." + ext)

        const val MIN_FREE_BYTES = 500L * 1024 * 1024
        private val STAMP = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US)

        fun formatBytes(bytes: Long): String {
            val gb = bytes / (1024.0 * 1024 * 1024)
            return if (gb >= 1) String.format(Locale.US, "%.1f GB", gb)
            else String.format(Locale.US, "%.0f MB", bytes / (1024.0 * 1024))
        }
    }
}
