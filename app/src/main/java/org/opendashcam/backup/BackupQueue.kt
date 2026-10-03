package org.opendashcam.backup

import android.content.Context
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.BackupWhat
import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.Clip
import org.opendashcam.storage.ClipStorage

/**
 * Decides what to upload next: impact clips first, then other locked clips, then the newest footage.
 * Clips still being recorded are never touched.
 */
object BackupQueue {
    fun smbOn(settings: OdcSettings) = settings.smbEnabled && settings.smbConfig.isComplete
    fun serverOn(settings: OdcSettings) = settings.serverUploadEnabled && settings.serverPaired

    fun pending(context: Context, settings: OdcSettings): List<Clip> {
        val targetId = settings.smbConfig.targetId
        val serverKey = settings.serverKey
        val smb = smbOn(settings)
        val server = serverOn(settings)
        val active = RecordingService.state.value.activeFiles
        val now = System.currentTimeMillis()
        return ClipStorage(context, settings).allClips()
            .asSequence()
            .filter { it.file.absolutePath !in active }
            .filter { now - it.file.lastModified() > 10_000 && it.sizeBytes > 0 }
            .filter { settings.backupWhat == BackupWhat.ALL || it.locked }
            .filter {
                (smb && !BackupState.isBackedUp(it.file, targetId)) ||
                    (server && !BackupState.isOnServer(it.file, serverKey))
            }
            .sortedWith(
                compareByDescending<Clip> { it.impact }
                    .thenByDescending { it.locked }
                    .thenByDescending { it.startTime }
            )
            .toList()
    }
}
