package org.opendashcam.recording

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import org.opendashcam.camera.MotionDetector
import org.opendashcam.settings.Codec
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records one camera into a continuous series of segment files with no gaps between them
 * (MediaRecorder.setNextOutputFile). All camera work happens on this stream's own thread.
 *
 * In motion-activated parking mode a second, small YUV stream feeds [MotionDetector], and each
 * finished segment reports whether motion happened during it.
 */
class CameraStreamRecorder(
    private val context: Context,
    val profile: StreamProfile,
    private val storage: ClipStorage,
    private val listener: Listener,
) {
    interface Listener {
        fun onStreamStarted(recorder: CameraStreamRecorder)
        fun onSegmentFinished(recorder: CameraStreamRecorder, file: File, hadMotion: Boolean, endTime: Long)
        fun onMotion(recorder: CameraStreamRecorder)
        fun onStreamError(recorder: CameraStreamRecorder, message: String, configFailure: Boolean)
    }

    private val manager = context.getSystemService(CameraManager::class.java)
    private val thread = HandlerThread("odc-${profile.label}").apply { start() }
    private val handler = Handler(thread.looper)

    private var camera: CameraDevice? = null
    private var session: CameraCaptureSession? = null
    private var recorder: MediaRecorder? = null
    private var analysisReader: ImageReader? = null
    private val detector = if (profile.motionDetect) MotionDetector(profile.motionSensitivity) else null
    private var recording = false
    private var motionInCurrent = false

    @Volatile private var stopping = false
    @Volatile var currentFile: File? = null
        private set
    @Volatile var nextFile: File? = null
        private set

    fun activePaths(): List<String> = listOfNotNull(currentFile, nextFile).map { it.absolutePath }

    fun start() {
        handler.post { openCamera() }
    }

    /** Flags the current segment as containing an event (used by impact detection). */
    fun markMotion() {
        handler.post { motionInCurrent = true }
    }

    /** Stops recording, finalizes the current file and releases the camera. Blocks up to timeoutMs. */
    fun stopBlocking(timeoutMs: Long = 6000) {
        val latch = CountDownLatch(1)
        val posted = handler.post {
            try {
                release()
            } finally {
                latch.countDown()
            }
        }
        if (posted) latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        thread.quitSafely()
    }

    @SuppressLint("MissingPermission")
    private fun openCamera() {
        try {
            recorder = createRecorder()
            profile.analysisSize?.let { size ->
                analysisReader = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, 2).apply {
                    setOnImageAvailableListener({ reader -> analyzeFrame(reader) }, handler)
                }
            }
        } catch (e: Exception) {
            fail("${profile.cameraName} camera can't record ${profile.height}p @ ${profile.fps} fps (${e.message})", true)
            return
        }
        try {
            manager.openCamera(profile.cameraId, cameraCallback, handler)
        } catch (e: Exception) {
            fail("Couldn't open the ${profile.cameraName.lowercase()} camera: ${e.message}", false)
        }
    }

    private fun createRecorder(): MediaRecorder {
        val file = storage.newSegmentFile(profile.label)
        currentFile = file
        @Suppress("DEPRECATION")
        val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else MediaRecorder()
        if (profile.audio) r.setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
        r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
        r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        r.setOutputFile(file)
        r.setVideoEncoder(
            if (profile.codec == Codec.HEVC) MediaRecorder.VideoEncoder.HEVC else MediaRecorder.VideoEncoder.H264
        )
        r.setVideoSize(profile.width, profile.height)
        r.setVideoFrameRate(profile.fps)
        r.setVideoEncodingBitRate(profile.bitrate)
        profile.captureRate?.let { r.setCaptureRate(it) }
        if (profile.audio) {
            r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            r.setAudioEncodingBitRate(128_000)
            r.setAudioSamplingRate(48_000)
            r.setAudioChannels(1)
        }
        r.setOrientationHint(profile.orientationHint)
        // Android only signals "approaching" for file size, not duration, so clips roll over
        // at the size that matches the chosen clip length (see ProfileBuilder.segmentBytes).
        r.setMaxFileSize(profile.segmentBytes)
        r.setOnInfoListener { _, what, _ -> handler.post { onInfo(what) } }
        r.setOnErrorListener { _, what, extra -> handler.post { fail("Recorder error ($what/$extra)", false) } }
        r.prepare()
        return r
    }

    private fun analyzeFrame(reader: ImageReader) {
        val image = try { reader.acquireLatestImage() } catch (_: Exception) { null } ?: return
        try {
            if (recording && detector?.analyze(image) == true && !motionInCurrent) {
                motionInCurrent = true
                listener.onMotion(this)
            }
        } finally {
            image.close()
        }
    }

    private val cameraCallback = object : CameraDevice.StateCallback() {
        override fun onOpened(device: CameraDevice) {
            if (stopping) {
                device.close()
                return
            }
            camera = device
            createSession(device)
        }

        override fun onDisconnected(device: CameraDevice) {
            device.close()
            camera = null
            fail("${profile.cameraName} camera disconnected (another app may be using it)", false)
        }

        override fun onError(device: CameraDevice, error: Int) {
            device.close()
            camera = null
            fail("${profile.cameraName} camera error $error", false)
        }
    }

    private fun createSession(device: CameraDevice) {
        val r = recorder ?: return
        val surfaces = mutableListOf<Surface>(r.surface)
        analysisReader?.let { surfaces += it.surface }
        try {
            @Suppress("DEPRECATION")
            device.createCaptureSession(surfaces, object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(s: CameraCaptureSession) {
                    if (stopping) {
                        s.close()
                        return
                    }
                    session = s
                    try {
                        val request = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
                            surfaces.forEach { addTarget(it) }
                            set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO)
                            set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, profile.fpsRange)
                        }
                        s.setRepeatingRequest(request.build(), null, handler)
                        r.start()
                        recording = true
                        listener.onStreamStarted(this@CameraStreamRecorder)
                    } catch (e: Exception) {
                        fail("Couldn't start the ${profile.cameraName.lowercase()} camera: ${e.message}", true)
                    }
                }

                override fun onConfigureFailed(s: CameraCaptureSession) {
                    fail("${profile.cameraName} camera rejected ${profile.width}x${profile.height} @ ${profile.fps} fps", true)
                }
            }, handler)
        } catch (e: Exception) {
            fail("Couldn't configure the ${profile.cameraName.lowercase()} camera: ${e.message}", true)
        }
    }

    private fun onInfo(what: Int) {
        when (what) {
            MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING -> {
                if (stopping) return
                try {
                    val f = storage.newSegmentFile(profile.label)
                    recorder?.setNextOutputFile(f)
                    nextFile = f
                } catch (e: Exception) {
                    fail("Couldn't prepare the next segment: ${e.message}", false)
                }
            }
            MediaRecorder.MEDIA_RECORDER_INFO_NEXT_OUTPUT_FILE_STARTED -> {
                val finished = currentFile
                val hadMotion = motionInCurrent
                motionInCurrent = false
                val started = nextFile
                nextFile = null
                currentFile = started?.let { storage.renameToNow(it, profile.label) }
                finished?.let { listener.onSegmentFinished(this, it, hadMotion, System.currentTimeMillis()) }
            }
            MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> {
                fail("Segment rollover was missed", false)
            }
        }
    }

    private fun release() {
        stopping = true
        try { session?.stopRepeating() } catch (_: Exception) {}

        var finalized = false
        recorder?.let { r ->
            if (recording) {
                try {
                    r.stop()
                    finalized = true
                } catch (_: RuntimeException) {
                    // Thrown when no frames were recorded; the file is unusable.
                }
            }
            try { r.reset() } catch (_: Exception) {}
            r.release()
        }
        recorder = null
        recording = false

        try { session?.close() } catch (_: Exception) {}
        session = null
        try { camera?.close() } catch (_: Exception) {}
        camera = null
        try { analysisReader?.close() } catch (_: Exception) {}
        analysisReader = null

        nextFile?.let { if (it.length() == 0L) it.delete() }
        nextFile = null
        val cur = currentFile
        currentFile = null
        if (cur != null) {
            if (finalized && cur.length() > 0) {
                listener.onSegmentFinished(this, cur, motionInCurrent, System.currentTimeMillis())
            } else {
                cur.delete()
            }
        }
    }

    private fun fail(message: String, configFailure: Boolean) {
        if (stopping) return
        listener.onStreamError(this, message, configFailure)
    }
}
