package org.opendashcam.location

import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.ClipStorage
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs

/**
 * Writes the files that sit next to each clip:
 *  - <clip>.gpx: GPS track with speed and heading (Garmin TrackPointExtension v2, widely supported)
 *  - <clip>.srt: subtitle overlay with date, time and speed that VLC, MX Player etc. show automatically
 */
object TrackWriter {

    fun writeGpx(video: File, points: List<TrackPoint>) {
        if (points.isEmpty()) return
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val sb = StringBuilder()
        sb.append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n")
        sb.append("<gpx version=\"1.1\" creator=\"Open Dash Cam\" xmlns=\"http://www.topografix.com/GPX/1/1\" ")
        sb.append("xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v2\">\n")
        sb.append("  <trk><name>").append(video.nameWithoutExtension).append("</name><trkseg>\n")
        points.forEach { p ->
            sb.append(String.format(Locale.US, "    <trkpt lat=\"%.7f\" lon=\"%.7f\">", p.lat, p.lon))
            p.altitude?.let { sb.append(String.format(Locale.US, "<ele>%.1f</ele>", it)) }
            sb.append("<time>").append(iso.format(Date(p.time))).append("</time>")
            p.accuracyM?.let { sb.append(String.format(Locale.US, "<hdop>%.1f</hdop>", it / 5f)) }
            if (p.speedMps != null || p.bearing != null) {
                sb.append("<extensions><gpxtpx:TrackPointExtension>")
                p.speedMps?.let { sb.append(String.format(Locale.US, "<gpxtpx:speed>%.2f</gpxtpx:speed>", it)) }
                p.bearing?.let { sb.append(String.format(Locale.US, "<gpxtpx:course>%.1f</gpxtpx:course>", it)) }
                sb.append("</gpxtpx:TrackPointExtension></extensions>")
            }
            sb.append("</trkpt>\n")
        }
        sb.append("  </trkseg></trk>\n</gpx>\n")
        try { ClipStorage.sidecar(video, "gpx").writeText(sb.toString()) } catch (_: Exception) {}
    }

    /** One subtitle per second of video. Speed appears only when a fix within 3 s exists. */
    fun writeSrt(video: File, start: Long, end: Long, points: List<TrackPoint>, settings: OdcSettings) {
        val seconds = ((end - start) / 1000).toInt().coerceIn(1, 3600)
        val clock = SimpleDateFormat("yyyy-MM-dd  HH:mm:ss", Locale.getDefault())
        val sb = StringBuilder()
        for (i in 0 until seconds) {
            val t = start + i * 1000L
            val nearest = points.minByOrNull { abs(it.time - t) }?.takeIf { abs(it.time - t) <= 3000 }
            val parts = mutableListOf(clock.format(Date(t)))
            nearest?.speedMps?.let { parts += settings.formatSpeed(it) }
            nearest?.let { parts += String.format(Locale.US, "%.5f, %.5f", it.lat, it.lon) }
            sb.append(i + 1).append('\n')
            sb.append(srtTime(i * 1000L)).append(" --> ").append(srtTime((i + 1) * 1000L)).append('\n')
            sb.append(parts.joinToString("  ·  ")).append("\n\n")
        }
        try { ClipStorage.sidecar(video, "srt").writeText(sb.toString()) } catch (_: Exception) {}
    }

    private fun srtTime(ms: Long): String =
        String.format(Locale.US, "%02d:%02d:%02d,%03d", ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000)
}
