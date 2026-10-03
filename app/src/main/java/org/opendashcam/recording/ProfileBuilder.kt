package org.opendashcam.recording

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.util.Range
import android.util.Size
import android.view.Display
import android.view.Surface
import androidx.core.content.ContextCompat
import org.opendashcam.camera.CameraCapabilities
import org.opendashcam.camera.CameraInfo
import org.opendashcam.settings.CameraMode
import org.opendashcam.settings.Codec
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.ParkingMode
import org.opendashcam.settings.Sensitivity
import kotlin.math.min

data class StreamProfile(
    val label: String,          // used in file names, e.g. "rear" or "front-park"
    val cameraName: String,     // "Rear" / "Front"
    val cameraId: String,
    val width: Int,
    val height: Int,
    val fps: Int,
    val fpsRange: Range<Int>,
    val bitrate: Int,
    val codec: Codec,
    val audio: Boolean,
    val orientationHint: Int,
    val segmentMs: Int,
    /** File size at which the recorder rolls over to the next clip (approximately segmentMs of video). */
    val segmentBytes: Long,
    /** Time-lapse: frames captured per second (null = normal video). */
    val captureRate: Double? = null,
    /** Motion-activated parking: analyze frames and keep only clips around motion. */
    val motionDetect: Boolean = false,
    val motionSensitivity: Sensitivity = Sensitivity.MEDIUM,
    val analysisSize: Size? = null,
) {
    fun describe(): String = when {
        captureRate != null -> "$cameraName ${height}p time-lapse, 1 frame every ${(1 / captureRate).toInt()} s"
        motionDetect -> "$cameraName ${height}p @ ${fps} fps, watching for motion"
        else -> "$cameraName ${height}p @ ${fps} fps, ${codec.label}" + if (audio) ", audio" else ""
    }
}

data class SessionPlan(val streams: List<StreamProfile>, val notes: List<String>)

/**
 * Turns settings + current conditions into concrete per-camera recording parameters.
 *
 * fallbackLevel steps quality down when the camera rejects a configuration:
 *   1 = max 30 fps, 2 = max 1080p, 3 = 720p, 4 = max 24 fps, 5 = single camera only
 */
object ProfileBuilder {
    /** Short segments in motion mode: the segment before motion becomes the pre-roll (10-25 s). */
    const val MOTION_SEGMENT_MS = 15_000
    const val TIMELAPSE_SEGMENT_MS = 10 * 60_000

    fun build(
        context: Context,
        settings: OdcSettings,
        caps: CameraCapabilities,
        parking: Boolean,
        degraded: Boolean,
        fallbackLevel: Int,
    ): SessionPlan {
        val notes = mutableListOf<String>()
        val cams = mutableListOf<Pair<String, CameraInfo>>()

        when (settings.cameraMode) {
            CameraMode.REAR -> caps.rear?.let { cams += "Rear" to it }
            CameraMode.FRONT -> caps.front?.let { cams += "Front" to it }
            CameraMode.DUAL -> {
                if (caps.supportsDual && fallbackLevel < 5) {
                    caps.rear?.let { cams += "Rear" to it }
                    caps.front?.let { cams += "Front" to it }
                } else {
                    caps.rear?.let { cams += "Rear" to it }
                    notes += "This phone couldn't record both cameras at once, so only the rear camera is recording."
                }
            }
        }
        if (cams.isEmpty()) {
            (caps.rear ?: caps.front)?.let { cams += (if (it.isBack) "Rear" else "Front") to it }
        }

        val parkingMode = if (parking) settings.parkingMode else null
        var height = if (parking) 720 else settings.resolution
        var fps = when (parkingMode) {
            null -> settings.fps
            ParkingMode.CONTINUOUS -> settings.parkingFps
            ParkingMode.MOTION -> 15      // watching at a low frame rate saves power
            ParkingMode.TIMELAPSE -> 30   // playback frame rate of the time-lapse
        }
        if (degraded) {
            height = min(height, 1080)
            fps = min(fps, 24)
            notes += "Quality reduced because the phone is hot."
        }
        if (fallbackLevel >= 1) fps = min(fps, 30)
        if (fallbackLevel >= 2) height = min(height, 1080)
        if (fallbackLevel >= 3) height = 720
        if (fallbackLevel >= 4) fps = min(fps, 24)
        if (fallbackLevel >= 1) notes += "Your selected settings weren't supported, so ODC lowered them automatically."

        val codec = if (settings.codec == Codec.HEVC && caps.hevcEncoder) Codec.HEVC else Codec.H264
        val micGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        val rotation = landscapeRotation(context, settings)

        val streams = cams.mapIndexed { index, (name, info) ->
            val size = caps.pickSize(info, height)
            val timelapse = parkingMode == ParkingMode.TIMELAPSE
            val motion = parkingMode == ParkingMode.MOTION
            val actualFps = if (timelapse || caps.supportsFps(info, fps)) fps else 30
            val bpp = settings.quality.bitsPerPixel *
                (if (codec == Codec.H264) 1.6 else 1.0) *
                (if (parking) 0.75 else 1.0)
            val bitrate = (size.width.toLong() * size.height * actualFps * bpp).toLong()
                .coerceIn(1_000_000L, 80_000_000L).toInt()
            val segmentMs = when {
                motion -> MOTION_SEGMENT_MS
                timelapse -> TIMELAPSE_SEGMENT_MS
                else -> settings.segmentMinutes.coerceIn(1, 10) * 60_000
            }
            val captureRate = if (timelapse) 1.0 / settings.timelapseIntervalSec.coerceIn(1, 10) else null
            // Seconds of *video* in one clip: time-lapse compresses real time.
            val videoSeconds = segmentMs / 1000.0 * (if (captureRate != null) captureRate / actualFps else 1.0)
            val audioBitrate = if (index == 0 && settings.audioEnabled && micGranted && !timelapse) 128_000 else 0
            val segmentBytes = ((bitrate + audioBitrate) * videoSeconds / 8).toLong().coerceAtLeast(1_000_000L)
            StreamProfile(
                label = name.lowercase() + if (parking) "-park" else "",
                cameraName = name,
                cameraId = info.id,
                width = size.width,
                height = size.height,
                fps = actualFps,
                fpsRange = if (timelapse) caps.lowestFpsRange(info) else caps.fpsRange(info, actualFps),
                bitrate = bitrate,
                codec = codec,
                // Only one stream can own the microphone.
                audio = index == 0 && settings.audioEnabled && micGranted && !timelapse,
                orientationHint = (info.sensorOrientation - rotation + 360) % 360,
                segmentMs = segmentMs,
                segmentBytes = segmentBytes,
                captureRate = captureRate,
                motionDetect = motion,
                motionSensitivity = settings.motionSensitivity,
                analysisSize = if (motion) caps.analysisSize(info) else null,
            )
        }
        return SessionPlan(streams, notes)
    }

    /** Rough storage use per hour for the current settings, for display in Settings. */
    fun estimateGbPerHour(settings: OdcSettings, caps: CameraCapabilities): Double {
        val codecFactor = if (settings.codec == Codec.HEVC && caps.hevcEncoder) 1.0 else 1.6
        val h = settings.resolution
        val w = h * 16 / 9
        val bitrate = (w.toLong() * h * settings.fps * settings.quality.bitsPerPixel * codecFactor)
            .coerceIn(1_000_000.0, 80_000_000.0)
        val streams = if (settings.cameraMode == CameraMode.DUAL && caps.supportsDual) 2 else 1
        return bitrate * 3600 / 8 / 1e9 * streams
    }

    /**
     * Video is always landscape. The app's screen is locked to landscape, so the display rotation is
     * 90 or 270 (which way up the phone is mounted). When ODC restarts recording from the background
     * (e.g. switching to parking mode while another app is open in portrait), the last landscape
     * rotation is reused instead of the other app's orientation.
     */
    private fun landscapeRotation(context: Context, settings: OdcSettings): Int {
        val current = displayRotationDegrees(context)
        return if (current == 90 || current == 270) {
            settings.lastLandscapeRotation = current
            current
        } else {
            settings.lastLandscapeRotation
        }
    }

    private fun displayRotationDegrees(context: Context): Int {
        val display = context.getSystemService(DisplayManager::class.java)?.getDisplay(Display.DEFAULT_DISPLAY)
        return when (display?.rotation) {
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }
    }
}
