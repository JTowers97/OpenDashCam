@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package org.opendashcam.ui

import android.media.MediaPlayer
import android.net.Uri
import android.widget.VideoView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.opendashcam.backup.ServerClient
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date
import kotlin.math.abs

private class SyncClip(val id: String, val cameraId: String, val start: Long, val durationMs: Long, val url: String)

private class Panel(val cameraId: String, val label: String, val clips: List<SyncClip>) {
    var view: VideoView? = null
    var player: MediaPlayer? = null
    var clipId: String? = null
    var prepared = false
    var gap by mutableStateOf(false)
    fun clipAt(t: Long) = clips.firstOrNull { t >= it.start && t < it.start + it.durationMs }
}

/** All of this car's cameras from the ODC Server, played together on one clock. Needs a connection. */
@Composable
fun ServerSyncScreen(settings: OdcSettings, from: Long, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val to = from + 20 * 60_000L
    var panels by remember { mutableStateOf<List<Panel>?>(null) }
    var route by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var t by remember { mutableLongStateOf(from + 60_000) }
    var playing by remember { mutableStateOf(false) }
    var rate by remember { mutableFloatStateOf(1f) }

    LaunchedEffect(Unit) {
        val r = withContext(Dispatchers.IO) {
            try { Result.success(ServerClient(settings.serverUrl, settings.serverToken).sync(from, to)) } catch (e: Exception) { Result.failure(e) }
        }
        r.onFailure { error = "Can't reach the server: ${it.message ?: it.javaClass.simpleName}" }
        r.onSuccess { data ->
            val clips = data.getJSONArray("clips").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }.map {
                SyncClip(it.getString("id"), it.getString("cameraId"), it.getLong("startedAt"), it.getLong("durationMs"), it.getString("streamUrl"))
            }
            val cams = data.getJSONArray("cameras").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
            panels = cams.map { c -> Panel(c.getString("id"), c.getString("label"), clips.filter { it.cameraId == c.getString("id") }) }
                .filter { it.clips.isNotEmpty() }
            route = data.getJSONArray("route").let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
            clips.minByOrNull { it.start }?.let { first -> if (t < first.start) t = first.start }
        }
    }

    fun syncPanels() {
        val list = panels ?: return
        list.forEachIndexed { i, p ->
            val v = p.view ?: return@forEachIndexed
            val c = p.clipAt(t)
            p.gap = c == null
            if (c == null) {
                if (v.isPlaying) v.pause()
                return@forEachIndexed
            }
            if (p.clipId != c.id) {
                p.clipId = c.id
                p.prepared = false
                v.setOnPreparedListener { mp ->
                    p.player = mp
                    p.prepared = true
                    if (i != 0) mp.setVolume(0f, 0f) // sound from the first camera only
                    try { mp.playbackParams = mp.playbackParams.setSpeed(rate) } catch (_: Exception) {}
                    v.seekTo((t - c.start).toInt())
                    if (playing) v.start()
                }
                v.setVideoURI(Uri.parse(c.url))
                return@forEachIndexed
            }
            if (!p.prepared) return@forEachIndexed
            val want = t - c.start
            if (abs(v.currentPosition - want) > 800 * rate) v.seekTo(want.toInt())
            if (playing && !v.isPlaying) v.start()
            if (!playing && v.isPlaying) v.pause()
            p.player?.let { mp ->
                try { if (mp.playbackParams.speed != rate) mp.playbackParams = mp.playbackParams.setSpeed(rate) } catch (_: Exception) {}
            }
        }
    }

    // Master clock
    LaunchedEffect(panels) {
        var last = withFrameMillis { it }
        var lastSync = 0L
        while (isActive) {
            val now = withFrameMillis { it }
            if (playing) {
                t = (t + ((now - last) * rate).toLong()).coerceAtMost(to)
                if (t >= to) playing = false
            }
            last = now
            if (now - lastSync > 250) {
                lastSync = now
                syncPanels()
            }
        }
    }

    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ScreenHeader("All cameras", onBack)
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        val list = panels
        when {
            list == null && error == null -> Text("Loading…")
            list != null && list.isEmpty() -> Text("No footage from this time on the server.")
        }
        list?.forEach { p ->
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black)) {
                AndroidView(factory = { ctx -> VideoView(ctx).also { p.view = it } }, modifier = Modifier.fillMaxSize())
                Text(p.label, color = Color.White, modifier = Modifier.align(Alignment.TopStart).background(Color(0x99000000)).padding(horizontal = 6.dp, vertical = 2.dp))
                if (p.gap) Text("No footage at this moment", color = Color.LightGray, modifier = Modifier.align(Alignment.Center))
            }
        }
        if (list != null && list.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Button(onClick = { playing = !playing; syncPanels() }) { Text(if (playing) "Pause" else "Play") }
                Text(DateFormat.getTimeInstance(DateFormat.MEDIUM).format(Date(t)), fontWeight = FontWeight.Bold)
                val speed = route.minByOrNull { abs(it.getLong("t") - t) }?.takeIf { abs(it.getLong("t") - t) < 5000 }
                    ?.optDouble("speed")?.takeIf { !it.isNaN() }
                speed?.let { Text(settings.formatSpeed(it.toFloat())) }
            }
            Slider(
                value = (t - from).toFloat(),
                onValueChange = { t = from + it.toLong(); syncPanels() },
                valueRange = 0f..(to - from).toFloat(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(1f, 2f, 4f).forEach { r -> FilterChip(selected = rate == r, onClick = { rate = r; syncPanels() }, label = { Text("${r.toInt()}×") }) }
            }
            Hint("Cameras stay in sync to within about a second. Streaming needs a connection to your ODC Server.")
        }
    }
}
