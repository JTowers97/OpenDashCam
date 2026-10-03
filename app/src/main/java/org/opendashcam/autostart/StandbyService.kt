package org.opendashcam.autostart

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.opendashcam.recording.Notifier

/**
 * A lightweight service (no camera, no GPS) that waits for charging to begin and then opens ODC
 * to start recording. Android no longer delivers "charger connected" to closed apps, so something
 * has to stay running to hear it. It reacts only to the moment charging starts, never to a phone
 * that is already charging.
 */
class StandbyService : Service() {

    companion object {
        fun start(context: Context) {
            try {
                ContextCompat.startForegroundService(context, Intent(context, StandbyService::class.java))
            } catch (_: Exception) {
                // Android may refuse from the background; it'll be retried when ODC is next opened.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StandbyService::class.java))
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private var registered = false

    private val check = Runnable {
        val i = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        if (plugged != 0) AutoStart.launchRecording(this, "charging")
    }

    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            handler.removeCallbacks(check)
            handler.postDelayed(check, 3_000) // confirm it's real charging, not a flicker
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try {
            ServiceCompat.startForeground(this, Notifier.STANDBY_ID, Notifier.standby(this), type)
        } catch (_: Exception) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!registered) {
            registered = true
            ContextCompat.registerReceiver(
                this, powerReceiver, IntentFilter(Intent.ACTION_POWER_CONNECTED), ContextCompat.RECEIVER_NOT_EXPORTED
            )
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(check)
        if (registered) try { unregisterReceiver(powerReceiver) } catch (_: Exception) {}
        super.onDestroy()
    }
}
