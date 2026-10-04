package org.opendashcam.recording

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** What the burned-in stamp shows. Updated by the recording service (settings, latest GPS fix). */
object OverlayData {
    @Volatile var showSpeed = true
    @Volatile var showCoords = false
    @Volatile var plate: String? = null       // your own plate, if shown
    @Volatile var speed: String? = null     // null: no GPS, or inside a privacy zone
    @Volatile var coords: String? = null

    /** Lines for the given time. Each renderer calls this on its own thread, so the formatter is per call site. */
    fun lines(timeMs: Long, format: SimpleDateFormat): List<String> {
        val first = buildString {
            plate?.let { append(it).append("   ") }
            append(format.format(Date(timeMs)))
            if (showSpeed) speed?.let { append("   ").append(it) }
        }
        val out = mutableListOf(first)
        if (showCoords) coords?.let { out += it }
        return out
    }

    fun newFormat() = SimpleDateFormat("yyyy-MM-dd  HH:mm:ss", Locale.US)
}
