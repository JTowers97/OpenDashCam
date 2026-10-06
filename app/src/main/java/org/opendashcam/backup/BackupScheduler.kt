package org.opendashcam.backup

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.opendashcam.settings.OdcSettings
import java.util.concurrent.TimeUnit

object BackupScheduler {
    private const val UNIQUE = "odc-backup"
    private const val PERIODIC = "odc-backup-periodic"

    private fun constraints(settings: OdcSettings) = Constraints.Builder()
        .setRequiredNetworkType(if (settings.backupCellular) NetworkType.CONNECTED else NetworkType.UNMETERED)
        .setRequiresCharging(settings.backupOnlyCharging)
        .build()

    /**
     * Asks for a backup run when conditions allow. A run already in progress keeps going and picks
     * up new clips itself. [replace] restarts with new constraints after settings change.
     */
    fun kick(context: Context, replace: Boolean = false) {
        val settings = OdcSettings(context)
        val wm = WorkManager.getInstance(context)
        if (!BackupQueue.smbOn(settings) && !BackupQueue.serverOn(settings)) {
            wm.cancelUniqueWork(UNIQUE)
            wm.cancelUniqueWork(PERIODIC)
            return
        }
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(constraints(settings))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
            .build()
        wm.enqueueUniqueWork(UNIQUE, if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, request)

        // Safety net in case a trigger is missed.
        val periodic = PeriodicWorkRequestBuilder<BackupWorker>(1, TimeUnit.HOURS)
            .setConstraints(constraints(settings))
            .build()
        wm.enqueueUniquePeriodicWork(
            PERIODIC,
            if (replace) ExistingPeriodicWorkPolicy.UPDATE else ExistingPeriodicWorkPolicy.KEEP,
            periodic,
        )
    }

    /**
     * Impact and locked clips over mobile data: runs on any connection (the worker then uploads only locked clips
     * while on mobile data). Used right after an impact, and again once the clip that was recording has finished.
     */
    fun kickEvents(context: Context, delaySeconds: Long = 0) {
        val settings = OdcSettings(context)
        if (!settings.backupEventsOnMobile || (!BackupQueue.smbOn(settings) && !BackupQueue.serverOn(settings))) return
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork("$UNIQUE-events-$delaySeconds", ExistingWorkPolicy.REPLACE, request)
    }

    /** Continues after a run hit its time limit with clips still waiting. */
    fun continueLater(context: Context) {
        val settings = OdcSettings(context)
        val request = OneTimeWorkRequestBuilder<BackupWorker>()
            .setConstraints(constraints(settings))
            .setInitialDelay(5, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }
}
