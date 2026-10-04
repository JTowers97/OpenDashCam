package org.opendashcam.recording

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLUtils
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Burns a date/time/speed stamp into the video. The camera draws into a GPU texture; each frame is
 * copied onto the encoder's input surface with the stamp on top, keeping the camera's own timestamps.
 *
 * The stamp is drawn rotated to cancel the video's rotation flag, so it appears upright and in the
 * bottom-left corner when played, whichever way the phone is mounted.
 */
class OverlayRenderer(
    private val encoderSurface: Surface,
    private val width: Int,
    private val height: Int,
    private val rotation: Int,
    private val lines: (Long) -> List<String>,
    /** Time-lapse: keep one camera frame per this many nanoseconds (null = every frame). */
    private val captureIntervalNs: Long? = null,
    /** Time-lapse playback frame rate: kept frames are stamped this far apart. */
    private val outputFps: Int = 30,
    /** Called after each frame is handed to the encoder. */
    private val onFrame: () -> Unit = {},
) {
    private var firstTs = -1L
    private var lastKeptTs = -1L
    private var keptFrames = 0L
    private val thread = HandlerThread("odc-overlay").apply { start() }
    private val handler = Handler(thread.looper)

    private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
    private var context: EGLContext = EGL14.EGL_NO_CONTEXT
    private var eglSurface: EGLSurface = EGL14.EGL_NO_SURFACE
    private var oesTex = 0
    private var stampTex = 0
    private var progCamera = 0
    private var progStamp = 0
    private lateinit var surfaceTexture: SurfaceTexture
    private lateinit var inputSurface: Surface
    private val texMatrix = FloatArray(16)
    private val stMatrix = FloatArray(16)
    private var stampVerts: FloatBuffer? = null
    private var lastSecond = -1L
    private val fullQuad = makeFullQuad() // per renderer: each camera draws on its own thread
    @Volatile private var released = false

    /** Sets up the GPU on the renderer thread. Returns the surface the camera should draw into, or null if it failed. */
    fun start(): Surface? {
        val latch = CountDownLatch(1)
        var ok = false
        handler.post {
            try {
                setup()
                ok = true
            } catch (e: Exception) {
                Log.w(TAG, "Overlay unavailable: ${e.message}")
            } finally {
                latch.countDown()
            }
        }
        latch.await(3, TimeUnit.SECONDS)
        if (!ok) {
            release()
            return null
        }
        return inputSurface
    }

    fun release() {
        released = true
        val latch = CountDownLatch(1)
        val posted = handler.post {
            try {
                if (::surfaceTexture.isInitialized) surfaceTexture.release()
                if (::inputSurface.isInitialized) inputSurface.release()
                if (display != EGL14.EGL_NO_DISPLAY) {
                    EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                    if (eglSurface != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, eglSurface)
                    if (context != EGL14.EGL_NO_CONTEXT) EGL14.eglDestroyContext(display, context)
                    EGL14.eglReleaseThread()
                    EGL14.eglTerminate(display)
                }
            } catch (_: Exception) {
            } finally {
                display = EGL14.EGL_NO_DISPLAY
                latch.countDown()
            }
        }
        if (posted) latch.await(2, TimeUnit.SECONDS)
        thread.quitSafely()
    }

    // ---------------------------------------------------------------- setup

    private fun setup() {
        display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        val version = IntArray(2)
        check(EGL14.eglInitialize(display, version, 0, version, 1)) { "eglInitialize failed" }
        val attribs = intArrayOf(
            EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
            EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
            EGL_RECORDABLE_ANDROID, 1,
            EGL14.EGL_NONE,
        )
        val configs = arrayOfNulls<EGLConfig>(1)
        val count = IntArray(1)
        check(EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, count, 0) && count[0] > 0) { "no EGL config" }
        val config = configs[0]!!
        context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0)
        check(context != EGL14.EGL_NO_CONTEXT) { "eglCreateContext failed" }
        eglSurface = EGL14.eglCreateWindowSurface(display, config, encoderSurface, intArrayOf(EGL14.EGL_NONE), 0)
        check(eglSurface != EGL14.EGL_NO_SURFACE) { "eglCreateWindowSurface failed" }
        check(EGL14.eglMakeCurrent(display, eglSurface, eglSurface, context)) { "eglMakeCurrent failed" }

        progCamera = program(VERTEX_CAMERA, FRAGMENT_CAMERA)
        progStamp = program(VERTEX_STAMP, FRAGMENT_STAMP)

        val tex = IntArray(2)
        GLES20.glGenTextures(2, tex, 0)
        oesTex = tex[0]
        stampTex = tex[1]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, stampTex)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

        surfaceTexture = SurfaceTexture(oesTex)
        surfaceTexture.setDefaultBufferSize(width, height)
        surfaceTexture.setOnFrameAvailableListener({ drawFrame() }, handler)
        inputSurface = Surface(surfaceTexture)
    }

    // ---------------------------------------------------------------- per frame

    private fun drawFrame() {
        if (released) return
        try {
            surfaceTexture.updateTexImage()
            val ts = surfaceTexture.timestamp
            if (firstTs < 0) firstTs = ts
            val interval = captureIntervalNs
            if (interval != null && lastKeptTs >= 0 && ts - lastKeptTs < interval) return // time-lapse: skip
            lastKeptTs = ts
            // Normal video keeps the camera's timestamps; time-lapse plays kept frames back to back.
            val pts = if (interval != null) firstTs + keptFrames * 1_000_000_000L / outputFps else ts
            keptFrames++
            surfaceTexture.getTransformMatrix(stMatrix)
            sensorMatrix(stMatrix, texMatrix)
            GLES20.glViewport(0, 0, width, height)

            // Camera frame, full size.
            GLES20.glUseProgram(progCamera)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
            GLES20.glUniform1i(GLES20.glGetUniformLocation(progCamera, "sTex"), 0)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(progCamera, "uTexMatrix"), 1, false, texMatrix, 0)
            draw(progCamera, fullQuad)

            // Stamp, refreshed once a second.
            val nowMs = ClockSync.now()
            if (nowMs / 1000 != lastSecond) {
                lastSecond = nowMs / 1000
                updateStamp(lines(nowMs))
            }
            stampVerts?.let { verts ->
                GLES20.glEnable(GLES20.GL_BLEND)
                GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA) // bitmaps are premultiplied
                GLES20.glUseProgram(progStamp)
                GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, stampTex)
                GLES20.glUniform1i(GLES20.glGetUniformLocation(progStamp, "sTex"), 0)
                draw(progStamp, verts)
                GLES20.glDisable(GLES20.GL_BLEND)
            }

            EGLExt.eglPresentationTimeANDROID(display, eglSurface, pts)
            EGL14.eglSwapBuffers(display, eglSurface)
            onFrame()
        } catch (e: Exception) {
            Log.w(TAG, "frame failed: ${e.message}")
        }
    }

    /**
     * For camera output going to the GPU, Android rotates (and for the front camera mirrors) frames so a
     * preview looks upright on screen. A recording must use the frame as the sensor delivers it (the
     * file's rotation flag turns it upright on playback), so keep only the matrix's crop and vertical
     * flip and drop its rotation/mirroring. Rotations by multiples of 90° map the crop rectangle onto
     * itself, so the crop is read from where the corners land.
     */
    private fun sensorMatrix(st: FloatArray, out: FloatArray) {
        var sMin = Float.MAX_VALUE; var sMax = -Float.MAX_VALUE
        var tMin = Float.MAX_VALUE; var tMax = -Float.MAX_VALUE
        for (cs in 0..1) for (ct in 0..1) {
            val sx = st[0] * cs + st[4] * ct + st[12]
            val ty = st[1] * cs + st[5] * ct + st[13]
            sMin = minOf(sMin, sx); sMax = maxOf(sMax, sx)
            tMin = minOf(tMin, ty); tMax = maxOf(tMax, ty)
        }
        java.util.Arrays.fill(out, 0f)
        out[0] = sMax - sMin          // s' = sMin + s * width
        out[5] = -(tMax - tMin)       // t' = tMax - t * height (vertical flip: buffer row 0 at the top)
        out[10] = 1f
        out[12] = sMin
        out[13] = tMax
        out[15] = 1f
    }

    /** Interleaved x, y, s, t for a 4-vertex triangle strip. */
    private fun draw(prog: Int, verts: FloatBuffer) {
        val aPos = GLES20.glGetAttribLocation(prog, "aPos")
        val aTex = GLES20.glGetAttribLocation(prog, "aTex")
        verts.position(0)
        GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 16, verts)
        GLES20.glEnableVertexAttribArray(aPos)
        verts.position(2)
        GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 16, verts)
        GLES20.glEnableVertexAttribArray(aTex)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(aPos)
        GLES20.glDisableVertexAttribArray(aTex)
    }

    private fun updateStamp(text: List<String>) {
        if (text.isEmpty()) {
            stampVerts = null
            return
        }
        // Size relative to the picture as it will be seen (after rotation).
        val dw = if (rotation % 180 == 0) width else height
        val dh = if (rotation % 180 == 0) height else width
        val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = dh * 0.032f
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            setShadowLayer(dh * 0.003f, 0f, 0f, Color.BLACK)
        }
        val pad = paint.textSize * 0.45f
        val lineH = paint.fontSpacing
        val w = (text.maxOf { paint.measureText(it) } + 2 * pad).toInt().coerceAtLeast(1)
        val h = (lineH * text.size + 2 * pad).toInt().coerceAtLeast(1)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawRoundRect(RectF(0f, 0f, w.toFloat(), h.toFloat()), pad, pad, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(120, 0, 0, 0) })
        text.forEachIndexed { i, line -> canvas.drawText(line, pad, pad + lineH * i - paint.ascent(), paint) }
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, stampTex)
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bmp, 0)
        bmp.recycle()

        // Bottom-left corner of the viewed picture, mapped back into the encoded frame.
        val x0 = dw * 0.02f
        val y0 = dh - h - dh * 0.03f
        val corners = listOf(
            floatArrayOf(x0, y0, 0f, 0f),          // top-left
            floatArrayOf(x0, y0 + h, 0f, 1f),      // bottom-left
            floatArrayOf(x0 + w, y0, 1f, 0f),      // top-right
            floatArrayOf(x0 + w, y0 + h, 1f, 1f),  // bottom-right
        )
        val data = FloatArray(16)
        corners.forEachIndexed { i, c ->
            val (xe, ye) = toEncoded(c[0], c[1])
            data[i * 4] = xe / width * 2f - 1f
            data[i * 4 + 1] = 1f - ye / height * 2f
            data[i * 4 + 2] = c[2]
            data[i * 4 + 3] = c[3]
        }
        stampVerts = floatBuffer(data)
    }

    /** Players rotate the encoded frame clockwise by [rotation]; this undoes that for a point in the viewed picture. */
    private fun toEncoded(xd: Float, yd: Float): Pair<Float, Float> = when (rotation) {
        90 -> yd to (height - xd)
        180 -> (width - xd) to (height - yd)
        270 -> (width - yd) to xd
        else -> xd to yd
    }

    private fun program(vs: String, fs: String): Int {
        fun shader(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src)
            GLES20.glCompileShader(s)
            val ok = IntArray(1)
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
            check(ok[0] != 0) { "shader: " + GLES20.glGetShaderInfoLog(s) }
            return s
        }
        val p = GLES20.glCreateProgram()
        GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs))
        GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs))
        GLES20.glLinkProgram(p)
        val ok = IntArray(1)
        GLES20.glGetProgramiv(p, GLES20.GL_LINK_STATUS, ok, 0)
        check(ok[0] != 0) { "link: " + GLES20.glGetProgramInfoLog(p) }
        return p
    }

    companion object {
        private const val TAG = "OdcOverlay"
        private const val EGL_RECORDABLE_ANDROID = 0x3142

        private fun floatBuffer(data: FloatArray): FloatBuffer =
            ByteBuffer.allocateDirect(data.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(data); position(0) }

        private fun makeFullQuad() = floatBuffer(
            floatArrayOf(
                -1f, -1f, 0f, 0f,
                1f, -1f, 1f, 0f,
                -1f, 1f, 0f, 1f,
                1f, 1f, 1f, 1f,
            )
        )

        private val VERTEX_CAMERA = """
            attribute vec4 aPos;
            attribute vec4 aTex;
            uniform mat4 uTexMatrix;
            varying vec2 vTex;
            void main() { gl_Position = aPos; vTex = (uTexMatrix * aTex).xy; }
        """.trimIndent()
        private val FRAGMENT_CAMERA = """
            #extension GL_OES_EGL_image_external : require
            precision mediump float;
            varying vec2 vTex;
            uniform samplerExternalOES sTex;
            void main() { gl_FragColor = texture2D(sTex, vTex); }
        """.trimIndent()
        private val VERTEX_STAMP = """
            attribute vec4 aPos;
            attribute vec2 aTex;
            varying vec2 vTex;
            void main() { gl_Position = aPos; vTex = aTex; }
        """.trimIndent()
        private val FRAGMENT_STAMP = """
            precision mediump float;
            varying vec2 vTex;
            uniform sampler2D sTex;
            void main() { gl_FragColor = texture2D(sTex, vTex); }
        """.trimIndent()
    }
}
