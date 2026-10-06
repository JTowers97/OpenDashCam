package org.opendashcam.command

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.opendashcam.R
import org.opendashcam.backup.ServerException
import org.opendashcam.settings.OdcSettings

/**
 * Command Center's direct connection: keeps one request open to your ODC Server ("anything new?"), so alerts arrive
 * instantly without any other app. Shown with a quiet notification while it runs. (UnifiedPush is the alternative that
 * uses less battery, through a distributor app such as ntfy.)
 */
class AlertConnectionService : Service() {
    companion object {
        private const val NOTIFICATION_ID = 7
        fun start(context: Context) {
            if (!OdcSettings(context).ccSignedIn) return
            try { ContextCompat.startForegroundService(context, Intent(context, AlertConnectionService::class.java)) } catch (_: Exception) {}
        }
        fun stop(context: Context) { context.stopService(Intent(context, AlertConnectionService::class.java)) }
    }

    @Volatile private var running = false
    private var thread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val settings = OdcSettings(this)
        if (!settings.ccSignedIn || settings.ccDelivery != "direct") { stopSelf(); return START_NOT_STICKY }
        val n = NotificationCompat.Builder(this, AlertNotifier.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle("Connected for alerts")
            .setContentText("Command Center is listening for alerts from your ODC Server.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build()
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, n,
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        } catch (_: Exception) { stopSelf(); return START_NOT_STICKY }
        if (!running) {
            running = true
            thread = Thread({ loop() }, "odc-alerts").apply { isDaemon = true; start() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        thread?.interrupt()
        super.onDestroy()
    }

    private fun loop() {
        var backoff = 2_000L
        while (running) {
            val settings = OdcSettings(this)
            try {
                val r = CommandCenter.client(settings).call("GET", "/api/me/notifications/wait?after=${settings.ccLastShownId}")
                val list = r.getJSONArray("notifications")
                for (i in 0 until list.length()) AlertNotifier.show(this, list.getJSONObject(i))
                backoff = 2_000L
            } catch (e: InterruptedException) {
                return
            } catch (e: ServerException) {
                if (e.status == 401) { running = false; stopSelf(); return } // signed out on the server
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
                backoff = minOf(60_000L, backoff * 2)
            } catch (e: Exception) {
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
                backoff = minOf(60_000L, backoff * 2)
            }
        }
    }
}
