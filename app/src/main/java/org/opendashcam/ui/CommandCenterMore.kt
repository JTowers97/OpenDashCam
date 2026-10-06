@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package org.opendashcam.ui

import android.content.ContentValues
import android.content.Intent
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
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
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.opendashcam.command.CommandCenter
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date

private suspend fun get(settings: OdcSettings, path: String) = withContext(Dispatchers.IO) { CommandCenter.client(settings).call("GET", path) }
private suspend fun getArray(settings: OdcSettings, path: String) = withContext(Dispatchers.IO) { CommandCenter.client(settings).callArray("GET", path) }
private suspend fun send(settings: OdcSettings, method: String, path: String, body: JSONObject? = null) =
    withContext(Dispatchers.IO) { CommandCenter.client(settings).call(method, path, body) }
private fun JSONArray.list(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
private fun stamp(t: Long) = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(t))
private fun JSONObject.str(k: String) = optString(k).takeIf { it.isNotBlank() && it != "null" }

/** Waits for a background job on the server (blurring, reports), reporting progress. */
private suspend fun waitForJob(settings: OdcSettings, id: String, onProgress: (Float, String) -> Unit): JSONObject {
    while (true) {
        val j = get(settings, "/api/jobs/$id")
        onProgress(j.optDouble("progress", 0.0).toFloat(), j.optString("step"))
        if (j.optString("status") == "done" || j.optString("status") == "failed") return j
        delay(1500)
    }
}

// ---------------------------------------------------------------- More

@Composable
internal fun CcMoreScreen(settings: OdcSettings, onBack: () -> Unit, onCcSettings: () -> Unit, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val me by produceState<JSONObject?>(null) { value = runCatching { get(settings, "/api/me") }.getOrNull() }
    val plateLog = me?.optJSONObject("settings")?.optBoolean("plateLog") == true
    val admin = me?.optBoolean("isAdmin") == true
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ScreenHeader("More", onBack)
        @Composable
        fun entry(title: String, sub: String, onClick: () -> Unit) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable(onClick = onClick)) {
                Column(Modifier.padding(14.dp)) { Text(title, fontWeight = FontWeight.Bold); Hint(sub) }
            }
        }
        entry("Command Center settings", "Alerts on this phone, alert types, opening the app in Command Center, sign out", onCcSettings)
        if (plateLog) entry("License plate log", "Plates your cameras have read, and where they were seen") { onOpen("plates") }
        entry("Background work", "What the server and its ML container are working on: blurring, reports, imports, footage analysis") { onOpen("background") }
        entry("Shared links", "Links to clips you've shared, and turning them off") { onOpen("shares") }
        entry("Signed-in devices", "Browsers and phones signed in to your account") { onOpen("sessions") }
        if (admin) {
            entry("People", "Accounts on this server") { onOpen("people") }
            entry("Server settings", "Retention, storage, alerts, smart search, license plates and more") { onOpen("server") }
        }
        Hint("Signed in to ${settings.ccUrl} as ${settings.ccUsername}.")
    }
}

// ---------------------------------------------------------------- a dashcam phone's settings (remote)

@Composable
internal fun CcPhoneSettingsScreen(settings: OdcSettings, cameraId: String, label: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    androidx.compose.runtime.LaunchedEffect(reload) {
        runCatching { get(settings, "/api/cameras/$cameraId/settings") }.onSuccess { data = it; error = null }.onFailure { error = it.message }
    }
    val change: (String, Any) -> Unit = { key, value ->
        scope.launch {
            runCatching { send(settings, "PUT", "/api/cameras/$cameraId/settings", JSONObject().put("changes", JSONObject().put(key, value))) }
                .onSuccess { data = it }
                .onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
        }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        ScreenHeader("$label settings", onBack)
        val d = data
        when {
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
            d == null -> Hint("Loading…")
            d.isNull("reported") -> Hint("This phone hasn't reported its settings yet. It does when it next checks in: while recording or tracking, when ODC is opened on it, or when it backs up. Update it to ODC 2.0 if it's older.")
            else -> {
                val reported = d.getJSONObject("reported")
                val pending = d.optJSONObject("pending")
                Hint("As reported ${stamp(d.optLong("reportedAt"))}. Changes reach the phone the next time it checks in; it shows a notification when they do. Recording settings take effect the next time it starts recording.")
                if (pending != null && pending.length() > 0) Text("Waiting for the phone: ${pending.length()} change${if (pending.length() == 1) "" else "s"}", color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 4.dp))
                var lastGroup = ""
                d.getJSONArray("spec").list().forEach { s ->
                    val key = s.getString("key")
                    if (s.optString("group") != lastGroup) { lastGroup = s.optString("group"); SectionHeader(lastGroup) }
                    val value = if (pending?.has(key) == true) pending.get(key) else reported.opt(key)
                    val note = listOfNotNull(s.str("note"), if (pending?.has(key) == true) "Waiting for the phone" else null).joinToString(" · ").ifBlank { null }
                    if (s.optString("type") == "bool") {
                        SwitchRow(title = s.optString("label"), checked = value == true, onChange = { change(key, it) }, subtitle = note)
                    } else {
                        val options = s.getJSONArray("options")
                        val values = (0 until options.length()).map { options.getJSONArray(it).getInt(0) }
                        val labels = (0 until options.length()).associate { options.getJSONArray(it).getInt(0) to options.getJSONArray(it).getString(1) }
                        ChoiceRow(title = s.optString("label"), options = values, selected = (value as? Number)?.toInt() ?: -1,
                            label = { labels[it] ?: "$it" }, onSelect = { change(key, it) }, subtitle = note)
                    }
                }
                TextButton(onClick = { reload++ }) { Text("Refresh") }
            }
        }
    }
}

// ---------------------------------------------------------------- clip actions: share, report, plates, delete

@Composable
internal fun ClipActions(settings: OdcSettings, clip: JSONObject, onDeleted: () -> Unit, onSeek: (Long) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var dialog by remember { mutableStateOf<String?>(null) }
    var progress by remember { mutableStateOf<Pair<Float, String>?>(null) }
    val id = clip.optString("id")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedButton(onClick = { dialog = "share" }) { Text("Share link") }
        OutlinedButton(onClick = { dialog = "report" }) { Text("Incident report") }
        OutlinedButton(onClick = { dialog = "plates" }) { Text("Plates") }
        OutlinedButton(onClick = { dialog = "delete" }) { Text("Delete") }
    }
    progress?.let { (p, step) ->
        Column(Modifier.padding(vertical = 6.dp)) { Hint(step.ifBlank { "Working…" }); LinearProgressIndicator(progress = { p }, modifier = Modifier.fillMaxWidth()) }
    }
    when (dialog) {
        "share" -> {
            var hours by remember { mutableIntStateOf(24) }
            var download by remember { mutableStateOf(false) }
            var plates by remember { mutableStateOf(false) }
            var faces by remember { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("Share this clip") },
                text = {
                    Column {
                        Hint("Anyone with the link can watch it until it expires, without an account. It doesn't show the car's name or location.")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf(1 to "1 hour", 24 to "1 day", 168 to "7 days", 720 to "30 days").forEach { (h, l) -> FilterChip(selected = hours == h, onClick = { hours = h }, label = { Text(l) }) }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(download, { download = it }); Text("Allow download") }
                        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(plates, { plates = it }); Text("Blur license plates") }
                        Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(faces, { faces = it }); Text("Blur faces") }
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        dialog = null
                        scope.launch {
                            runCatching {
                                val r = send(settings, "POST", "/api/clips/$id/share", JSONObject().put("expiresHours", hours).put("allowDownload", download).put("blurPlates", plates).put("blurFaces", faces))
                                r.str("jobId")?.let { job ->
                                    val j = waitForJob(settings, job) { p, s -> progress = p to s }
                                    progress = null
                                    if (j.optString("status") != "done") throw Exception("Couldn't prepare the video: ${j.optString("error")}")
                                }
                                r.getString("url")
                            }.onSuccess { url ->
                                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, url)
                                context.startActivity(Intent.createChooser(send, "Share the link"))
                                if (plates || faces) Toast.makeText(context, "Watch it before sending: automatic blurring can miss things.", Toast.LENGTH_LONG).show()
                            }.onFailure { progress = null; Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("Create link") }
                },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
            )
        }
        "report" -> {
            var note by remember { mutableStateOf("") }
            AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("Incident report") },
                text = {
                    Column {
                        Hint("One ZIP with every camera's footage from a minute before to a minute after this clip's start, a route map, a speed graph, events and your notes. Saved to Downloads on this phone.")
                        OutlinedTextField(note, { note = it }, label = { Text("Notes (optional)") }, minLines = 3, modifier = Modifier.fillMaxWidth())
                    }
                },
                confirmButton = {
                    TextButton(onClick = {
                        dialog = null
                        scope.launch {
                            runCatching {
                                val r = send(settings, "POST", "/api/reports", JSONObject().put("carId", clip.optLong("carId")).put("t", clip.optLong("startedAt") + 30_000)
                                    .put("beforeS", 60).put("afterS", 60).put("note", note).put("units", if (settings.resolvedSpeedUnit == org.opendashcam.settings.SpeedUnit.MPH) "mph" else "kmh"))
                                val job = r.getString("jobId")
                                val j = waitForJob(settings, job) { p, s -> progress = p * 0.8f to s }
                                if (j.optString("status") != "done") throw Exception(j.optString("error"))
                                progress = 0.85f to "Saving to Downloads"
                                val name = j.optJSONObject("result")?.optString("name") ?: "incident-report.zip"
                                withContext(Dispatchers.IO) {
                                    val values = ContentValues().apply {
                                        put(MediaStore.Downloads.DISPLAY_NAME, name)
                                        put(MediaStore.Downloads.MIME_TYPE, "application/zip")
                                    }
                                    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Exception("Couldn't save to Downloads")
                                    context.contentResolver.openOutputStream(uri)!!.use { out -> CommandCenter.client(settings).downloadTo("/api/reports/$job/download", out) }
                                }
                                name
                            }.onSuccess { name -> progress = null; Toast.makeText(context, "Saved $name to Downloads.", Toast.LENGTH_LONG).show() }
                                .onFailure { progress = null; Toast.makeText(context, "Couldn't make the report: ${it.message}", Toast.LENGTH_LONG).show() }
                        }
                    }) { Text("Make report") }
                },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
            )
        }
        "plates" -> {
            val r by produceState<Result<JSONObject>?>(null) { value = runCatching { get(settings, "/api/clips/$id/plates") } }
            AlertDialog(
                onDismissRequest = { dialog = null },
                title = { Text("Plates in this clip") },
                text = {
                    val res = r
                    when {
                        res == null -> Hint("Loading…")
                        res.isFailure -> Text(res.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
                        else -> {
                            val reads = res.getOrThrow().getJSONArray("reads").list()
                            if (reads.isEmpty()) Hint(if (res.getOrThrow().optBoolean("analyzed")) "No plates were read in this clip." else "This clip hasn't been checked for plates yet.")
                            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                items(reads, key = { it.optLong("id") }) { p ->
                                    Row(Modifier.fillMaxWidth().clickable { dialog = null; onSeek(p.optLong("offsetMs")) }, verticalAlignment = Alignment.CenterVertically) {
                                        ServerImage(settings, p.optString("cropUrl"), Modifier.width(96.dp).height(40.dp).clip(RoundedCornerShape(4.dp)))
                                        Column(Modifier.padding(start = 8.dp)) {
                                            Text(p.optString("plate"), fontWeight = FontWeight.Bold)
                                            Hint("at ${p.optLong("offsetMs") / 1000} s · ${(p.optDouble("confidence") * 100).toInt()}% sure")
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                confirmButton = { TextButton(onClick = { dialog = null }) { Text("Close") } },
            )
        }
        "delete" -> AlertDialog(
            onDismissRequest = { dialog = null },
            title = { Text("Delete this clip?") },
            text = { Text("It's removed from the server for everyone. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    dialog = null
                    scope.launch {
                        runCatching { send(settings, "DELETE", "/api/clips/$id") }
                            .onSuccess { Toast.makeText(context, "Deleted.", Toast.LENGTH_SHORT).show(); onDeleted() }
                            .onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                    }
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------- license plates

@Composable
internal fun CcPlateLogScreen(settings: OdcSettings, onBack: () -> Unit, onOpenPlate: (String) -> Unit, modifier: Modifier = Modifier) {
    var q by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    val rows by produceState<Result<List<JSONObject>>?>(null, query) { value = runCatching { getArray(settings, "/api/plates?limit=200&q=" + android.net.Uri.encode(query)).list() } }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("License plate log", onBack)
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(q, { q = it }, singleLine = true, placeholder = { Text("Plate or note") }, modifier = Modifier.weight(1f))
            Button(onClick = { query = q.trim() }, modifier = Modifier.padding(start = 8.dp)) { Text("Find") }
        }
        val r = rows
        when {
            r == null -> Hint("Loading…")
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            r.getOrThrow().isEmpty() -> Hint("No plates.")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
                items(r.getOrThrow(), key = { it.optString("plate") }) { p ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable { onOpenPlate(p.optString("plate")) }) {
                        Column(Modifier.padding(12.dp)) {
                            Text(p.optString("plate"), fontWeight = FontWeight.Bold)
                            Hint("${p.optInt("sightings")} sightings on ${p.optInt("days")} day${if (p.optInt("days") == 1) "" else "s"} · last ${stamp(p.optLong("last"))}" + (p.str("note")?.let { " · $it" } ?: ""))
                        }
                    }
                }
            }
        }
    }
}

@Composable
internal fun CcPlateScreen(settings: OdcSettings, plate: String, onBack: () -> Unit, onOpenClip: (String) -> Unit, modifier: Modifier = Modifier) {
    val r by produceState<Result<JSONObject>?>(null, plate) { value = runCatching { get(settings, "/api/plates/" + android.net.Uri.encode(plate)) } }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader(plate, onBack)
        val res = r
        when {
            res == null -> Hint("Loading…")
            res.isFailure -> Text(res.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            else -> {
                val d = res.getOrThrow()
                d.str("note")?.let { Hint("Note: $it") }
                LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 6.dp)) {
                    items(d.getJSONArray("reads").list(), key = { it.optLong("id") }) { s ->
                        Row(Modifier.fillMaxWidth().clickable { onOpenClip(s.optString("clipId")) }, verticalAlignment = Alignment.CenterVertically) {
                            ServerImage(settings, "/api/plates/reads/${s.optLong("id")}/crop", Modifier.width(96.dp).height(40.dp).clip(RoundedCornerShape(4.dp)))
                            Column(Modifier.padding(start = 8.dp)) {
                                Text(stamp(s.optLong("t")))
                                Hint(listOfNotNull(s.str("carName"), s.str("camera"), s.str("place")).joinToString(" · "))
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- background work

@Composable
internal fun CcBackgroundScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    var data by remember { mutableStateOf<Result<JSONObject>?>(null) }
    androidx.compose.runtime.LaunchedEffect(Unit) {
        while (true) { data = runCatching { get(settings, "/api/background") }; delay(3000) }
    }
    val kinds = mapOf("share" to "Share link", "report" to "Incident report", "import" to "Memory card import")
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ScreenHeader("Background work", onBack)
        val r = data
        when {
            r == null -> Hint("Loading…")
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            else -> {
                val d = r.getOrThrow()
                SectionHeader("Jobs")
                val jobs = d.getJSONArray("jobs").list()
                if (jobs.isEmpty()) Hint("Nothing running. Share links with blurring, incident reports and memory card imports show here.")
                jobs.forEach { j ->
                    Column(Modifier.padding(vertical = 4.dp)) {
                        val status = when (j.optString("status")) {
                            "queued" -> "Waiting (" + (if (j.optInt("queuePosition") == 1) "next" else "${j.optInt("queuePosition")} in line") + ")"
                            "running" -> "${(j.optDouble("progress") * 100).toInt()}%"
                            "done" -> "Done"
                            else -> "Failed"
                        }
                        Text((j.str("title") ?: kinds[j.optString("kind")] ?: j.optString("kind")) + " · " + status, fontWeight = FontWeight.Bold)
                        if (j.optString("status") == "running") {
                            LinearProgressIndicator(progress = { j.optDouble("progress").toFloat() }, modifier = Modifier.fillMaxWidth())
                            Hint(j.optString("step"))
                        }
                        j.str("error")?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    }
                }
                SectionHeader("ML container")
                val ml = d.optJSONObject("ml")
                when {
                    ml == null -> Hint("Not set up (smart search, plate reading and blurring need the optional ML container).")
                    !ml.optBoolean("reachable") -> Text("Can't reach the ML container. Check that it's running.", color = MaterialTheme.colorScheme.error)
                    else -> {
                        val blur = (ml.optJSONArray("blur") ?: JSONArray()).list()
                        Text("Right now: " + (ml.str("busy")?.let { "$it (${ml.optInt("busySeconds")} s)" } ?: if (blur.any { it.optString("status") == "running" }) "Blurring" else "Idle"))
                        blur.forEachIndexed { i, b ->
                            Hint((if (b.optString("status") == "running") "Blurring ${(b.optDouble("progress") * 100).toInt()}%" else "Waiting to blur ($i ahead)") + ": " + (b.str("src") ?: "a clip"))
                        }
                    }
                }
                SectionHeader("Footage analysis")
                val ix = d.getJSONObject("indexing")
                listOf("smartSearch" to ("Smart search" to "analyzed"), "plates" to ("License plates" to "read")).forEach { (k, l) ->
                    val x = ix.getJSONObject(k)
                    Text("${l.first}: " + when { !x.optBoolean("on") -> "off"; x.optInt("waiting") > 0 -> "${x.optInt("waiting")} clips waiting to be ${l.second}"; else -> "up to date" })
                    x.str("lastError")?.let { Text("Last problem: $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                }
                val viofo = d.getJSONArray("viofo").list()
                if (viofo.isNotEmpty()) {
                    SectionHeader("Dashcam imports")
                    viofo.forEach { v -> Hint("${v.optString("car")}: ${v.optString("message")}") }
                }
                val errors = d.getJSONArray("errors").list()
                if (errors.isNotEmpty()) {
                    SectionHeader("Recent unexpected errors")
                    Hint("The server kept running. They're also in data/logs/errors.log; include them when reporting a problem.")
                    errors.forEach { e -> Text("${stamp(e.optLong("t"))} · ${e.optString("where")}: ${e.optString("message")}", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- shared links

@Composable
internal fun CcSharesScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    val rows by produceState<Result<List<JSONObject>>?>(null, reload) { value = runCatching { getArray(settings, "/api/shares").list() } }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Shared links", onBack)
        val r = rows
        when {
            r == null -> Hint("Loading…")
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            r.getOrThrow().isEmpty() -> Hint("No active links. Share a clip from its page.")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(r.getOrThrow(), key = { it.optString("token") }) { s ->
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(s.optString("clipName"), fontWeight = FontWeight.Bold)
                            Hint("Expires ${stamp(s.optLong("expiresAt"))} · ${s.optInt("views")} views" +
                                listOfNotNull(if (s.optBoolean("blurPlates")) "plates blurred" else null, if (s.optBoolean("blurFaces")) "faces blurred" else null).joinToString("") { " · $it" })
                            TextButton(onClick = { scope.launch { runCatching { send(settings, "DELETE", "/api/shares/${s.optString("token")}") }; reload++ } }) { Text("Turn off") }
                        }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- signed-in devices

@Composable
internal fun CcSessionsScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    val rows by produceState<Result<List<JSONObject>>?>(null, reload) { value = runCatching { getArray(settings, "/api/me/sessions").list() } }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("Signed-in devices", onBack)
        val r = rows
        when {
            r == null -> Hint("Loading…")
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(r.getOrThrow(), key = { it.optString("id") }) { s ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text((s.str("userAgent") ?: "Unknown").take(80) + if (s.optBoolean("current")) " (this phone)" else "")
                            Hint("Last used ${stamp(s.optLong("lastUsedAt"))}" + (s.str("ip")?.let { " · $it" } ?: ""))
                        }
                        if (!s.optBoolean("current")) TextButton(onClick = { scope.launch { runCatching { send(settings, "DELETE", "/api/me/sessions/${s.optString("id")}") }; reload++ } }) { Text("Sign out") }
                    }
                }
                item {
                    OutlinedButton(onClick = { scope.launch { runCatching { send(settings, "POST", "/api/me/sessions/sign-out-others") }; reload++ } }) { Text("Sign out everywhere else") }
                }
            }
        }
    }
}

// ---------------------------------------------------------------- people (admins)

@Composable
internal fun CcPeopleScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    val rows by produceState<Result<List<JSONObject>>?>(null, reload) { value = runCatching { getArray(settings, "/api/users").list() } }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader("People", onBack)
        val r = rows
        when {
            r == null -> Hint("Loading…")
            r.isFailure -> Text(r.exceptionOrNull()?.message ?: "Couldn't load", color = MaterialTheme.colorScheme.error)
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(r.getOrThrow(), key = { it.optLong("id") }) { p ->
                    Column {
                        Text(p.optString("username") + if (p.optBoolean("isAdmin")) " · admin" else "", fontWeight = FontWeight.Bold)
                        Hint(if (p.optBoolean("totpEnabled")) "Two-factor sign-in on" else "Two-factor sign-in off")
                    }
                }
                item { OutlinedButton(onClick = { adding = true }) { Text("Add a person") } }
                item { Hint("Share cars with people from the web app (Cars → the car → Share).") }
            }
        }
    }
    if (adding) {
        var name by remember { mutableStateOf("") }
        var pass by remember { mutableStateOf("") }
        var admin by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { adding = false },
            title = { Text("Add a person") },
            text = {
                Column {
                    OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Username") })
                    OutlinedTextField(pass, { pass = it }, singleLine = true, label = { Text("Temporary password (10+ characters)") })
                    Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(admin, { admin = it }); Text("Admin (manages the server)") }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    scope.launch {
                        runCatching { send(settings, "POST", "/api/users", JSONObject().put("username", name.trim()).put("password", pass).put("isAdmin", admin)) }
                            .onSuccess { adding = false; reload++ }
                            .onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
                    }
                }) { Text("Add") }
            },
            dismissButton = { TextButton(onClick = { adding = false }) { Text("Cancel") } },
        )
    }
}

// ---------------------------------------------------------------- server settings (admins)

private data class ServerField(val key: String, val label: String, val type: String, val options: List<Pair<String, String>> = emptyList(), val note: String? = null)

private val SERVER_FIELDS = listOf(
    "General" to listOf(
        ServerField("serverName", "Server name", "text"),
        ServerField("units", "Units", "choice", listOf("kmh" to "km/h, km", "mph" to "mph, mi")),
        ServerField("offlineAlertMin", "Alert when a camera goes quiet for (minutes, 0 = off)", "number"),
    ),
    "Storage" to listOf(
        ServerField("storageCapGb", "Storage limit (GB, 0 = no limit)", "number", note = "Oldest unlocked footage is removed to stay under it."),
        ServerField("retentionDays", "Keep footage for (days, 0 = forever)", "number"),
        ServerField("backupEnabled", "Daily database backups", "bool"),
    ),
    "Driving" to listOf(
        ServerField("drivingEvents", "Driving events (hard braking, sharp turns)", "bool"),
        ServerField("drivingSensitivity", "Driving event sensitivity", "choice", listOf("low" to "Low", "normal" to "Normal", "high" to "High")),
        ServerField("commuteLearning", "Learn regular trips (names like “Home → Work”)", "bool"),
    ),
    "Smart search and plates" to listOf(
        ServerField("smartSearch", "Smart search (what's in the video)", "bool", note = "Needs the optional ML container."),
        ServerField("plateSearch", "License plate reading", "bool", note = "Check the laws where you live before turning this on."),
        ServerField("plateLog", "License plate log", "bool"),
        ServerField("plateRetentionDays", "Keep plate readings for (days, 0 = forever)", "number"),
    ),
    "Security" to listOf(
        ServerField("httpsOnly", "HTTPS only", "bool", note = "Only turn on when the server is reached over HTTPS."),
        ServerField("auditRetentionDays", "Keep the activity log for (days)", "number"),
    ),
    "Alerts" to listOf(
        ServerField("ntfyUrl", "ntfy topic URL", "text", note = "Optional: alerts to an ntfy topic, shared by the whole server."),
    ),
)

@Composable
internal fun CcServerSettingsScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var data by remember { mutableStateOf<JSONObject?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    androidx.compose.runtime.LaunchedEffect(Unit) { runCatching { get(settings, "/api/settings") }.onSuccess { data = it }.onFailure { error = it.message } }
    val save: (String, Any) -> Unit = { key, value ->
        scope.launch {
            runCatching { send(settings, "PUT", "/api/settings", JSONObject().put(key, value)) }
                .onSuccess { data = it; Toast.makeText(context, "Saved.", Toast.LENGTH_SHORT).show() }
                .onFailure { Toast.makeText(context, it.message, Toast.LENGTH_LONG).show() }
        }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        ScreenHeader("Server settings", onBack)
        val d = data
        when {
            error != null -> Text(error!!, color = MaterialTheme.colorScheme.error)
            d == null -> Hint("Loading…")
            else -> {
                SERVER_FIELDS.forEach { (group, fields) ->
                    SectionHeader(group)
                    fields.forEach { f ->
                        when (f.type) {
                            "bool" -> SwitchRow(title = f.label, checked = d.optBoolean(f.key), onChange = { save(f.key, it) }, subtitle = f.note)
                            "choice" -> ChoiceRow(title = f.label, options = f.options.map { it.first }, selected = d.optString(f.key),
                                label = { k -> f.options.firstOrNull { it.first == k }?.second ?: k }, onSelect = { save(f.key, it) }, subtitle = f.note)
                            else -> {
                                var text by remember(d) { mutableStateOf(if (d.isNull(f.key)) "" else d.opt(f.key).toString()) }
                                Column(Modifier.padding(vertical = 4.dp)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        OutlinedTextField(text, { text = it }, singleLine = true, label = { Text(f.label) }, modifier = Modifier.weight(1f))
                                        TextButton(onClick = { save(f.key, if (f.type == "number") (text.toDoubleOrNull() ?: 0.0) else text.trim()) }) { Text("Save") }
                                    }
                                    f.note?.let { Hint(it) }
                                }
                            }
                        }
                    }
                }
                Hint("More server settings (Home Assistant, Viofo, backups, HTTPS) are in the web app.")
            }
        }
    }
}
