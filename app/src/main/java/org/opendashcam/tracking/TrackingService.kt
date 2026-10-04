package org.opendashcam.tracking

import android.Manifest
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject
import org.opendashcam.backup.ServerClient
import org.opendashcam.backup.ServerReporter
import org.opendashcam.recording.Notifier
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.OdcSettings
import java.io.File
import java.text.DateFormat
import java.util.Date

/**
 * Tracking-only mode: reports the car's position and speed to the ODC Server without recording.
 *
 * Runs as a foreground service (visible notification). Started from the app, Android lets it keep using
 * location in the background; resuming after a phone restart additionally needs "Allow all the time".
 * Points are queued on the phone while offline and sent in batches, nothing is collected inside
 * privacy zones, and GPS updates stop while the car is parked (no movement) or while ODC is recording
 * (recording reports location itself).
 */
class TrackingService : Service() {

    data class State(
        val active: Boolean = false,
        val pausedForRecording: Boolean = false,
        val lastFixAt: Long = 0,
        val lastSentAt: Long = 0,
        val queued: Int = 0,
        val lastError: String? = null,
    )

    companion object {
        private const val MAX_QUEUE = 20_000
        private const val HEARTBEAT_MS = 5 * 60_000L
        private const val CHECK_MS = 15_000L

        private val _state = MutableStateFlow(State())
        val state: StateFlow<State> = _state.asStateFlow()

        fun hasLocationPermission(context: Context) =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

        fun hasBackgroundPermission(context: Context) =
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

        /** Tracking needs a paired server, the switch on, and location permission. */
        fun canRun(context: Context, settings: OdcSettings = OdcSettings(context)) =
            settings.serverPaired && settings.trackingEnabled && hasLocationPermission(context)

        fun start(context: Context) {
            if (!canRun(context)) return
            try {
                ContextCompat.startForegroundService(context, Intent(context, TrackingService::class.java))
            } catch (_: Exception) {
                // Android refuses from the background without "Allow all the time"; it starts next time ODC opens.
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, TrackingService::class.java))
        }
    }

    private lateinit var settings: OdcSettings
    private val thread = HandlerThread("odc-tracking").apply { start() }
    private val handler = Handler(thread.looper)
    private val queue = ArrayDeque<JSONObject>()
    private val queueFile by lazy { File(filesDir, "tracking-queue.json") }
    private var listening = false
    private var sending = false
    private var lastHeartbeat = 0L

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onFix(location)
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = OdcSettings(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!canRun(this, settings)) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            ServiceCompat.startForeground(
                this, Notifier.TRACKING_ID, Notifier.tracking(this, "Starting…"),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } catch (e: Exception) {
            _state.value = State(lastError = "Android didn't allow tracking to start: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        handler.post {
            loadQueue()
            _state.value = _state.value.copy(active = true, queued = queue.size, lastError = null)
            tick()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        handler.post {
            stopListening()
            saveQueue()
            _state.value = State(queued = queue.size)
            thread.quitSafely()
        }
        super.onDestroy()
    }

    // ---------------------------------------------------------------- loop

    /** Every 15 s: follow recording state, retry sending, heartbeat. */
    private fun tick() {
        val recording = RecordingService.state.value.active
        if (recording && listening) stopListening()
        if (!recording && !listening) startListening()
        _state.value = _state.value.copy(pausedForRecording = recording)
        if (queue.isNotEmpty()) flush()
        val now = System.currentTimeMillis()
        if (now - lastHeartbeat > HEARTBEAT_MS && !recording) {
            lastHeartbeat = now
            val battery = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val level = battery?.let { it.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) * 100 / it.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1) } ?: -1
            val charging = (battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0) != 0
            ServerReporter.heartbeat(this, level, charging, 0, false, "tracking", -1)
        }
        updateNotification()
        handler.postDelayed({ tick() }, CHECK_MS)
    }

    @SuppressLint("MissingPermission")
    private fun startListening() {
        if (!hasLocationPermission(this)) return
        try {
            val lm = getSystemService(LocationManager::class.java)
            // 10 m minimum distance: no updates (and almost no battery use) while the car is parked.
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, settings.trackingIntervalSec.coerceIn(2, 300) * 1000L, 10f, listener, thread.looper)
            listening = true
        } catch (e: Exception) {
            _state.value = _state.value.copy(lastError = "GPS unavailable: ${e.message}")
        }
    }

    private fun stopListening() {
        try { getSystemService(LocationManager::class.java).removeUpdates(listener) } catch (_: Exception) {}
        listening = false
    }

    private fun onFix(loc: Location) {
        org.opendashcam.recording.ClockSync.fromGps(loc)
        _state.value = _state.value.copy(lastFixAt = System.currentTimeMillis())
        val inZone = settings.privacyZones.any { z ->
            val d = FloatArray(1)
            Location.distanceBetween(loc.latitude, loc.longitude, z.lat, z.lon, d)
            d[0] <= z.radiusM
        }
        if (inZone) return
        val p = JSONObject().put("t", loc.time).put("lat", loc.latitude).put("lon", loc.longitude)
        if (loc.hasSpeed()) p.put("speed", loc.speed.toDouble())
        if (loc.hasBearing()) p.put("course", loc.bearing.toDouble())
        if (loc.hasAccuracy()) p.put("acc", loc.accuracy.toDouble())
        synchronized(queue) {
            queue.addLast(p)
            while (queue.size > MAX_QUEUE) queue.removeFirst()
        }
        flush()
    }

    /** Sends everything queued, in batches of up to 1,000 points. Keeps the queue if the server can't be reached. */
    private fun flush() {
        if (sending || queue.isEmpty() || !settings.serverPaired) return
        sending = true
        Thread {
            val client = ServerClient.forSettings(this, settings)
            var error: String? = null
            try {
                while (true) {
                    val batch = JSONArray()
                    val n = synchronized(queue) {
                        val k = minOf(1000, queue.size)
                        for (i in 0 until k) batch.put(queue[i])
                        k
                    }
                    if (n == 0) break
                    client.track(batch)
                    synchronized(queue) { repeat(n) { if (queue.isNotEmpty()) queue.removeFirst() } }
                    _state.value = _state.value.copy(lastSentAt = System.currentTimeMillis(), queued = queue.size, lastError = null)
                }
            } catch (e: Exception) {
                error = if (e is org.opendashcam.backup.ServerException && e.status == 401) {
                    "The server no longer recognizes this phone. Pair it again."
                } else {
                    "Can't reach the server; ${queue.size} points waiting."
                }
            }
            handler.post {
                sending = false
                if (error != null) {
                    saveQueue()
                    _state.value = _state.value.copy(queued = queue.size, lastError = error)
                }
                updateNotification()
            }
        }.start()
    }

    private fun updateNotification() {
        val s = _state.value
        val text = when {
            s.pausedForRecording -> "Paused while ODC is recording (recording reports location itself)."
            s.lastError != null -> s.lastError
            s.lastSentAt > 0 -> "Last sent " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(s.lastSentAt)) +
                if (s.queued > 0) " · ${s.queued} waiting" else ""
            else -> "Waiting for the car to move."
        }
        Notifier.updateTracking(this, text)
    }

    // ---------------------------------------------------------------- offline queue on disk

    private fun loadQueue() {
        try {
            if (!queueFile.exists()) return
            val arr = JSONArray(queueFile.readText())
            synchronized(queue) { for (i in 0 until arr.length()) queue.addLast(arr.getJSONObject(i)) }
        } catch (_: Exception) {
        }
    }

    private fun saveQueue() {
        try {
            val arr = JSONArray()
            synchronized(queue) { queue.forEach { arr.put(it) } }
            if (arr.length() == 0) queueFile.delete() else queueFile.writeText(arr.toString())
        } catch (_: Exception) {
        }
    }
}
