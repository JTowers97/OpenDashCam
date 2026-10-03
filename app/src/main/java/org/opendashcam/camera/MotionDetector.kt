package org.opendashcam.camera

import android.media.Image
import android.os.SystemClock
import org.opendashcam.settings.Sensitivity
import kotlin.math.abs

/**
 * Cheap frame-difference motion detection on the luminance plane of small YUV frames.
 * The frame is reduced to a 32x18 grid of brightness samples; motion means enough cells changed
 * beyond the overall brightness shift (which cancels out headlights sweeping the whole scene and
 * auto-exposure changes). Two consecutive positive frames are required to ignore sensor noise.
 */
class MotionDetector(sensitivity: Sensitivity) {
    private val gw = 32
    private val gh = 18
    private val cells = gw * gh
    private var prev: IntArray? = null
    private var warmup = 0
    private var streak = 0
    private var lastAnalysis = 0L

    private val pixelThreshold = when (sensitivity) {
        Sensitivity.LOW -> 40; Sensitivity.MEDIUM -> 28; Sensitivity.HIGH -> 18
    }
    private val minChangedCells = when (sensitivity) {
        Sensitivity.LOW -> cells * 8 / 100; Sensitivity.MEDIUM -> cells * 4 / 100; Sensitivity.HIGH -> cells * 2 / 100
    }

    /** Returns true when motion is detected. Analyzes at most 5 frames per second. */
    fun analyze(image: Image): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (now - lastAnalysis < 200) return false
        lastAnalysis = now

        val plane = image.planes[0]
        val buf = plane.buffer
        val rowStride = plane.rowStride
        val pixelStride = plane.pixelStride
        val w = image.width
        val h = image.height
        val grid = IntArray(cells)
        for (gy in 0 until gh) {
            for (gx in 0 until gw) {
                // Average 4 samples spread inside each cell.
                var sum = 0
                for (sy in 0..1) for (sx in 0..1) {
                    val x = ((gx * 4 + 1 + sx * 2) * w) / (gw * 4)
                    val y = ((gy * 4 + 1 + sy * 2) * h) / (gh * 4)
                    val idx = y * rowStride + x * pixelStride
                    if (idx < buf.limit()) sum += buf.get(idx).toInt() and 0xFF
                }
                grid[gy * gw + gx] = sum / 4
            }
        }

        val p = prev
        prev = grid
        if (p == null || warmup < 5) {
            warmup++
            return false
        }
        var meanShift = 0
        for (i in 0 until cells) meanShift += grid[i] - p[i]
        meanShift /= cells
        var changed = 0
        for (i in 0 until cells) {
            if (abs(grid[i] - p[i] - meanShift) > pixelThreshold) changed++
        }
        streak = if (changed >= minChangedCells) streak + 1 else 0
        return streak >= 2
    }
}
