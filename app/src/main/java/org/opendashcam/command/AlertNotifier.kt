package org.opendashcam.command

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import org.opendashcam.R
import org.opendashcam.settings.OdcSettings
import org.opendashcam.ui.MainActivity

/** Shows Command Center alerts, with the photo when there is one. Tapping opens the alert (and from there its clip). */
object AlertNotifier {
    const val CHANNEL_ALERTS = "cc_alerts"
    const val CHANNEL_CONNECTION = "cc_connection"
    const val EXTRA_EVENT_ID = "org.opendashcam.extra.EVENT_ID"
    const val EXTRA_NOTIFICATION_ID = "org.opendashcam.extra.NOTIFICATION_ID"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Command Center alerts", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Impacts, arrivals, speeding and other alerts from your ODC Server"
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_CONNECTION, "Command Center connection", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Shown while the app stays connected to your ODC Server for alerts"
        })
    }

    /** n: a notification from the server (inbox or push copy). Call off the main thread (it may download the photo). */
    fun show(context: Context, n: JSONObject) {
        val settings = OdcSettings(context)
        val id = n.optLong("id")
        synchronized(this) {
            if (id != 0L && id <= settings.ccLastShownId) return // already shown via the other route
            if (id != 0L) settings.ccLastShownId = id
        }
        val eventId = if (n.isNull("eventId")) 0L else n.optLong("eventId")
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_EVENT_ID, eventId)
            .putExtra(EXTRA_NOTIFICATION_ID, id)
        val pi = PendingIntent.getActivity(context, id.toInt(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val builder = NotificationCompat.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle(n.optString("title"))
            .setContentText(n.optString("body"))
            .setStyle(NotificationCompat.BigTextStyle().bigText(n.optString("body")))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_EVENT)
            .setPriority(if (n.optString("kind") == "impact") NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
        val imageUrl = n.optString("imageUrl").ifBlank { n.optString("image") }.takeIf { it.isNotBlank() && it != "null" }
        if (imageUrl != null) {
            try {
                val bytes = CommandCenter.client(settings).bytes(imageUrl)
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { bmp ->
                    builder.setLargeIcon(bmp).setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).setSummaryText(n.optString("body")))
                }
            } catch (_: Exception) {
                // No photo: the text alert still goes out.
            }
        }
        try {
            context.getSystemService(NotificationManager::class.java).notify("cc", id.toInt(), builder.build())
        } catch (_: SecurityException) {
            // Notifications not allowed.
        }
    }
}
