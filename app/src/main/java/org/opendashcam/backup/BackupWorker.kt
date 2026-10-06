package org.opendashcam.backup

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.opendashcam.recording.Notifier
import org.opendashcam.settings.AfterUpload
import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.Clip
import org.opendashcam.storage.ClipStorage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Uploads waiting clips to the SMB share and/or the ODC Server, one clip at a time, until the queue
 * is empty, the network rules no longer allow it, or the run's time budget is used (then it schedules
 * a continuation). If one destination fails, the other keeps going.
 *
 * SMB layout: <folder>\<phone name>\<yyyy-MM-dd>\<clip>.mp4 (+ .gpx, .srt, .sha256)
 */
class BackupWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private val running = Mutex()
        private const val RUN_BUDGET_MS = 8 * 60_000L
    }

    override suspend fun doWork(): Result {
        if (!running.tryLock()) return Result.success() // another run is already uploading
        return try {
            withContext(Dispatchers.IO) { runBackup() }
        } finally {
            running.unlock()
            BackupStatus.update { copy(running = false, currentClip = null, progress = 0f) }
        }
    }

    private fun runBackup(): Result {
        val ctx = applicationContext
        val settings = OdcSettings(ctx)
        val smbOn = BackupQueue.smbOn(settings)
        val serverOn = BackupQueue.serverOn(settings)
        if (!smbOn && !serverOn) return Result.success()

        val smbPassphrase = if (settings.encryptUploads) settings.encryptionPassphrase else null
        if (smbOn && settings.encryptUploads && smbPassphrase.isNullOrEmpty()) {
            BackupStatus.update { copy(message = "Encryption is on but no passphrase is set.", error = true) }
            return Result.success()
        }

        var queue = BackupQueue.pending(ctx, settings)
        BackupStatus.update { copy(pending = queue.size) }
        if (queue.isEmpty()) {
            BackupStatus.update { copy(message = "All clips are backed up.", error = false) }
            return Result.success()
        }

        val deadline = System.currentTimeMillis() + RUN_BUDGET_MS
        val storage = ClipStorage(ctx, settings)
        val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        var smb: SmbTarget? = null
        val server = if (serverOn) ServerClient.forSettings(ctx, settings) else null
        var smbError: String? = null
        var serverError: String? = null
        val attempted = HashSet<String>()

        try {
            while (true) {
                if (isStopped) return Result.retry()
                if (System.currentTimeMillis() > deadline) {
                    BackupScheduler.continueLater(ctx)
                    return Result.success()
                }
                val metered = isMetered(ctx)
                // On mobile data with Wi-Fi-only backups, locked and impact clips may still go (if that option is on).
                val eventsOnly = metered && !settings.backupCellular
                if (eventsOnly && !settings.backupEventsOnMobile) {
                    BackupStatus.update { copy(message = "Waiting for Wi-Fi.") }
                    return Result.retry()
                }
                if (metered && cellularCapReached(settings)) {
                    BackupStatus.update { copy(message = "Monthly cellular upload limit reached. Waiting for Wi-Fi.") }
                    return Result.success()
                }

                // Next clip that still needs a destination that's working this run.
                val clip = queue.firstOrNull { c ->
                    c.file.absolutePath !in attempted && c.file.exists() && (!eventsOnly || c.locked) &&
                        ((smbOn && smbError == null && !BackupState.isBackedUp(c.file, settings.smbConfig.targetId)) ||
                            (server != null && serverError == null && !BackupState.isOnServer(c.file, settings.serverKey)))
                } ?: run {
                    if (eventsOnly && queue.any { !it.locked && it.file.exists() }) {
                        BackupStatus.update { copy(message = "Locked and impact clips are uploaded. Other clips wait for Wi-Fi.") }
                    }
                    null
                } ?: break
                attempted += clip.file.absolutePath

                if (smbOn && smbError == null && !BackupState.isBackedUp(clip.file, settings.smbConfig.targetId)) {
                    try {
                        val target = smb ?: SmbTarget(settings.smbConfig).also {
                            BackupStatus.update { copy(running = true, message = "Connecting to ${settings.smbHost}…") }
                            it.connect()
                            smb = it
                        }
                        uploadToSmb(target, clip, day.format(Date(clip.startTime)), smbPassphrase, settings, metered)
                    } catch (e: UploadStoppedException) {
                        throw e
                    } catch (e: Exception) {
                        smbError = e.message ?: e.javaClass.simpleName
                    }
                }
                if (server != null && serverError == null && clip.file.exists() && !BackupState.isOnServer(clip.file, settings.serverKey)) {
                    try {
                        uploadToServer(server, clip, settings, metered)
                    } catch (e: UploadStoppedException) {
                        throw e
                    } catch (e: Exception) {
                        serverError = if (e is ServerException && e.status == 401) {
                            "The server no longer recognizes this phone. Pair it again in Settings."
                        } else {
                            e.message ?: e.javaClass.simpleName
                        }
                    }
                }

                val doneEverywhere = (!smbOn || BackupState.isBackedUp(clip.file, settings.smbConfig.targetId)) &&
                    (!serverOn || BackupState.isOnServer(clip.file, settings.serverKey))
                if (doneEverywhere) {
                    BackupStatus.update { copy(lastSuccessAt = System.currentTimeMillis()) }
                    if (settings.afterUpload == AfterUpload.DELETE && !clip.locked && !clip.keep) {
                        storage.deleteWithSidecars(clip.file)
                    }
                }
                queue = BackupQueue.pending(ctx, settings)
                BackupStatus.update { copy(pending = queue.size) }
            }
        } catch (e: UploadStoppedException) {
            BackupStatus.update { copy(message = "Backup paused.") }
            return Result.retry()
        } finally {
            smb?.close()
        }

        val errors = listOfNotNull(smbError?.let { "SMB: $it" }, serverError?.let { "ODC Server: $it" })
        return if (errors.isEmpty()) {
            BackupStatus.update { copy(message = "All clips are backed up.", error = false) }
            Result.success()
        } else {
            val msg = "Backup problem. ${errors.joinToString(" ")}"
            BackupStatus.update { copy(message = msg, error = true) }
            if (runAttemptCount == 3) Notifier.alert(ctx, "Backup isn't working", msg)
            Result.retry()
        }
    }

    private fun progressCallback(settings: OdcSettings, metered: Boolean, total: Long): (Long) -> Unit {
        var sent = 0L
        return { n ->
            sent += n
            if (metered) addCellularBytes(n)
            BackupStatus.update { copy(progress = (sent.toFloat() / total.coerceAtLeast(1)).coerceIn(0f, 1f)) }
        }
    }

    private fun uploadToSmb(target: SmbTarget, clip: Clip, dayFolder: String, passphrase: String?, settings: OdcSettings, metered: Boolean) {
        val dir = SmbTarget.join(target.basePath(), deviceFolder(), dayFolder)
        target.ensureDir(dir)
        // Clips encrypted on the phone are already .odcenc: upload them as they are.
        val pass = if (clip.encrypted) null else passphrase
        val suffix = if (pass != null) ".${OdcEncryption.EXTENSION}" else ""
        val remote = SmbTarget.join(dir, clip.name + suffix)

        BackupStatus.update { copy(running = true, currentClip = clip.name, progress = 0f, message = "Uploading ${clip.name} to the SMB share") }
        val sha = target.upload(
            local = clip.file,
            remotePath = remote,
            passphrase = pass,
            onBytes = progressCallback(settings, metered, clip.sizeBytes),
            shouldStop = { isStopped || (metered && cellularCapReached(settings)) },
        )
        listOf("gpx", "srt", "gpx.odcenc", "srt.odcenc").forEach { ext ->
            val sc = ClipStorage.sidecar(clip.file, ext)
            if (sc.exists()) {
                val alreadyEncrypted = ext.endsWith(OdcEncryption.EXTENSION)
                val name = if (alreadyEncrypted) sc.name else sc.name + suffix
                target.uploadSmall(sc.readBytes(), SmbTarget.join(dir, name), if (alreadyEncrypted) null else pass)
            }
        }
        target.uploadSmall("$sha  ${clip.name}\n".toByteArray(), SmbTarget.join(dir, clip.name + ".sha256"), null)
        BackupState.markSmb(clip.file, settings.smbConfig.targetId, remote, sha, clip.sizeBytes, pass != null || clip.encrypted)
    }

    /** The server stores clips as they are on the phone (sent over HTTPS) and verifies the SHA-256 itself. */
    private fun uploadToServer(server: ServerClient, clip: Clip, settings: OdcSettings, metered: Boolean) {
        BackupStatus.update { copy(running = true, currentClip = clip.name, progress = 0f, message = "Uploading ${clip.name} to the ODC Server") }
        val sha = SmbTarget.sha256(clip.file)
        val meta = JSONObject()
            .put("fileName", clip.name)
            .put("sizeBytes", clip.sizeBytes)
            .put("sha256", sha)
            .put("stream", clip.camera.lowercase())
            .put("startedAt", clip.startTime)
            .put("mode", if (clip.parking) "parking" else "driving")
            .put("locked", clip.locked)
            .put("lockReason", if (clip.impact) "impact" else if (clip.locked) "user" else JSONObject.NULL)
            .put("encrypted", clip.encrypted)
            // Whether the date/time stamp is burned in, so the server skips that corner when reading or blurring plates.
            .put("stamp", settings.overlayEnabled)
        val clipId = server.uploadClip(
            file = clip.file,
            meta = meta,
            onBytes = progressCallback(settings, metered, clip.sizeBytes),
            shouldStop = { isStopped || (metered && cellularCapReached(settings)) },
        )
        listOf("gpx", "srt").forEach { kind ->
            val plain = ClipStorage.sidecar(clip.file, kind)
            val enc = ClipStorage.sidecar(clip.file, "$kind.${OdcEncryption.EXTENSION}")
            when {
                plain.exists() -> server.sidecar(clipId, kind, plain.readBytes(), encrypted = false)
                enc.exists() -> server.sidecar(clipId, kind, enc.readBytes(), encrypted = true)
            }
        }
        BackupState.markServer(clip.file, settings.serverKey, clipId, sha)
    }

    private fun deviceFolder(): String {
        val name = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
        return name.replace(Regex("[^A-Za-z0-9 _-]"), "").replace(' ', '_').ifBlank { "phone" }
    }

    private fun isMetered(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return true
        return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    // ---- monthly cellular accounting

    private fun prefs() = applicationContext.getSharedPreferences("odc_backup_usage", Context.MODE_PRIVATE)
    private fun monthKey() = SimpleDateFormat("yyyy-MM", Locale.US).format(Date())

    private fun cellularBytesThisMonth(): Long {
        val p = prefs()
        return if (p.getString("month", null) == monthKey()) p.getLong("bytes", 0) else 0
    }

    private fun addCellularBytes(n: Long) {
        prefs().edit().putString("month", monthKey()).putLong("bytes", cellularBytesThisMonth() + n).apply()
    }

    private fun cellularCapReached(settings: OdcSettings): Boolean {
        val capMb = settings.cellularCapMb
        return capMb > 0 && cellularBytesThisMonth() >= capMb.toLong() * 1024 * 1024
    }
}
