@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package org.opendashcam.ui

import android.graphics.BitmapFactory
import android.net.Uri
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
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
import androidx.compose.ui.viewinterop.AndroidView
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point
import org.opendashcam.command.CommandCenter
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.SpeedUnit
import java.net.HttpURLConnection
import java.net.URL
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/** Places Command Center can open on top of its tabs (with Back returning through them). */
private sealed class CcRoute {
    data class Clip(val id: String) : CcRoute()
    data class Trip(val id: Long) : CcRoute()
    data class Live(val carId: Long, val name: String) : CcRoute()
    data object Search : CcRoute()
    data object More : CcRoute()
    data class PhoneSettings(val cameraId: String, val label: String) : CcRoute()
    data object PlateLog : CcRoute()
    data class Plate(val plate: String) : CcRoute()
    data object Shares : CcRoute()
    data object Sessions : CcRoute()
    data object People : CcRoute()
    data object ServerSettings : CcRoute()
}

private enum class CcTab(val label: String, val icon: String) { ALERTS("Alerts", "🔔"), TIMELINE("Timeline", "🎞"), MAP("Map", "🗺"), TRIPS("Trips", "🛣"), CARS("Cars", "🚗") }

// ---------------------------------------------------------------- helpers

private suspend fun ccGet(settings: OdcSettings, path: String): JSONObject = withContext(Dispatchers.IO) { CommandCenter.client(settings).call("GET", path) }
private suspend fun ccGetArray(settings: OdcSettings, path: String): JSONArray = withContext(Dispatchers.IO) { CommandCenter.client(settings).callArray("GET", path) }
private suspend fun ccSend(settings: OdcSettings, method: String, path: String, body: JSONObject? = null): JSONObject =
    withContext(Dispatchers.IO) { CommandCenter.client(settings).call(method, path, body) }

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
private fun clockText(t: Long) = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(t))
private fun dayText(t: Long) = DateFormat.getDateInstance(DateFormat.FULL).format(Date(t))
private fun dateTimeText(t: Long) = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(t))
private fun durText(ms: Long): String { val m = ms / 60_000; return if (m >= 60) "${m / 60} h ${m % 60} min" else "$m min" }
private fun distText(settings: OdcSettings, m: Double) = if (settings.resolvedSpeedUnit == SpeedUnit.MPH) String.format("%.1f mi", m / 1609.344) else String.format("%.1f km", m / 1000)
private fun bytesText(b: Long) = when { b >= 1L shl 30 -> String.format("%.1f GB", b / 1073741824.0); b >= 1L shl 20 -> "${b shr 20} MB"; else -> "${b shr 10} KB" }

@Composable
private fun Loading(text: String = "Loading…") = Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))

@Composable
private fun ErrorRetry(message: String, onRetry: () -> Unit) {
    Column(Modifier.padding(vertical = 8.dp)) {
        Text(message, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = onRetry) { Text("Retry") }
    }
}

// ---------------------------------------------------------------- the main screen

/**
 * Command Center: your ODC Server in the app. Tabs for alerts, timeline (with a calendar), map, trips and cars; search,
 * clips, trips and live view open on top, and Back returns through them.
 */
@Composable
fun CommandCenterApp(
    settings: OdcSettings,
    onOpenAlert: (Long, Long) -> Unit,
    onDashcamMode: () -> Unit,
    onSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val stack = remember { mutableStateListOf<CcRoute>() }
    BackHandler(enabled = stack.isNotEmpty()) { stack.removeAt(stack.lastIndex) }
    val open: (CcRoute) -> Unit = { stack.add(it) }
    val back: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) }

    val top = stack.lastOrNull()
    if (top != null) {
        when (top) {
            is CcRoute.Clip -> CcClipScreen(settings, top.id, back, modifier)
            is CcRoute.Trip -> CcTripScreen(settings, top.id, back, onOpenClip = { open(CcRoute.Clip(it)) }, modifier = modifier)
            is CcRoute.Live -> CcLiveViewScreen(settings, top.carId, top.name, back, modifier)
            CcRoute.Search -> CcSearchScreen(settings, back, onOpenClip = { open(CcRoute.Clip(it)) }, modifier = modifier)
            CcRoute.More -> CcMoreScreen(settings, back, onCcSettings = onSettings, onOpen = { where ->
                open(when (where) { "plates" -> CcRoute.PlateLog; "shares" -> CcRoute.Shares; "sessions" -> CcRoute.Sessions; "people" -> CcRoute.People; else -> CcRoute.ServerSettings })
            }, modifier = modifier)
            is CcRoute.PhoneSettings -> CcPhoneSettingsScreen(settings, top.cameraId, top.label, back, modifier)
            CcRoute.PlateLog -> CcPlateLogScreen(settings, back, onOpenPlate = { open(CcRoute.Plate(it)) }, modifier = modifier)
            is CcRoute.Plate -> CcPlateScreen(settings, top.plate, back, onOpenClip = { open(CcRoute.Clip(it)) }, modifier = modifier)
            CcRoute.Shares -> CcSharesScreen(settings, back, modifier)
            CcRoute.Sessions -> CcSessionsScreen(settings, back, modifier)
            CcRoute.People -> CcPeopleScreen(settings, back, modifier)
            CcRoute.ServerSettings -> CcServerSettingsScreen(settings, back, modifier)
        }
        return
    }

    Column(modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(CcTab.entries[tab].label, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = { open(CcRoute.Search) }) { Text("Search") }
            TextButton(onClick = { open(CcRoute.More) }) { Text("More") }
            TextButton(onClick = onDashcamMode) { Text("Dashcam") }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (CcTab.entries[tab]) {
                CcTab.ALERTS -> CcAlertsTab(settings, onOpenAlert)
                CcTab.TIMELINE -> CcTimelineTab(settings, onOpenClip = { open(CcRoute.Clip(it)) })
                CcTab.MAP -> CcMapTab(settings, onLive = { id, name -> open(CcRoute.Live(id, name)) })
                CcTab.TRIPS -> CcTripsTab(settings, onOpenTrip = { open(CcRoute.Trip(it)) })
                CcTab.CARS -> CcCarsTab(settings, onLive = { id, name -> open(CcRoute.Live(id, name)) },
                    onPhoneSettings = { id, label -> open(CcRoute.PhoneSettings(id, label)) })
            }
        }
        NavigationBar {
            CcTab.entries.forEachIndexed { i, t ->
                NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = { Text(t.icon) }, label = { Text(t.label) })
            }
        }
    }
}

// ---------------------------------------------------------------- alerts

@Composable
private fun CcAlertsTab(settings: OdcSettings, onOpenAlert: (Long, Long) -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    val data by produceState<Result<JSONArray>?>(null, reload) {
        value = runCatching { ccGet(settings, "/api/me/notifications?limit=100").getJSONArray("notifications") }
    }
    val d = data
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        when {
            d == null -> Loading()
            d.isFailure -> ErrorRetry("Couldn't reach ${settings.ccUrl}: ${d.exceptionOrNull()?.message}") { reload++ }
            else -> {
                val alerts = d.getOrThrow().objects().reversed()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Hint("${alerts.count { !it.optBoolean("read") }} unread", )
                    Box(Modifier.weight(1f))
                    TextButton(onClick = { reload++ }) { Text("Refresh") }
                }
                if (alerts.isEmpty()) Hint("No alerts yet. Impacts, arrivals, speeding and other alerts for your cars appear here.")
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(alerts, key = { it.optLong("id") }) { n ->
                        Card(
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                            modifier = Modifier.fillMaxWidth().clickable { onOpenAlert(if (n.isNull("eventId")) 0L else n.optLong("eventId"), n.optLong("id")) },
                        ) {
                            Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                val img = n.optString("imageUrl").takeIf { it.isNotBlank() && it != "null" }
                                if (img != null) ServerImage(settings, img, Modifier.width(96.dp).height(54.dp).clip(RoundedCornerShape(6.dp)))
                                Column(Modifier.padding(start = if (img != null) 10.dp else 0.dp).weight(1f)) {
                                    Text(n.optString("title"), fontWeight = if (n.optBoolean("read")) FontWeight.Normal else FontWeight.Bold)
                                    Hint("${n.optString("body")} · ${dateTimeText(n.optLong("t"))}")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- timeline and calendar

@Composable
private fun ClipRow(settings: OdcSettings, c: JSONObject, onClick: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Row(Modifier.padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(112.dp).height(63.dp).clip(RoundedCornerShape(6.dp)).background(Color.Black)) {
                if (c.optBoolean("hasThumb") && !c.optBoolean("encrypted")) ServerImage(settings, "/api/clips/${c.optString("id")}/thumb", Modifier.fillMaxSize())
                if (c.optBoolean("encrypted")) Text("🔒", modifier = Modifier.align(Alignment.Center))
            }
            Column(Modifier.padding(start = 10.dp).weight(1f)) {
                Text(clockText(c.optLong("startedAt")) + " · " + c.optString("carName"), fontWeight = FontWeight.Bold)
                Hint(listOfNotNull(
                    c.optString("camera"),
                    c.optString("place").takeIf { it.isNotBlank() && it != "null" },
                    if (c.optString("lockReason") == "impact") "⚠ impact" else if (c.optBoolean("locked")) "🔒 locked" else null,
                    if (c.optString("mode") == "parking") "parking" else null,
                ).joinToString(" · "))
            }
        }
    }
}

@Composable
private fun CcTimelineTab(settings: OdcSettings, onOpenClip: (String) -> Unit) {
    var calendar by rememberSaveable { mutableStateOf(false) }
    var day by rememberSaveable { mutableStateOf<Long?>(null) } // start of a chosen day
    var car by rememberSaveable { mutableStateOf<Long?>(null) }
    val cars by produceState<List<JSONObject>>(emptyList()) { value = runCatching { ccGetArray(settings, "/api/cars").objects() }.getOrDefault(emptyList()) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilterChip(selected = !calendar, onClick = { calendar = false }, label = { Text("List") })
            FilterChip(selected = calendar, onClick = { calendar = true }, label = { Text("Calendar") })
            if (cars.size > 1) {
                FilterChip(selected = car == null, onClick = { car = null }, label = { Text("All cars") })
                cars.forEach { c -> FilterChip(selected = car == c.optLong("id"), onClick = { car = c.optLong("id") }, label = { Text(c.optString("name")) }) }
            }
        }
        if (calendar) {
            CcCalendar(settings, car, onDay = { d -> day = d; calendar = false })
        } else {
            day?.let { d ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(dayText(d), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                    TextButton(onClick = { day = null }) { Text("All days") }
                }
            }
            CcClipList(settings, car, day, onOpenClip)
        }
    }
}

@Composable
private fun CcClipList(settings: OdcSettings, car: Long?, day: Long?, onOpenClip: (String) -> Unit) {
    val clips = remember(car, day) { mutableStateListOf<JSONObject>() }
    var total by remember(car, day) { mutableIntStateOf(-1) }
    var error by remember(car, day) { mutableStateOf<String?>(null) }
    var loadMore by remember(car, day) { mutableIntStateOf(0) }
    LaunchedEffect(car, day, loadMore) {
        val q = StringBuilder("/api/clips?limit=60&offset=${clips.size}")
        car?.let { q.append("&car=$it") }
        day?.let { q.append("&from=$it&to=${it + 86_400_000L - 1}") }
        runCatching { ccGet(settings, q.toString()) }
            .onSuccess { r -> clips.addAll(r.getJSONArray("clips").objects()); total = r.optInt("total") }
            .onFailure { error = it.message }
    }
    when {
        error != null -> ErrorRetry("Couldn't load clips: $error") { error = null; loadMore++ }
        total < 0 -> Loading()
        clips.isEmpty() -> Hint("No clips here yet.")
        else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val rows = clips.toList()
            // Day headings, worked out up front (rows are drawn lazily, in any order).
            val firstOfDay = rows.indices.filter { i -> i == 0 || dayText(rows[i].optLong("startedAt")) != dayText(rows[i - 1].optLong("startedAt")) }.toSet()
            items(rows.size, key = { rows[it].optString("id") }) { i ->
                val c = rows[i]
                Column {
                    if (i in firstOfDay) Text(dayText(c.optLong("startedAt")), fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    ClipRow(settings, c) { onOpenClip(c.optString("id")) }
                }
            }
            if (rows.size < total) item { OutlinedButton(onClick = { loadMore++ }) { Text("Load more (${total - rows.size})") } }
        }
    }
}

@Composable
private fun CcCalendar(settings: OdcSettings, car: Long?, onDay: (Long) -> Unit) {
    var monthOffset by rememberSaveable { mutableIntStateOf(0) }
    val cal = remember(monthOffset) { Calendar.getInstance().apply { set(Calendar.DAY_OF_MONTH, 1); add(Calendar.MONTH, monthOffset) } }
    val y = cal.get(Calendar.YEAR)
    val m = cal.get(Calendar.MONTH) + 1
    val key = String.format("%04d-%02d", y, m)
    val days by produceState<JSONObject?>(null, key, car) {
        value = runCatching { ccGet(settings, "/api/clips/calendar?month=$key" + (car?.let { "&car=$it" } ?: "")).getJSONObject("days") }.getOrNull()
    }
    Column(Modifier.verticalScroll(rememberScrollState())) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { monthOffset-- }) { Text("‹") }
            Text(java.text.SimpleDateFormat("MMMM yyyy", java.util.Locale.getDefault()).format(cal.time), fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = { monthOffset++ }) { Text("›") }
        }
        val lead = (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 // Monday first
        val count = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
        val cells = List(lead) { 0 } + (1..count).toList()
        Row { listOf("M", "T", "W", "T", "F", "S", "S").forEach { Text(it, modifier = Modifier.weight(1f), style = MaterialTheme.typography.labelSmall) } }
        cells.chunked(7).forEach { week ->
            Row(Modifier.padding(vertical = 2.dp)) {
                (week + List(7 - week.size) { 0 }).forEach { d ->
                    val info = if (d > 0) days?.optJSONObject(String.format("%s-%02d", key, d)) else null
                    Box(
                        Modifier.weight(1f).aspectRatio(1f).padding(2.dp).clip(RoundedCornerShape(6.dp))
                            .background(if (info != null) MaterialTheme.colorScheme.primary.copy(alpha = 0.35f) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = if (d > 0) 1f else 0f))
                            .then(if (info != null) Modifier.clickable {
                                onDay(Calendar.getInstance().apply { set(y, m - 1, d, 0, 0, 0); set(Calendar.MILLISECOND, 0) }.timeInMillis)
                            } else Modifier),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (d > 0) Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("$d", fontWeight = if (info != null) FontWeight.Bold else FontWeight.Normal)
                            if (info != null) Text("${info.optInt("count")}" + if (info.optBoolean("impact")) " ⚠" else "", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
        Hint("Days with footage are highlighted, with the number of clips. Tap one to see its clips.")
    }
}

// ---------------------------------------------------------------- one clip

@Composable
private fun CcClipScreen(settings: OdcSettings, id: String, onBack: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var seekTo by remember { mutableStateOf(0L) }
    val clip by produceState<Result<JSONObject>?>(null, id, reload) { value = runCatching { ccGet(settings, "/api/clips/$id") } }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        ScreenHeader("Clip", onBack)
        val r = clip
        when {
            r == null -> Loading()
            r.isFailure -> ErrorRetry(r.exceptionOrNull()?.message ?: "Couldn't load the clip") { reload++ }
            else -> {
                val c = r.getOrThrow()
                if (c.optBoolean("encrypted")) {
                    Hint("This clip was encrypted on the phone. Open it in the web app with your passphrase, or on the phone that recorded it.")
                } else {
                    // Re-created at a new position when a plate is tapped.
                    androidx.compose.runtime.key(seekTo) { VideoPlayer("${settings.ccUrl}/api/clips/$id/stream?st=${c.optString("streamToken")}", seekTo) }
                }
                Text("${c.optString("carName")} · ${c.optString("camera")}", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                Hint(listOfNotNull(dateTimeText(c.optLong("startedAt")), c.optString("place").takeIf { it.isNotBlank() && it != "null" },
                    durText(c.optLong("durationMs")), bytesText(c.optLong("size"))).joinToString(" · "))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    OutlinedButton(onClick = {
                        scope.launch {
                            val locked = !c.optBoolean("locked")
                            runCatching { ccSend(settings, "PATCH", "/api/clips/$id", JSONObject().put("locked", locked)) }
                                .onSuccess { Toast.makeText(context, if (locked) "Locked: kept by retention." else "Unlocked.", Toast.LENGTH_SHORT).show(); reload++ }
                                .onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                        }
                    }) { Text(if (c.optBoolean("locked")) "Unlock" else "Lock") }
                }
                ClipActions(settings, c, onDeleted = onBack, onSeek = { seekTo = (it - 1000).coerceAtLeast(0) })
            }
        }
    }
}

/** Streams a clip from the server, starting at an offset. */
@Composable
fun VideoPlayer(url: String, offsetMs: Long) {
    AndroidView(
        factory = { ctx ->
            VideoView(ctx).apply {
                setMediaController(android.widget.MediaController(ctx).also { it.setAnchorView(this) })
                setOnPreparedListener { mp -> if (offsetMs > 0) seekTo(offsetMs.toInt()); mp.start() }
                setOnErrorListener { _, _, _ ->
                    Toast.makeText(ctx, "Couldn't play the clip. In-app playback needs the server's main address to use a regular HTTPS certificate (or http).", Toast.LENGTH_LONG).show()
                    true
                }
                setVideoURI(Uri.parse(url))
            }
        },
        modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black),
    )
}

// ---------------------------------------------------------------- search

@Composable
private fun CcSearchScreen(settings: OdcSettings, onBack: () -> Unit, onOpenClip: (String) -> Unit, modifier: Modifier) {
    var text by rememberSaveable { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    val result by produceState<Result<JSONObject>?>(null, query) {
        value = if (query.isBlank()) null else runCatching { ccGet(settings, "/api/search?q=" + Uri.encode(query)) }
    }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Search", onBack)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(text, { text = it }, singleLine = true, placeholder = { Text("Place, “white pickup”, or a plate") }, modifier = Modifier.weight(1f))
            Button(onClick = { query = text.trim() }, modifier = Modifier.padding(start = 8.dp)) { Text("Search") }
        }
        val r = result
        when {
            query.isBlank() -> Hint("Search by place, car or camera name; by what's in the video (with smart search on the server); or by license plate (with plate reading on).")
            r == null -> Loading("Searching…")
            r.isFailure -> ErrorRetry(r.exceptionOrNull()?.message ?: "Search failed") { query = ""; query = text.trim() }
            else -> {
                val res = r.getOrThrow()
                val sections = listOf(
                    "License plates" to (res.optJSONArray("plates") ?: JSONArray()).objects(),
                    "In the video" to (res.optJSONArray("visual") ?: JSONArray()).objects(),
                    "Places, cars and cameras" to (res.optJSONArray("text") ?: JSONArray()).objects(),
                ).filter { it.second.isNotEmpty() }
                if (sections.isEmpty()) Hint("Nothing found.")
                LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    sections.forEach { (title, list) ->
                        item { Text(title, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp)) }
                        items(list, key = { title + it.optString("id") }) { c ->
                            Column {
                                ClipRow(settings, c) { onOpenClip(c.optString("id")) }
                                c.optString("plate").takeIf { it.isNotBlank() && it != "null" }?.let { Hint("Plate read as $it") }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- map

@Composable
private fun CcMapTab(settings: OdcSettings, onLive: (Long, String) -> Unit) {
    var cars by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var ready by remember { mutableStateOf(JSONObject()) }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    val mapRef = remember { mutableStateOf<Pair<MapLibreMap, Style>?>(null) }
    var fitted by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        while (isActive) {
            runCatching { cars = ccGetArray(settings, "/api/live").objects() }
            runCatching { ready = ccGet(settings, "/api/live-view-ready") }
            delay(10_000)
        }
    }
    LaunchedEffect(cars, mapRef.value) {
        val (map, style) = mapRef.value ?: return@LaunchedEffect
        val placed = cars.filter { it.optJSONObject("position") != null }
        (style.getSource("cars") as? GeoJsonSource)?.setGeoJson(FeatureCollection.fromFeatures(placed.map { c ->
            val p = c.getJSONObject("position")
            Feature.fromGeometry(Point.fromLngLat(p.getDouble("lon"), p.getDouble("lat"))).apply {
                addStringProperty("name", c.optString("name")); addNumberProperty("id", c.optLong("id")); addBooleanProperty("live", p.optBoolean("live"))
            }
        }))
        if (!fitted && placed.isNotEmpty()) {
            fitted = true
            if (placed.size == 1) {
                val p = placed[0].getJSONObject("position")
                map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(p.getDouble("lat"), p.getDouble("lon")), 14.0))
            } else {
                val b = LatLngBounds.Builder()
                placed.forEach { val p = it.getJSONObject("position"); b.include(LatLng(p.getDouble("lat"), p.getDouble("lon"))) }
                map.moveCamera(CameraUpdateFactory.newLatLngBounds(b.build(), 120))
            }
        }
    }
    Box(Modifier.fillMaxSize()) {
        OdcMap(Modifier.fillMaxSize()) { map, style ->
            style.addSource(GeoJsonSource("cars"))
            style.addLayer(CircleLayer("cars-dot", "cars").withProperties(
                PropertyFactory.circleRadius(10f),
                PropertyFactory.circleColor(Expression.switchCase(Expression.get("live"), Expression.color(android.graphics.Color.parseColor("#FF5A36")), Expression.color(android.graphics.Color.GRAY))),
                PropertyFactory.circleStrokeColor("#ffffff"), PropertyFactory.circleStrokeWidth(3f),
            ))
            style.addLayer(SymbolLayer("cars-name", "cars").withProperties(
                PropertyFactory.textField(Expression.get("name")), PropertyFactory.textOffset(arrayOf(0f, 1.6f)), PropertyFactory.textSize(13f),
                PropertyFactory.textHaloColor("#ffffff"), PropertyFactory.textHaloWidth(1.5f),
            ))
            map.addOnMapClickListener { at ->
                val f = map.queryRenderedFeatures(map.projection.toScreenLocation(at), "cars-dot").firstOrNull()
                selected = f?.getNumberProperty("id")?.toLong()?.let { id -> cars.firstOrNull { it.optLong("id") == id } }
                true
            }
            mapRef.value = map to style
        }
        if (cars.isNotEmpty() && cars.none { it.optJSONObject("position") != null }) {
            Hint("No positions yet. Cars appear here when a phone in them shares its location (recording with live location, or tracking-only mode).")
        }
        selected?.let { c ->
            val p = c.optJSONObject("position")
            Card(Modifier.align(Alignment.BottomCenter).padding(12.dp).fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(c.optString("name"), fontWeight = FontWeight.Bold)
                    if (p != null) Hint((if (p.optBoolean("live")) "Live · " + settings.formatSpeed(p.optDouble("speed", 0.0).toFloat()) else "Last seen ${dateTimeText(p.optLong("t"))}"))
                    Row {
                        if (ready.has(c.optString("id"))) Button(onClick = { onLive(c.optLong("id"), c.optString("name")) }) { Text("● Live view") }
                        TextButton(onClick = { selected = null }) { Text("Close") }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- trips

@Composable
private fun CcTripsTab(settings: OdcSettings, onOpenTrip: (Long) -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    val trips by produceState<Result<List<JSONObject>>?>(null, reload) { value = runCatching { ccGetArray(settings, "/api/trips").objects() } }
    val t = trips
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        when {
            t == null -> Loading()
            t.isFailure -> ErrorRetry(t.exceptionOrNull()?.message ?: "Couldn't load trips") { reload++ }
            t.getOrThrow().isEmpty() -> Hint("No trips yet. Trips are built from the GPS your cars' phones record.")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(t.getOrThrow(), key = { it.optLong("id") }) { trip ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable { onOpenTrip(trip.optLong("id")) }) {
                        Column(Modifier.padding(12.dp)) {
                            val name = trip.optString("displayName").takeIf { it.isNotBlank() && it != "null" }
                                ?: listOf(trip.optString("startPlace"), trip.optString("endPlace")).filter { it.isNotBlank() && it != "null" }.joinToString(" → ").ifBlank { "Trip" }
                            Text(name, fontWeight = FontWeight.Bold)
                            Hint("${trip.optString("carName")} · ${dateTimeText(trip.optLong("startT"))} · ${distText(settings, trip.optDouble("distanceM"))} · ${durText(trip.optLong("endT") - trip.optLong("startT"))}")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CcTripScreen(settings: OdcSettings, id: Long, onBack: () -> Unit, onOpenClip: (String) -> Unit, modifier: Modifier) {
    val trip by produceState<Result<JSONObject>?>(null, id) { value = runCatching { ccGet(settings, "/api/trips/$id") } }
    val mapRef = remember { mutableStateOf<Pair<MapLibreMap, Style>?>(null) }
    LaunchedEffect(trip, mapRef.value) {
        val (map, style) = mapRef.value ?: return@LaunchedEffect
        val tr = trip?.getOrNull() ?: return@LaunchedEffect
        val pts = tr.getJSONArray("route").objects().map { Point.fromLngLat(it.getDouble("lon"), it.getDouble("lat")) }
        if (pts.size < 2) return@LaunchedEffect
        (style.getSource("route") as? GeoJsonSource)?.setGeoJson(Feature.fromGeometry(LineString.fromLngLats(pts)))
        val events = (tr.optJSONArray("events") ?: JSONArray()).objects().mapNotNull { e ->
            val d = e.optJSONObject("data") ?: return@mapNotNull null
            if (!d.has("lat")) null else Feature.fromGeometry(Point.fromLngLat(d.getDouble("lon"), d.getDouble("lat")))
        }
        (style.getSource("events") as? GeoJsonSource)?.setGeoJson(FeatureCollection.fromFeatures(events))
        val b = LatLngBounds.Builder()
        pts.forEach { b.include(LatLng(it.latitude(), it.longitude())) }
        map.moveCamera(CameraUpdateFactory.newLatLngBounds(b.build(), 60))
    }
    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) { ScreenHeader("Trip", onBack) }
        val r = trip
        when {
            r == null -> Column(Modifier.padding(horizontal = 16.dp)) { Loading() }
            r.isFailure -> Column(Modifier.padding(horizontal = 16.dp)) { Text(r.exceptionOrNull()?.message ?: "Couldn't load the trip", color = MaterialTheme.colorScheme.error) }
            else -> {
                val tr = r.getOrThrow()
                OdcMap(Modifier.fillMaxWidth().height(280.dp)) { map, style ->
                    style.addSource(GeoJsonSource("route"))
                    style.addSource(GeoJsonSource("events"))
                    style.addLayer(LineLayer("route-line", "route").withProperties(PropertyFactory.lineColor("#FF5A36"), PropertyFactory.lineWidth(4f)))
                    style.addLayer(CircleLayer("event-dot", "events").withProperties(PropertyFactory.circleRadius(7f), PropertyFactory.circleColor("#FFC107"),
                        PropertyFactory.circleStrokeColor("#000000"), PropertyFactory.circleStrokeWidth(1.5f)))
                    mapRef.value = map to style
                }
                LazyColumn(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    item {
                        Text(tr.optString("displayName").takeIf { it.isNotBlank() && it != "null" } ?: "Trip", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
                        Hint("${tr.optString("carName")} · ${dateTimeText(tr.optLong("startT"))} – ${clockText(tr.optLong("endT"))} · ${distText(settings, tr.optDouble("distanceM"))}" +
                            (if (!tr.isNull("maxSpeed")) " · top ${settings.formatSpeed(tr.optDouble("maxSpeed").toFloat())}" else ""))
                    }
                    val events = (tr.optJSONArray("events") ?: JSONArray()).objects()
                    if (events.isNotEmpty()) {
                        item { Text("Events", fontWeight = FontWeight.Bold) }
                        items(events, key = { "e" + it.optLong("id") }) { e ->
                            val label = mapOf("hard_brake" to "Hard braking", "hard_accel" to "Hard acceleration", "sharp_turn" to "Sharp turn", "speeding" to "Speeding", "impact" to "Impact")[e.optString("type")] ?: e.optString("type")
                            Hint("${clockText(e.optLong("t"))} · $label" + (e.optJSONObject("data")?.optDouble("g")?.takeIf { !it.isNaN() }?.let { " · $it g" } ?: ""))
                        }
                    }
                    val clips = (tr.optJSONArray("clips") ?: JSONArray()).objects()
                    if (clips.isNotEmpty()) {
                        item { Text("Clips", fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp)) }
                        items(clips, key = { "c" + it.optString("id") }) { c -> ClipRow(settings, c) { onOpenClip(c.optString("id")) } }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- cars, cameras and pairing

@Composable
private fun CcCarsTab(settings: OdcSettings, onLive: (Long, String) -> Unit, onPhoneSettings: (String, String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    val cars by produceState<Result<List<JSONObject>>?>(null, reload) { value = runCatching { ccGetArray(settings, "/api/cars").objects() } }
    var pairing by remember { mutableStateOf<Pair<String, JSONObject>?>(null) } // car name, pairing response
    var newCar by remember { mutableStateOf<String?>(null) }
    val act: (suspend () -> Unit) -> Unit = { block ->
        scope.launch { runCatching { block() }.onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }; reload++ }
    }
    val c = cars
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        when {
            c == null -> Loading()
            c.isFailure -> ErrorRetry(c.exceptionOrNull()?.message ?: "Couldn't load cars") { reload++ }
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(c.getOrThrow(), key = { it.optLong("id") }) { car ->
                    val manage = car.optString("role") != "viewer"
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(car.optString("name"), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            val cams = (car.optJSONArray("cameras") ?: JSONArray()).objects()
                            if (cams.isEmpty()) Hint("No cameras yet.")
                            cams.forEach { cam ->
                                val remote = manage && cam.optString("kind") == "phone" && !cam.optBoolean("disconnected")
                                Row(
                                    Modifier.then(if (remote) Modifier.clickable { onPhoneSettings(cam.optString("id"), cam.optString("label")) } else Modifier),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(cam.optString("label") + if (cam.optBoolean("disconnected")) " (disconnected)" else "")
                                        Hint(listOfNotNull(
                                            if (cam.optBoolean("recording")) "● Recording" else null,
                                            if (!cam.isNull("battery")) "${cam.optInt("battery")}%" else null,
                                            if (cam.optLong("lastSeenAt") > 0) "seen ${dateTimeText(cam.optLong("lastSeenAt"))}" else null,
                                            if (cam.optInt("clips") > 0) "${cam.optInt("clips")} clips · ${bytesText(cam.optLong("bytes"))}" else null,
                                        ).joinToString(" · "))
                                        if (remote) Text("Settings ›", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                                    }
                                    if (manage && cam.optString("kind") == "phone" && !cam.optBoolean("disconnected")) {
                                        TextButton(onClick = {
                                            act { ccSend(settings, "DELETE", "/api/cameras/${cam.optString("id")}"); withContext(Dispatchers.Main) { Toast.makeText(context, "Disconnected. Its footage stays on the server.", Toast.LENGTH_LONG).show() } }
                                        }) { Text("Disconnect") }
                                    }
                                }
                            }
                            if (manage) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = { onLive(car.optLong("id"), car.optString("name")) }) { Text("● Live view") }
                                OutlinedButton(onClick = {
                                    act {
                                        val r = ccSend(settings, "POST", "/api/cars/${car.optLong("id")}/pairing", JSONObject().put("label", "Phone ${(car.optJSONArray("cameras")?.length() ?: 0) + 1}"))
                                        pairing = car.optString("name") to r
                                    }
                                }) { Text("Pair a phone") }
                            }
                        }
                    }
                }
                item { OutlinedButton(onClick = { newCar = "" }) { Text("Add a car") } }
            }
        }
    }
    pairing?.let { (carName, r) -> PairingDialog(carName, r) { pairing = null; reload++ } }
    newCar?.let { name ->
        AlertDialog(
            onDismissRequest = { newCar = null },
            title = { Text("Add a car") },
            text = { OutlinedTextField(name, { newCar = it }, singleLine = true, label = { Text("Name, e.g. Civic") }) },
            confirmButton = { TextButton(enabled = name.isNotBlank(), onClick = { act { ccSend(settings, "POST", "/api/cars", JSONObject().put("name", name.trim())) }; newCar = null }) { Text("Add") } },
            dismissButton = { TextButton(onClick = { newCar = null }) { Text("Cancel") } },
        )
    }
}

/** Shows the pairing QR code for an old phone to scan in ODC (Settings → ODC Server → Scan QR code). */
@Composable
private fun PairingDialog(carName: String, r: JSONObject, onDone: () -> Unit) {
    val qr = remember(r) {
        runCatching { BarcodeEncoder().encodeBitmap(r.getString("qr"), BarcodeFormat.QR_CODE, 720, 720).asImageBitmap() }.getOrNull()
    }
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Pair a phone with $carName") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("On the phone that will be the dashcam: open ODC → Settings → ODC Server → Scan QR code, and point it at this code.")
                qr?.let { Image(it, contentDescription = "Pairing QR code", modifier = Modifier.size(240.dp).background(Color.White).padding(8.dp)) }
                Text("Or enter the code: ${r.optString("code")}", fontWeight = FontWeight.Bold)
                Hint("Works once, for 10 minutes.")
            }
        },
        confirmButton = { TextButton(onClick = onDone) { Text("Done") } },
    )
}

// ---------------------------------------------------------------- live view

@Composable
private fun CcLiveViewScreen(settings: OdcSettings, carId: Long, name: String, onBack: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    var session by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var streams by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var status by remember { mutableStateOf("Waking the phone…") }
    LaunchedEffect(carId) {
        runCatching { ccSend(settings, "POST", "/api/cars/$carId/live-view", JSONObject().put("fps", 1)) }
            .onSuccess { session = it.getString("session") }
            .onFailure { error = it.message }
        val s = session ?: return@LaunchedEffect
        while (isActive) {
            val r = runCatching { ccGet(settings, "/api/live-view/$s") }.getOrNull()
            if (r == null) { status = "Live view ended."; break }
            streams = r.getJSONArray("streams").objects()
            val left = ((r.optLong("expiresAt") - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
            status = if (streams.isEmpty()) (r.optString("dashcamError").takeIf { it.isNotBlank() && it != "null" }?.let { "Dashcam stream: $it" } ?: "Waiting for the first picture…")
            else "● Live · ends in ${left / 60}:${String.format("%02d", left % 60)}"
            delay(1500)
        }
    }
    DisposableEffect(Unit) {
        onDispose { session?.let { s -> Thread { runCatching { CommandCenter.client(settings).call("DELETE", "/api/live-view/$s") } }.start() } }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ScreenHeader("$name · live", onBack)
        if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error) else Text(status)
        session?.let { s ->
            streams.forEach { st -> Column { MjpegView(settings, "/api/live-view/$s/stream?key=" + Uri.encode(st.optString("key"))); Hint(st.optString("label")) } }
            OutlinedButton(onClick = {
                Thread { runCatching { CommandCenter.client(settings).call("POST", "/api/live-view/$s/extend") } }.start()
                Toast.makeText(context, "Extended.", Toast.LENGTH_SHORT).show()
            }) { Text("Keep watching") }
        }
        Hint("Works while ODC is recording on a phone in this car with “Allow live view” on (or with a dashcam on your network). The phone shows a notification while you watch.")
    }
}

/** Shows an MJPEG stream (the live view), signed in with the app's key. */
@Composable
private fun MjpegView(settings: OdcSettings, path: String) {
    var frame by remember { mutableStateOf<ImageBitmap?>(null) }
    DisposableEffect(path) {
        val running = java.util.concurrent.atomic.AtomicBoolean(true)
        var conn: HttpURLConnection? = null
        val t = Thread {
            try {
                val c = URL(settings.ccUrl + path).openConnection() as HttpURLConnection
                conn = c
                org.opendashcam.backup.ServerConnection.applyPin(c, settings.ccPin.ifBlank { null })
                c.setRequestProperty("Authorization", "Bearer ${settings.ccToken}")
                c.connectTimeout = 15_000
                c.readTimeout = 30_000
                val input = java.io.BufferedInputStream(c.inputStream)
                while (running.get()) {
                    // Each part: headers (with Content-Length), a blank line, then the JPEG.
                    var len = -1
                    while (true) {
                        val line = readLine(input) ?: return@Thread
                        if (line.isEmpty() && len > 0) break
                        if (line.startsWith("Content-Length:", ignoreCase = true)) len = line.substringAfter(':').trim().toIntOrNull() ?: -1
                    }
                    val buf = ByteArray(len)
                    var off = 0
                    while (off < len) { val n = input.read(buf, off, len - off); if (n < 0) return@Thread; off += n }
                    BitmapFactory.decodeByteArray(buf, 0, len)?.let { frame = it.asImageBitmap() }
                }
            } catch (_: Exception) {
            } finally {
                conn?.disconnect()
            }
        }
        t.isDaemon = true
        t.start()
        onDispose { running.set(false); conn?.disconnect() }
    }
    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(8.dp)).background(Color.Black), contentAlignment = Alignment.Center) {
        frame?.let { Image(it, contentDescription = "Live picture", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
            ?: Text("…", color = Color.White)
    }
}

private fun readLine(input: java.io.InputStream): String? {
    val sb = StringBuilder()
    while (true) {
        val b = input.read()
        if (b < 0) return if (sb.isEmpty()) null else sb.toString()
        if (b == '\n'.code) return sb.toString().trimEnd('\r')
        sb.append(b.toChar())
    }
}
