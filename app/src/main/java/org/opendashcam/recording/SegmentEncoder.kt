package org.opendashcam.recording

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import org.opendashcam.settings.Codec
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Encodes one camera into consecutive clips of exact length, written as fragmented MP4 so that an
 * abrupt stop (crash, phone dies) loses at most about a second.
 *
 * camera -> [OverlayRenderer: optional stamp, time-lapse frame picking] -> H.264/H.265 encoder -> clips
 * microphone (optional) -> AAC encoder -> same clips
 *
 * Clips switch at a keyframe once the target length is reached (a keyframe is requested right then),
 * and fragments are written at every keyframe (about once a second).
 */
class SegmentEncoder(
    private val context: Context,
    private val profile: StreamProfile,
    private val storage: ClipStorage,
    private val stampLines: (Long) -> List<String>,
    private val listener: Listener,
) {
    interface Listener {
        fun onClipStarted(file: File)
        fun onClipFinished(file: File)
        fun onEncoderError(message: String)
    }

    private val thread = HandlerThread("odc-enc-${profile.label}").apply { start() }
    private val handler = Handler(thread.looper)
    private val lock = Any()

    private lateinit var video: MediaCodec
    private var renderer: OverlayRenderer? = null
    private var audio: MediaCodec? = null
    private var audioRecord: AudioRecord? = null
    private var audioThread: Thread? = null
    @Volatile private var stopping = false

    private var videoParams: List<ByteArray>? = null
    private var audioConfig: ByteArray? = null
    private var writer: FragmentedMp4Writer? = null
    private var videoTrack = -1
    private var audioTrack = -1
    private var segmentStartUs = -1L
    private var syncRequested = false
    private var startedAtMs = 0L
    private val videoDone = CountDownLatch(1)
    private val audioDone = CountDownLatch(1)

    @Volatile var currentFile: File? = null
        private set
    @Volatile var encodedFrames = 0L
        private set

    /** Camera time base, so audio timestamps line up with video. */
    private val realtimeClock: Boolean = try {
        context.getSystemService(CameraManager::class.java).getCameraCharacteristics(profile.cameraId)
            .get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE) == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
    } catch (_: Exception) {
        false
    }
    /** Clip length in encoded-video time. Time-lapse plays faster than real time, so its clips are shorter on screen. */
    private val segmentLengthUs: Long = profile.captureRate?.let { rate ->
        (profile.segmentMs * 1000.0 * rate / profile.fps).toLong().coerceAtLeast(1_000_000L)
    } ?: (profile.segmentMs * 1000L)

    private fun clockNs(): Long = if (realtimeClock) SystemClock.elapsedRealtimeNanos() else System.nanoTime()

    /** Starts the encoders. Returns the surface the camera should draw into. Throws if the encoder can't be set up. */
    fun start(): Surface {
        startedAtMs = SystemClock.elapsedRealtime()
        val mime = if (profile.codec == Codec.HEVC) MediaFormat.MIMETYPE_VIDEO_HEVC else MediaFormat.MIMETYPE_VIDEO_AVC
        val format = MediaFormat.createVideoFormat(mime, profile.width, profile.height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, profile.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, profile.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0) // decode order = display order, required by the writer
        }
        video = MediaCodec.createEncoderByType(mime)
        video.setCallback(videoCallback, handler)
        video.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val encoderInput = video.createInputSurface()
        video.start()

        val captureInterval = profile.captureRate?.let { (1_000_000_000L / it).toLong() }
        val r = OverlayRenderer(
            encoderInput, profile.width, profile.height, profile.orientationHint,
            lines = { t -> if (profile.overlay) stampLines(t) else emptyList() },
            captureIntervalNs = captureInterval,
            outputFps = profile.fps,
        )
        val cameraSurface = r.start() ?: run {
            r.release()
            video.release()
            throw IllegalStateException("This phone's graphics driver couldn't start the video pipeline")
        }
        renderer = r
        if (profile.audio) startAudio() else audioDone.countDown()
        return cameraSurface
    }

    /** Finishes the current clip cleanly and releases everything. Blocks up to a few seconds. */
    fun stop() {
        if (stopping) return
        stopping = true
        try { video.signalEndOfInputStream() } catch (_: Exception) { videoDone.countDown() }
        audioRecord?.let { try { it.stop() } catch (_: Exception) {} }
        videoDone.await(3, TimeUnit.SECONDS)
        audioDone.await(2, TimeUnit.SECONDS)
        audioThread?.join(1000)
        val finished = synchronized(lock) {
            val f = currentFile
            try { writer?.close() } catch (_: Exception) {}
            writer = null
            currentFile = null
            f
        }
        renderer?.release()
        try { video.stop() } catch (_: Exception) {}
        try { video.release() } catch (_: Exception) {}
        audio?.let { try { it.stop() } catch (_: Exception) {}; try { it.release() } catch (_: Exception) {} }
        try { audioRecord?.release() } catch (_: Exception) {}
        thread.quitSafely()
        if (finished != null) {
            if (finished.length() > 0) listener.onClipFinished(finished) else finished.delete()
        }
    }

    // ---------------------------------------------------------------- video

    private val videoCallback = object : MediaCodec.Callback() {
        override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {} // surface input

        override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {
            val ps = mutableListOf<ByteArray>()
            for (key in listOf("csd-0", "csd-1", "csd-2")) {
                format.getByteBuffer(key)?.let { b -> ByteArray(b.remaining()).also { b.get(it) }.let(ps::add) }
            }
            synchronized(lock) { videoParams = ps }
        }

        override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
            try {
                val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                    val buf = codec.getOutputBuffer(index)!!
                    buf.position(info.offset)
                    buf.limit(info.offset + info.size)
                    onVideoSample(buf, info.size, info.presentationTimeUs, info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0)
                }
                codec.releaseOutputBuffer(index, false)
                if (eos) videoDone.countDown()
            } catch (e: Exception) {
                fail("Video encoder: ${e.message}")
            }
        }

        override fun onError(codec: MediaCodec, e: MediaCodec.CodecException) {
            fail("Video encoder error: ${e.diagnosticInfo}")
        }
    }

    private fun onVideoSample(buf: ByteBuffer, size: Int, ptsUs: Long, key: Boolean) {
        var finished: File? = null
        var started: File? = null
        synchronized(lock) {
            encodedFrames++
            if (writer == null) {
                // Wait for the first keyframe, and for audio's format if audio is on (up to 1.5 s).
                val audioReady = !profile.audio || audioConfig != null || SystemClock.elapsedRealtime() - startedAtMs > 1500
                if (!key || videoParams == null || !audioReady) return
                started = openClip(ptsUs)
            } else if (ptsUs - segmentStartUs >= segmentLengthUs) {
                if (!key && !syncRequested) {
                    syncRequested = true
                    try { video.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) }) } catch (_: Exception) {}
                }
                if (key) {
                    finished = currentFile
                    try { writer?.close() } catch (e: Exception) { fail("Couldn't finish clip: ${e.message}") }
                    writer = null
                    started = openClip(ptsUs)
                }
            }
            val w = writer ?: return
            w.writeSample(videoTrack, buf, size, ptsUs, key)
            if (key && w.pendingVideoKeyFrameAfterFirst()) w.flushFragment(false)
        }
        finished?.let { listener.onClipFinished(it) }
        started?.let { listener.onClipStarted(it) }
    }

    /** Opens the next clip, starting at the keyframe at [ptsUs]. Call with [lock] held. */
    private fun openClip(ptsUs: Long): File {
        val file = storage.newSegmentFile(profile.label)
        val w = FragmentedMp4Writer(file)
        videoTrack = w.addVideoTrack(profile.codec == Codec.HEVC, profile.width, profile.height, profile.orientationHint, videoParams!!)
        val asc = audioConfig
        audioTrack = if (profile.audio && asc != null) w.addAudioTrack(SAMPLE_RATE, 1, asc) else -1
        w.start()
        writer = w
        currentFile = file
        segmentStartUs = ptsUs
        syncRequested = false
        return file
    }

    // ---------------------------------------------------------------- audio

    @SuppressLint("MissingPermission")
    private fun startAudio() {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.CAMCORDER, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minBuf, 8192) * 2)
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        rec.startRecording()
        audio = codec
        audioRecord = rec
        audioThread = Thread({ audioLoop(rec, codec) }, "odc-audio-${profile.label}").apply { start() }
    }

    private fun audioLoop(rec: AudioRecord, codec: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        val startNs = clockNs()
        var samples = 0L
        var inputDone = false
        try {
            while (true) {
                if (!inputDone) {
                    val inIdx = codec.dequeueInputBuffer(10_000)
                    if (inIdx >= 0) {
                        val inBuf = codec.getInputBuffer(inIdx)!!
                        inBuf.clear()
                        val n = if (stopping) 0 else rec.read(inBuf, minOf(inBuf.capacity(), 4096))
                        val ptsUs = (startNs + samples * 1_000_000_000L / SAMPLE_RATE) / 1000
                        if (stopping || n < 0) {
                            codec.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            inputDone = true
                        } else {
                            codec.queueInputBuffer(inIdx, 0, n, ptsUs, 0)
                            samples += n / 2
                        }
                    }
                }
                val outIdx = codec.dequeueOutputBuffer(info, 10_000)
                when {
                    outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                        codec.outputFormat.getByteBuffer("csd-0")?.let { b ->
                            val asc = ByteArray(b.remaining()).also { b.get(it) }
                            synchronized(lock) { audioConfig = asc }
                        }
                    }
                    outIdx >= 0 -> {
                        val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                            val buf = codec.getOutputBuffer(outIdx)!!
                            buf.position(info.offset)
                            buf.limit(info.offset + info.size)
                            synchronized(lock) {
                                // Audio from before the clip's first video frame is dropped.
                                if (writer != null && audioTrack >= 0 && info.presentationTimeUs >= segmentStartUs) {
                                    writer?.writeSample(audioTrack, buf, info.size, info.presentationTimeUs, true)
                                }
                            }
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        if (eos) break
                    }
                }
            }
        } catch (e: Exception) {
            if (!stopping) fail("Audio: ${e.message}")
        } finally {
            audioDone.countDown()
        }
    }

    private fun fail(message: String) {
        if (!stopping) listener.onEncoderError(message)
    }

    companion object {
        private const val SAMPLE_RATE = 48_000
    }
}
