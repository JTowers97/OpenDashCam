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
import android.os.Handler
import android.os.HandlerThread
import android.view.Surface
import org.opendashcam.camera.MotionDetector
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records one camera into consecutive clips (see [SegmentEncoder]). All camera work happens on this
 * stream's own thread. In motion-activated parking mode a second, small YUV stream feeds
 * [MotionDetector], and each finished clip reports whether motion happened during it.
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
    private var encoder: SegmentEncoder? = null
    private var cameraTarget: Surface? = null
    private var analysisReader: ImageReader? = null
    private val detector = if (profile.motionDetect) MotionDetector(profile.motionSensitivity) else null
    private val stampFormat = OverlayData.newFormat()
    private var recording = false
    @Volatile private var motionInCurrent = false
    @Volatile private var stopping = false

    val encodedFrames: Long get() = encoder?.encodedFrames ?: 0

    fun activePaths(): List<String> = listOfNotNull(encoder?.currentFile).map { it.absolutePath }

    fun start() {
        handler.post { openCamera() }
    }

    /** Captures the next frame as a JPEG (null if not recording). */
    fun requestSnapshot(callback: (ByteArray?) -> Unit) {
        encoder?.requestSnapshot(callback) ?: callback(null)
    }

    /** Flags the current clip as containing an event (used by impact detection). */
    fun markMotion() {
        motionInCurrent = true
    }

    /** Stops recording, finishes the current clip and releases the camera. Blocks up to timeoutMs. */
    fun stopBlocking(timeoutMs: Long = 8000) {
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

    private val encoderListener = object : SegmentEncoder.Listener {
        override fun onClipStarted(file: File) {}

        override fun onClipFinished(file: File) {
            val hadMotion = motionInCurrent
            motionInCurrent = false
            listener.onSegmentFinished(this@CameraStreamRecorder, file, hadMotion, ClockSync.now())
        }

        override fun onEncoderError(message: String) {
            handler.post { fail(message, false) }
        }
    }

    @SuppressLint("MissingPermission")
    private fun openCamera() {
        try {
            val enc = SegmentEncoder(context, profile, storage, { t -> OverlayData.lines(t, stampFormat) }, encoderListener)
            cameraTarget = enc.start()
            encoder = enc
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
        val target = cameraTarget ?: return
        val surfaces = mutableListOf(target)
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

    private fun release() {
        stopping = true
        try { session?.stopRepeating() } catch (_: Exception) {}
        try { session?.close() } catch (_: Exception) {}
        session = null
        try { camera?.close() } catch (_: Exception) {}
        camera = null
        // Finishes the clip in progress (reports it via onClipFinished) and frees the encoders.
        encoder?.stop()
        encoder = null
        recording = false
        try { analysisReader?.close() } catch (_: Exception) {}
        analysisReader = null
        cameraTarget = null
    }

    private fun fail(message: String, configFailure: Boolean) {
        if (stopping) return
        listener.onStreamError(this, message, configFailure)
    }
}
