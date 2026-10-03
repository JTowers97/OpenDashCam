package org.opendashcam.recording

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.opendashcam.R
import org.opendashcam.ui.MainActivity
import java.util.concurrent.atomic.AtomicInteger

object Notifier {
    const val CHANNEL_RECORDING = "recording"
    const val CHANNEL_ALERTS = "alerts"
    const val CHANNEL_STANDBY = "standby"
    const val STANDBY_ID = 2
    const val AUTOSTART_PROMPT_ID = 3
    const val RECORDING_ID = 1
    private val alertIds = AtomicInteger(100)

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_RECORDING, "Recording status", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while Open Dash Cam is recording"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Storage, battery, temperature and impact alerts"
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_STANDBY, "Waiting to auto-start", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while ODC waits for charging to start recording"
            }
        )
    }

    fun standby(context: Context): Notification {
        val open = PendingIntent.getActivity(
            context, 4,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_STANDBY)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle("Open Dash Cam is ready")
            .setContentText("Recording starts when the phone begins charging.")
            .setOngoing(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
    }

    /** Fallback when Android won't let ODC open itself: a notification the user taps to start. */
    fun autoStartPrompt(context: Context, launch: Intent) {
        val pi = PendingIntent.getActivity(
            context, 5, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle("Tap to start recording")
            .setContentText("Your car is connected. Allow \"Display over other apps\" in ODC settings to start automatically.")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(AUTOSTART_PROMPT_ID, n)
        } catch (_: SecurityException) {
        }
    }

    fun recording(context: Context, title: String, text: String): Notification {
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val stop = PendingIntent.getService(
            context, 1, RecordingService.stopIntent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_RECORDING)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(0, "Stop recording", stop)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun updateRecording(context: Context, title: String, text: String) {
        try {
            context.getSystemService(NotificationManager::class.java)
                .notify(RECORDING_ID, recording(context, title, text))
        } catch (_: SecurityException) {
        }
    }

    fun alert(context: Context, title: String, text: String) {
        val open = PendingIntent.getActivity(
            context, 2,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        try {
            context.getSystemService(NotificationManager::class.java).notify(alertIds.incrementAndGet(), n)
        } catch (_: SecurityException) {
        }
    }
}
