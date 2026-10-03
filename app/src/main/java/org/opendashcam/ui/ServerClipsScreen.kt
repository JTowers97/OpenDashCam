package org.opendashcam.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.opendashcam.backup.ServerClient
import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.ClipStorage
import java.net.HttpURLConnection
import java.net.URL
import java.text.DateFormat
import java.util.Date

internal object RemoteThumbs {
    private val cache = LruCache<String, ImageBitmap>(80)
    suspend fun load(url: String): ImageBitmap? {
        val key = url.substringBefore('?')
        cache.get(key)?.let { return it }
        return withContext(Dispatchers.IO) {
            try {
                val c = URL(url).openConnection() as HttpURLConnection
                c.connectTimeout = 10_000
                c.readTimeout = 20_000
                val bmp = if (c.responseCode == 200) c.inputStream.use { BitmapFactory.decodeStream(it) } else null
                c.disconnect()
                bmp?.asImageBitmap()?.also { cache.put(key, it) }
            } catch (e: Exception) {
                null
            }
        }
    }
}

/** Clips of this phone's car stored on the ODC Server. Needs a connection to the server. */
@Composable
fun ServerClipsScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var clips by remember { mutableStateOf<List<JSONObject>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        error = null
        val result = withContext(Dispatchers.IO) {
            try {
                val arr = ServerClient(settings.serverUrl, settings.serverToken).clips(limit = 200)
                Result.success((0 until arr.length()).map { arr.getJSONObject(it) })
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
        result.onSuccess { clips = it }.onFailure { error = "Can't reach the server: ${it.message ?: it.javaClass.simpleName}" }
    }

    fun play(c: JSONObject) {
        if (c.optBoolean("encrypted")) {
            Toast.makeText(context, "This clip is encrypted. Open it on the phone or with odc_decrypt.", Toast.LENGTH_LONG).show()
            return
        }
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(c.getString("streamUrl")), "video/mp4"))
        } catch (e: Exception) {
            Toast.makeText(context, "No video player app found.", Toast.LENGTH_LONG).show()
        }
    }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { ScreenHeader("On the server", onBack) }
            OutlinedButton(onClick = { reload++ }) { Text("Refresh") }
        }
        Hint("${settings.serverCarName} · all cameras · streamed from ${settings.serverUrl}")
        when {
            !settings.serverPaired -> Text("This phone isn't connected to an ODC Server. Pair it in Settings → ODC Server.", modifier = Modifier.padding(top = 16.dp))
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 16.dp))
            clips == null -> Text("Loading…", modifier = Modifier.padding(top = 16.dp))
            clips!!.isEmpty() -> Text("No clips on the server yet.", modifier = Modifier.padding(top = 16.dp))
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                items(clips!!, key = { it.getString("id") }) { c -> ServerClipRow(c) { play(c) } }
            }
        }
    }
}

@Composable
private fun ServerClipRow(c: JSONObject, onPlay: () -> Unit) {
    val thumb by produceState<ImageBitmap?>(null, c.getString("id")) {
        value = if (c.optBoolean("encrypted")) null else RemoteThumbs.load(c.getString("thumbUrl"))
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onPlay),
    ) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.width(144.dp).height(81.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black),
                contentAlignment = Alignment.Center,
            ) {
                val t = thumb
                if (t != null) Image(t, contentDescription = "Play", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                Text("▶", color = Color.White)
                if (c.optBoolean("encrypted")) EncryptedBadge(Modifier.align(Alignment.TopStart).padding(4.dp))
            }
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(
                    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(c.getLong("startedAt"))),
                    fontWeight = FontWeight.Bold,
                )
                val tags = buildList {
                    add(c.optString("camera"))
                    if (c.optString("mode").startsWith("parking")) add("Parking")
                    if (c.optBoolean("locked")) add("🔒 Locked")
                    add(ClipStorage.formatBytes(c.optLong("size")))
                }
                Text(tags.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
