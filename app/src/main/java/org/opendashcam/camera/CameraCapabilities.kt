package org.opendashcam.camera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.util.Range
import android.util.Size

data class CameraInfo(
    val id: String,
    val facing: Int,
    val sensorOrientation: Int,
    val videoSizes: List<Size>,
    val fpsRanges: List<Range<Int>>,
    val yuvSizes: List<Size>,
) {
    val isBack get() = facing == CameraCharacteristics.LENS_FACING_BACK
}

/** Reads what this phone's cameras and encoders can actually do. */
class CameraCapabilities(context: Context) {
    private val manager = context.getSystemService(CameraManager::class.java)

    val cameras: List<CameraInfo> by lazy { load() }
    val rear: CameraInfo? get() = cameras.firstOrNull { it.facing == CameraCharacteristics.LENS_FACING_BACK }
    val front: CameraInfo? get() = cameras.firstOrNull { it.facing == CameraCharacteristics.LENS_FACING_FRONT }

    /** True when the phone reports it can stream from the rear and front cameras at the same time (Android 11+). */
    val supportsDual: Boolean by lazy {
        val r = rear
        val f = front
        if (r == null || f == null || Build.VERSION.SDK_INT < 30) {
            false
        } else {
            try {
                manager.concurrentCameraIds.any { it.contains(r.id) && it.contains(f.id) }
            } catch (e: Exception) {
                false
            }
        }
    }

    val hevcEncoder: Boolean by lazy {
        try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
                info.isEncoder && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_HEVC, ignoreCase = true) }
            }
        } catch (e: Exception) {
            false
        }
    }

    fun supportedHeights(info: CameraInfo): List<Int> =
        STANDARD_HEIGHTS.filter { h -> info.videoSizes.any { it.height == h && it.width == h * 16 / 9 } }

    /** Best 16:9 size at or below the requested height. */
    fun pickSize(info: CameraInfo, height: Int): Size {
        val wide = info.videoSizes
            .filter { it.height <= height && it.width * 9 == it.height * 16 }
            .maxByOrNull { it.height }
        if (wide != null) return wide
        return info.videoSizes.filter { it.height <= height }.maxByOrNull { it.width * it.height }
            ?: info.videoSizes.minByOrNull { it.width * it.height }
            ?: Size(1280, 720)
    }

    fun supportsFps(info: CameraInfo, fps: Int) =
        info.fpsRanges.any { it.lower <= fps && it.upper >= fps }

    /** Prefer a fixed range [fps, fps] so exposure doesn't drop the frame rate at night. */
    fun fpsRange(info: CameraInfo, fps: Int): Range<Int> {
        info.fpsRanges.firstOrNull { it.lower == fps && it.upper == fps }?.let { return it }
        info.fpsRanges.filter { it.upper == fps }.maxByOrNull { it.lower }?.let { return it }
        info.fpsRanges.filter { it.lower <= fps && it.upper >= fps }
            .minByOrNull { it.upper - it.lower }?.let { return it }
        return info.fpsRanges.firstOrNull() ?: Range(fps, fps)
    }

    /** The slowest frame-rate range the camera offers (used for time-lapse to save power). */
    fun lowestFpsRange(info: CameraInfo): Range<Int> =
        info.fpsRanges.minWithOrNull(compareBy<Range<Int>>({ it.upper }, { it.lower })) ?: Range(15, 30)

    /** A small YUV size for motion analysis, about 320-640 px wide. */
    fun analysisSize(info: CameraInfo): Size =
        info.yuvSizes.filter { it.width >= 320 }.minByOrNull { it.width * it.height }
            ?: info.yuvSizes.minByOrNull { it.width * it.height }
            ?: Size(640, 480)

    private fun load(): List<CameraInfo> = try {
        manager.cameraIdList.mapNotNull { id ->
            try {
                val c = manager.getCameraCharacteristics(id)
                val facing = c.get(CameraCharacteristics.LENS_FACING) ?: return@mapNotNull null
                if (facing == CameraCharacteristics.LENS_FACING_EXTERNAL) return@mapNotNull null
                val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return@mapNotNull null
                CameraInfo(
                    id = id,
                    facing = facing,
                    sensorOrientation = c.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90,
                    videoSizes = map.getOutputSizes(MediaRecorder::class.java)?.toList().orEmpty(),
                    fpsRanges = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.toList().orEmpty(),
                    yuvSizes = map.getOutputSizes(ImageFormat.YUV_420_888)?.toList().orEmpty(),
                )
            } catch (e: Exception) {
                null
            }
        }
    } catch (e: Exception) {
        emptyList()
    }

    companion object {
        val STANDARD_HEIGHTS = listOf(2160, 1440, 1080, 720)
        fun heightLabel(h: Int) = when (h) { 2160 -> "4K"; else -> "${h}p" }
    }
}
