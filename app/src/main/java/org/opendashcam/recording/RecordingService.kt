package org.opendashcam.recording

import android.Manifest
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.BatteryManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.opendashcam.autostart.StandbyService
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.backup.ServerReporter
import org.opendashcam.camera.CameraCapabilities
import org.opendashcam.location.LocationTracker
import org.opendashcam.location.TrackWriter
import org.opendashcam.sensors.ImpactDetector
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.PrivacyZone
import org.opendashcam.storage.Clip
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Foreground service that owns the cameras while recording.
 *
 * Threading: every decision runs on the single-threaded [control] executor, so state needs no locks.
 * Broadcast receivers, sensors and recorder callbacks only enqueue work onto it.
 */
class RecordingService : Service(), CameraStreamRecorder.Listener {

    enum class Status(val label: String) {
        IDLE("Not recording"),
        STARTING("Starting…"),
        RECORDING("Recording"),
        PAUSED_BATTERY("Paused: low battery"),
        PAUSED_THERMAL("Paused: phone too hot"),
        PAUSED_PRIVACY("Paused: privacy zone"),
        ERROR("Stopped after an error"),
    }

    enum class Mode(val label: String) { DRIVING("Driving"), PARKING("Parking mode") }

    data class State(
        val status: Status = Status.IDLE,
        val mode: Mode = Mode.DRIVING,
        val streams: List<String> = emptyList(),
        val notes: List<String> = emptyList(),
        val message: String? = null,
        val batteryPct: Int = -1,
        val charging: Boolean = false,
        val thermalStatus: Int = 0,
        val segments: Int = 0,
        val startedAt: Long = 0,
        val activeFiles: Set<String> = emptySet(),
        val gpsOn: Boolean = false,
        val speed: String? = null,
        val privacyZone: String? = null,
        val motionEvents: Int = 0,
        val impacts: Int = 0,
    ) {
        val active get() = status != Status.IDLE && status != Status.ERROR
    }

    companion object {
        private const val ACTION_START = "org.opendashcam.action.START"
        private const val ACTION_STOP = "org.opendashcam.action.STOP"
        private const val POWER_DEBOUNCE_MS = 5_000L
        private const val MAX_FALLBACK = 5
        private const val MAX_RETRIES = 3
        private const val GPS_DRIVING_MS = 1_000L
        private const val GPS_PARKING_MS = 30_000L

        private val _state = MutableStateFlow(State())
        val state: StateFlow<State> = _state.asStateFlow()

        fun start(context: Context) {
            ContextCompat.startForegroundService(
                context, Intent(context, RecordingService::class.java).setAction(ACTION_START)
            )
        }

        fun stop(context: Context) {
            context.startService(stopIntent(context))
        }

        fun stopIntent(context: Context): Intent =
            Intent(context, RecordingService::class.java).setAction(ACTION_STOP)
    }

    private lateinit var settings: OdcSettings
    private lateinit var storage: ClipStorage
    private lateinit var caps: CameraCapabilities
    private val control = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    // ---- control-thread state
    private val recorders = mutableListOf<CameraStreamRecorder>()
    private var mode = Mode.DRIVING
    private var degraded = false
    private var fallbackLevel = 0
    private var consecutiveErrors = 0
    private var pausedReason: Status? = null
    private var warnedNearCap = false
    private var warnedLocked = false
    private var wakeLock: PowerManager.WakeLock? = null

    /** Motion parking: per stream, the latest motion-free segment (kept only if motion follows). */
    private class MotionFilter {
        var preRoll: File? = null
        var keepNext = false
    }
    private val motionFilters = HashMap<String, MotionFilter>()

    /** Impact: per stream, how many upcoming segments to lock, and the last finished segment. */
    private val lockNext = HashMap<String, Int>()
    private val lastFinished = HashMap<String, File>()

    private var tracker: LocationTracker? = null
    private var impactDetector: ImpactDetector? = null

    @Volatile private var running = false
    private var monitorsRegistered = false
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        settings = OdcSettings(this)
        storage = ClipStorage(this, settings)
        caps = CameraCapabilities(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> shutdown()
            else -> if (!running) {
                running = true
                if (!goForeground()) return START_NOT_STICKY
                StandbyService.stop(this)
                registerMonitors()
                startSensors()
                post { beginSession() }
                mainHandler.postDelayed(heartbeatTick, 3_000)
            }
        }
        // Not sticky: Android won't let a restarted background service reopen the camera anyway.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        mainHandler.removeCallbacks(heartbeatTick)
        if (running) {
            running = false
            unregisterMonitors()
            stopSensors()
            post { stopRecorders(); releaseWakeLock(); _state.value = State() }
        }
        control.shutdown()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- lifecycle

    private fun goForeground(): Boolean {
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        if (settings.audioEnabled && hasPermission(Manifest.permission.RECORD_AUDIO)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        }
        if (settings.gpsEnabled && hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        return try {
            ServiceCompat.startForeground(
                this, Notifier.RECORDING_ID,
                Notifier.recording(this, "Starting Open Dash Cam", "Preparing cameras…"), types,
            )
            true
        } catch (e: Exception) {
            running = false
            _state.value = State(status = Status.ERROR, message = "Android blocked recording: ${e.message}. Open ODC and try again.")
            stopSelf()
            false
        }
    }

    private fun shutdown() {
        if (!running) {
            stopSelf()
            return
        }
        running = false
        unregisterMonitors()
        stopSensors()
        mainHandler.removeCallbacks(heartbeatTick)
        post {
            stopRecorders()
            clearMotionFilters()
            sendHeartbeat(recording = false)
            pausedReason = null
            releaseWakeLock()
            val b = battery()
            _state.value = State(batteryPct = b.level, charging = b.charging)
            mainHandler.post {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                if (settings.autoStartCharging) StandbyService.start(this)
                stopSelf()
            }
        }
    }

    private fun beginSession() {
        val b = battery()
        mode = if (!b.charging && settings.parkingEnabled) Mode.PARKING else Mode.DRIVING
        degraded = false
        fallbackLevel = 0
        consecutiveErrors = 0
        pausedReason = null
        warnedNearCap = false
        warnedLocked = false
        storage.cleanupEmpty(emptySet())
        update {
            State(
                status = Status.STARTING, mode = mode, startedAt = System.currentTimeMillis(),
                batteryPct = b.level, charging = b.charging, gpsOn = tracker != null,
            )
        }
        applyModeToSensors()
        if (!b.charging && b.level in 0..settings.batteryCutoff) {
            pause(Status.PAUSED_BATTERY, "Battery is at ${b.level}%. Recording will start when the phone is charging.")
            return
        }
        if (privacyBlocksParking()) return
        startRecorders()
    }

    // ---------------------------------------------------------------- recorders

    private fun startRecorders() {
        if (!running) return
        val plan = ProfileBuilder.build(this, settings, caps, mode == Mode.PARKING, degraded, fallbackLevel)
        if (plan.streams.isEmpty()) {
            update { copy(status = Status.ERROR, message = "No usable camera was found on this phone.") }
            return
        }
        acquireWakeLock()
        plan.streams.forEach { profile ->
            val r = CameraStreamRecorder(this, profile, storage, this)
            recorders += r
            r.start()
        }
        update {
            copy(
                status = Status.STARTING, mode = mode,
                streams = plan.streams.map { it.describe() }, notes = plan.notes, message = null,
            )
        }
    }

    private fun stopRecorders() {
        val list = recorders.toList()
        recorders.clear()
        list.forEach { it.stopBlocking() }
        update { copy(activeFiles = emptySet()) }
    }

    private fun restartRecorders() {
        stopRecorders()
        clearMotionFilters()
        startRecorders()
    }

    /** Leaving motion mode: discard the pre-roll candidates nobody needed. */
    private fun clearMotionFilters() {
        motionFilters.values.forEach { f -> f.preRoll?.let { storage.deleteWithSidecars(it) } }
        motionFilters.clear()
        lockNext.clear()
        lastFinished.clear()
    }

    override fun onStreamStarted(recorder: CameraStreamRecorder) = post {
        if (recorder in recorders) {
            update { copy(status = Status.RECORDING, activeFiles = activePaths()) }
        }
    }

    override fun onSegmentFinished(recorder: CameraStreamRecorder, file: File, hadMotion: Boolean, endTime: Long) = post {
        consecutiveErrors = 0
        val profile = recorder.profile
        val label = profile.label

        // 1. Sidecars first, so they move together with the clip if it gets locked.
        writeSidecars(file, endTime, timelapse = profile.captureRate != null)

        // 2. Motion parking: keep segments with motion, the one after (post-roll) and the one before (pre-roll).
        var kept = true
        if (profile.motionDetect) {
            val f = motionFilters.getOrPut(label) { MotionFilter() }
            when {
                hadMotion -> { f.preRoll = null; f.keepNext = true }
                f.keepNext -> f.keepNext = false
                else -> {
                    f.preRoll?.let { storage.deleteWithSidecars(it) }
                    f.preRoll = file
                    kept = false
                }
            }
        }

        // 3. Impact: lock the segments during and after the jolt.
        val toLock = lockNext[label] ?: 0
        if (toLock > 0) {
            storage.lockFile(file, impact = true)
            lockNext[label] = toLock - 1
        } else {
            lastFinished[label] = file
        }

        // 4. Loop recording.
        val result = storage.enforceLoop(activePaths())
        if (result.lockedNearCap && !warnedLocked) {
            warnedLocked = true
            Notifier.alert(
                this, "Locked clips are filling storage",
                "Locked clips use ${ClipStorage.formatBytes(result.lockedBytes)} of your ${ClipStorage.formatBytes(result.capBytes)} limit. " +
                    "Unlock or copy some off the phone so loop recording has room.",
            )
        } else if (result.nearCap && !warnedNearCap) {
            warnedNearCap = true
            Notifier.alert(
                this, "Storage limit almost reached",
                "Footage is near your ${ClipStorage.formatBytes(result.capBytes)} limit. " +
                    "Loop recording will start replacing the oldest unlocked clips.",
            )
        }
        update { copy(segments = segments + if (kept) 1 else 0, activeFiles = activePaths()) }
        checkBattery()
        if (kept && settings.smbEnabled) BackupScheduler.kick(this)
    }

    override fun onMotion(recorder: CameraStreamRecorder) = post {
        // Promote the waiting pre-roll segment so it's kept.
        motionFilters[recorder.profile.label]?.preRoll = null
        update { copy(motionEvents = motionEvents + 1) }
    }

    override fun onStreamError(recorder: CameraStreamRecorder, message: String, configFailure: Boolean) = post {
        if (recorder !in recorders) return@post
        stopRecorders()
        if (configFailure && fallbackLevel < MAX_FALLBACK) {
            fallbackLevel++
            update { copy(message = "Adjusting settings for this phone…") }
            startRecorders()
            return@post
        }
        consecutiveErrors++
        if (consecutiveErrors > MAX_RETRIES) {
            releaseWakeLock()
            update { copy(status = Status.ERROR, message = message) }
            Notifier.alert(this, "Recording stopped", message)
            ServerReporter.event(this, "recording_stopped", message)
            return@post
        }
        update { copy(status = Status.STARTING, message = "Recovering: $message") }
        Thread.sleep(2_000)
        if (running && pausedReason == null) startRecorders()
    }

    // ---------------------------------------------------------------- ODC Server heartbeat

    private val heartbeatTick: Runnable = object : Runnable {
        override fun run() {
            post { sendHeartbeat(recording = recorders.isNotEmpty()) }
            if (running) mainHandler.postDelayed(this, 60_000)
        }
    }

    private fun sendHeartbeat(recording: Boolean) {
        if (!settings.serverPaired) return
        val b = battery()
        val free = try { storage.root.usableSpace } catch (_: Exception) { -1L }
        val st = _state.value
        ServerReporter.heartbeat(
            this, b.level, b.charging, st.thermalStatus, recording,
            if (mode == Mode.PARKING) "parking" else "driving", free,
        )
    }

    private fun activePaths(): Set<String> = recorders.flatMap { it.activePaths() }.toSet()

    private fun writeSidecars(file: File, endTime: Long, timelapse: Boolean) {
        val t = tracker
        if (t == null && !settings.subtitlesEnabled) return
        val start = Clip(file, false).startTime
        val points = t?.pointsBetween(start, endTime).orEmpty()
        if (t != null) TrackWriter.writeGpx(file, points)
        // Subtitles don't line up with time-lapse playback, so skip them there.
        if (settings.subtitlesEnabled && !timelapse) TrackWriter.writeSrt(file, start, endTime, points, settings)
    }

    // ---------------------------------------------------------------- GPS and impact sensors

    private fun startSensors() {
        if (settings.gpsEnabled) {
            val t = LocationTracker(this, settings)
            if (t.hasPermission) {
                t.listener = LocationTracker.Listener { speed, zone -> post { onFix(speed, zone) } }
                t.start(GPS_DRIVING_MS)
                tracker = t
            } else {
                t.stop()
            }
        }
        if (settings.impactEnabled) {
            val d = ImpactDetector(this) { g -> post { onImpact(g) } }
            if (d.start(mainHandler)) impactDetector = d
        }
    }

    private fun stopSensors() {
        tracker?.stop()
        tracker = null
        impactDetector?.stop()
        impactDetector = null
    }

    /** Parked: GPS every 30 s instead of every second, and a more sensitive impact threshold. */
    private fun applyModeToSensors() {
        val parking = mode == Mode.PARKING
        tracker?.start(if (parking) GPS_PARKING_MS else GPS_DRIVING_MS)
        impactDetector?.thresholdG = ImpactDetector.threshold(settings.impactSensitivity, parking)
    }

    private fun onFix(speedMps: Float?, zone: PrivacyZone?) {
        // Live position for the ODC Server map (never inside a privacy zone).
        if (zone == null && settings.gpsEnabled) {
            tracker?.lastLocation?.let { loc ->
                ServerReporter.live(
                    this, loc.time, loc.latitude, loc.longitude,
                    if (loc.hasSpeed()) loc.speed else null,
                    if (loc.hasBearing()) loc.bearing else null,
                    if (loc.hasAccuracy()) loc.accuracy else null,
                )
            }
        }
        update {
            copy(
                speed = if (mode == Mode.DRIVING) speedMps?.let { settings.formatSpeed(it) } else null,
                privacyZone = zone?.name,
            )
        }
        if (pausedReason == null && recorders.isNotEmpty()) privacyBlocksParking()
    }

    /** Pauses recording if parked inside a zone where parking mode is turned off. */
    private fun privacyBlocksParking(): Boolean {
        if (mode != Mode.PARKING) return false
        val zone = tracker?.currentZone ?: return false
        if (!zone.disableParking) return false
        stopRecorders()
        clearMotionFilters()
        pause(Status.PAUSED_PRIVACY, "Parking mode is off in ${zone.name}. Recording resumes when the phone is charging.")
        return true
    }

    private fun onImpact(g: Float) {
        if (recorders.isEmpty()) return
        recorders.forEach { r ->
            val label = r.profile.label
            r.markMotion()
            motionFilters[label]?.preRoll = null
            lockNext[label] = 2   // the segment in progress and the next one
            lastFinished.remove(label)?.let { storage.lockFile(it, impact = true) }
        }
        update { copy(impacts = impacts + 1) }
        ServerReporter.event(this, "impact", String.format(Locale.US, "%.1f g jolt; clips locked", g))
        Notifier.alert(
            this, "Impact detected",
            String.format(Locale.US, "A %.1f g jolt was detected. The clips before, during and after it are locked.", g),
        )
    }

    // ---------------------------------------------------------------- power, battery, heat

    private val powerReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // Debounce: power often flickers while the engine cranks.
            mainHandler.removeCallbacks(powerCheck)
            mainHandler.postDelayed(powerCheck, POWER_DEBOUNCE_MS)
        }
    }
    private val powerCheck = Runnable { post { onPowerChanged() } }

    private val batteryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            post { checkBattery() }
        }
    }

    private fun onPowerChanged() {
        if (!running) return
        val b = battery()
        update { copy(batteryPct = b.level, charging = b.charging) }
        val newMode = if (!b.charging && settings.parkingEnabled) Mode.PARKING else Mode.DRIVING

        if (pausedReason == Status.PAUSED_BATTERY || pausedReason == Status.PAUSED_PRIVACY) {
            if (b.charging) {
                pausedReason = null
                mode = newMode
                applyModeToSensors()
                startRecorders()
            }
            return
        }
        if (pausedReason != null) {
            mode = newMode
            applyModeToSensors()
            return
        }
        if (newMode != mode) {
            mode = newMode
            update { copy(mode = newMode) }
            applyModeToSensors()
            if (!privacyBlocksParking()) restartRecorders()
        }
    }

    private fun checkBattery() {
        if (!running) return
        val b = battery()
        update { copy(batteryPct = b.level, charging = b.charging) }
        if (!b.charging && b.level in 0..settings.batteryCutoff && recorders.isNotEmpty()) {
            stopRecorders()
            clearMotionFilters()
            pause(Status.PAUSED_BATTERY, "Battery reached ${b.level}%. Recording will resume when the phone is charging.")
            Notifier.alert(this, "Recording paused to protect your footage", "Battery reached ${b.level}%. ODC closed the last clip safely and will resume when charging.")
            ServerReporter.event(this, "battery_cutoff", "Battery reached ${b.level}%; recording paused.")
        }
    }

    private fun onThermalChanged(status: Int) {
        update { copy(thermalStatus = status) }
        if (!running || !settings.thermalProtection) return
        when {
            status >= PowerManager.THERMAL_STATUS_CRITICAL && pausedReason == null -> {
                stopRecorders()
                clearMotionFilters()
                pause(Status.PAUSED_THERMAL, "The phone is too hot to record safely. Recording resumes when it cools down.")
                Notifier.alert(this, "Phone is overheating", "Recording paused until the phone cools down. Shade it or point a vent at it.")
                ServerReporter.event(this, "overheating", "Recording paused until the phone cools down.")
            }
            status >= PowerManager.THERMAL_STATUS_SEVERE && !degraded && pausedReason == null -> {
                degraded = true
                Notifier.alert(this, "Phone is getting hot", "ODC lowered the resolution and frame rate to reduce heat.")
                restartRecorders()
            }
            status <= PowerManager.THERMAL_STATUS_MODERATE && (degraded || pausedReason == Status.PAUSED_THERMAL) -> {
                degraded = false
                if (pausedReason == Status.PAUSED_THERMAL) {
                    pausedReason = null
                    startRecorders()
                } else if (pausedReason == null) {
                    restartRecorders()
                }
            }
        }
    }

    private fun pause(reason: Status, message: String) {
        pausedReason = reason
        releaseWakeLock()
        update { copy(status = reason, message = message, streams = emptyList()) }
    }

    private data class Battery(val level: Int, val charging: Boolean)

    private fun battery(): Battery {
        val i = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = i?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = i?.getIntExtra(BatteryManager.EXTRA_SCALE, 100) ?: 100
        val plugged = i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return Battery(if (level >= 0 && scale > 0) level * 100 / scale else -1, plugged != 0)
    }

    private fun registerMonitors() {
        if (monitorsRegistered) return
        monitorsRegistered = true
        val powerFilter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        ContextCompat.registerReceiver(this, powerReceiver, powerFilter, ContextCompat.RECEIVER_NOT_EXPORTED)
        ContextCompat.registerReceiver(
            this, batteryReceiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED
        )
        val pm = getSystemService(PowerManager::class.java)
        val listener = PowerManager.OnThermalStatusChangedListener { status -> post { onThermalChanged(status) } }
        thermalListener = listener
        pm.addThermalStatusListener(control, listener)
    }

    private fun unregisterMonitors() {
        if (!monitorsRegistered) return
        monitorsRegistered = false
        mainHandler.removeCallbacks(powerCheck)
        try { unregisterReceiver(powerReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(batteryReceiver) } catch (_: Exception) {}
        thermalListener?.let { getSystemService(PowerManager::class.java).removeThermalStatusListener(it) }
        thermalListener = null
    }

    // ---------------------------------------------------------------- helpers

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OpenDashCam:recording")
            .apply {
                setReferenceCounted(false)
                acquire()
            }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun hasPermission(p: String) =
        ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun update(transform: State.() -> State) {
        val old = _state.value
        val new = old.transform()
        _state.value = new
        if (running && (old.status != new.status || old.mode != new.mode || old.streams != new.streams || old.message != new.message)) {
            val title = when (new.status) {
                Status.RECORDING -> "Recording · ${new.mode.label}"
                else -> new.status.label
            }
            val text = new.message ?: new.streams.joinToString("\n").ifEmpty { "Open Dash Cam" }
            Notifier.updateRecording(this, title, text)
        }
    }

    private fun post(block: () -> Unit) {
        if (control.isShutdown) return
        try {
            control.execute(block)
        } catch (_: RejectedExecutionException) {
        }
    }
}
