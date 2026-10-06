@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package org.opendashcam.ui

import android.Manifest
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.opendashcam.backup.ServerException
import org.opendashcam.command.CommandCenter
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date

private val ALERT_LABELS = linkedMapOf(
    "impact" to "Impacts", "arrived" to "Arrivals", "left" to "Departures", "speeding" to "Speeding",
    "offline" to "Camera went offline", "overheating" to "Overheating", "battery_cutoff" to "Battery cutoff",
    "recording_stopped" to "Recording stopped", "mismatch" to "Cameras disagree", "storage" to "Storage",
    "live_view" to "Someone watching live", "summary" to "Weekly summary",
)

private fun whenText(t: Long) = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(t))

/** A photo from the server, loaded with the app's sign-in. */
@Composable
fun ServerImage(settings: OdcSettings, url: String?, modifier: Modifier, contentScale: ContentScale = ContentScale.Crop) {
    val img by produceState<ImageBitmap?>(null, url) {
        value = if (url.isNullOrBlank()) null else withContext(Dispatchers.IO) {
            try {
                val b = CommandCenter.client(settings).bytes(url)
                BitmapFactory.decodeByteArray(b, 0, b.size)?.asImageBitmap()
            } catch (_: Exception) { null }
        }
    }
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        img?.let { Image(it, contentDescription = "Alert photo", contentScale = contentScale, modifier = Modifier.fillMaxSize()) }
    }
}

// ---------------------------------------------------------------- sign in

@Composable
fun CcSignInScreen(settings: OdcSettings, onDone: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier, embedded: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(settings.ccUrl.ifBlank { settings.serverUrl }) }
    var user by remember { mutableStateOf(settings.ccUsername) }
    var pass by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var needCode by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // Embedded in first-run setup (which scrolls itself): no scrolling or padding of its own.
    val outer = if (embedded) modifier.fillMaxWidth() else modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)
    Column(outer, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (embedded) Text("Command Center", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) else ScreenHeader("Command Center", onBack)
        Text("Manage your ODC Server from this phone and get its alerts (impacts with their photo, arrivals, speeding and more). Sign in with your ODC Server account.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(url, { url = it }, label = { Text("Server address") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
        if (needCode) {
            OutlinedTextField(code, { code = it }, label = { Text("Two-factor code (or a recovery code)") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(enabled = !busy && url.isNotBlank() && user.isNotBlank() && pass.isNotBlank(), onClick = {
            busy = true
            error = null
            scope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { CommandCenter.signIn(context, url, user, pass, code.ifBlank { null }) } }
                busy = false
                r.onSuccess {
                    if (Build.VERSION.SDK_INT >= 33) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                    onDone()
                }.onFailure { e ->
                    if (e is ServerException && e.totpRequired) { needCode = true; error = if (code.isBlank()) "Enter the code from your authenticator app." else e.message }
                    else error = e.message ?: "Couldn't sign in"
                }
            }
        }) { Text(if (busy) "Signing in…" else "Sign in") }
        Hint("This phone appears in the server's Signed-in devices, where it can be signed out at any time.")
    }
}

// ---------------------------------------------------------------- one alert, and its clip

@Composable
fun CcAlertScreen(settings: OdcSettings, eventId: Long, notificationId: Long, onBack: () -> Unit, onPlay: (String, Long, String) -> Unit, modifier: Modifier = Modifier) {
    var reload by remember { mutableIntStateOf(0) }
    val info by produceState<Result<JSONObject>?>(null, eventId, reload) {
        value = withContext(Dispatchers.IO) {
            runCatching {
                val c = CommandCenter.client(settings)
                if (notificationId != 0L) runCatching { c.call("POST", "/api/me/notifications/read", JSONObject().put("ids", JSONArray().put(notificationId))) }
                if (eventId == 0L) JSONObject() else c.call("GET", "/api/events/$eventId/clip")
            }
        }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        ScreenHeader("Alert", onBack)
        val r = info
        when {
            r == null -> Text("Loading…")
            r.isFailure -> { Text(r.exceptionOrNull()?.message ?: "Couldn't load this alert.", color = MaterialTheme.colorScheme.error); TextButton(onClick = { reload++ }) { Text("Retry") } }
            eventId == 0L -> Hint("This alert has no footage linked to it.")
            else -> {
                val e = r.getOrThrow()
                val label = ALERT_LABELS[e.optString("type")]?.removeSuffix("s") ?: e.optString("type")
                Text(label, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Hint(whenText(e.optLong("t")) + (e.optJSONObject("data")?.optString("message")?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""))
                e.optString("snapshotUrl").takeIf { it.isNotBlank() && it != "null" }?.let { url ->
                    ServerImage(settings, url, Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(10.dp)), ContentScale.Fit)
                }
                val clips = e.optJSONArray("clips") ?: JSONArray()
                if (clips.length() == 0) {
                    Text("The clip isn't on the server yet. It appears once the phone uploads it (right away with “Upload impact and locked clips over cellular” on, otherwise on Wi-Fi).",
                        style = MaterialTheme.typography.bodyMedium)
                    OutlinedButton(onClick = { reload++ }) { Text("Check again") }
                } else {
                    for (i in 0 until clips.length()) {
                        val c = clips.getJSONObject(i)
                        val stream = c.optString("streamUrl").takeIf { it.isNotBlank() && it != "null" }
                        Button(enabled = stream != null, onClick = { onPlay(stream!!, c.optLong("offsetMs"), "${c.optString("camera")} · $label") }) {
                            Text(if (stream == null) "${c.optString("camera")} (encrypted)" else "Play ${c.optString("camera")} from that moment")
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun CcPlayerScreen(url: String, offsetMs: Long, title: String, onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        ScreenHeader(title, onBack)
        AndroidView(
            factory = { ctx ->
                VideoView(ctx).apply {
                    setMediaController(android.widget.MediaController(ctx).also { it.setAnchorView(this) })
                    setOnPreparedListener { mp -> seekTo((offsetMs - 2000).coerceAtLeast(0).toInt()); mp.start() }
                    setOnErrorListener { _, _, _ ->
                        Toast.makeText(ctx, "Couldn't play the clip. In-app playback needs the server's main address to use a regular HTTPS certificate (or http).", Toast.LENGTH_LONG).show()
                        true
                    }
                    setVideoURI(Uri.parse(url))
                }
            },
            modifier = Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black),
        )
        Hint("Starts just before the moment of the alert.")
    }
}

// ---------------------------------------------------------------- settings

@Composable
fun CcSettingsScreen(settings: OdcSettings, onBack: () -> Unit, onSignedOut: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var version by remember { mutableIntStateOf(0) }
    val prefs by produceState<JSONObject?>(null) {
        value = withContext(Dispatchers.IO) { runCatching { CommandCenter.client(settings).call("GET", "/api/me").optJSONObject("prefs") ?: JSONObject() }.getOrNull() }
    }
    var alerts by remember(prefs) { mutableStateOf(prefs?.optJSONObject("alerts") ?: JSONObject()) }
    val distributors = remember { CommandCenter.distributors(context) }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ScreenHeader("Command Center settings", onBack)
        key(version) {
            Hint("Signed in to ${settings.ccUrl} as ${settings.ccUsername}.")
            SwitchRow(
                title = "Open the app in Command Center",
                checked = settings.ccDefault,
                onChange = { on -> settings.ccDefault = on; version++ },
                subtitle = "Off: the app opens in Dashcam Mode (recording), and Command Center is a tap away.",
            )
            SectionHeader("How alerts reach this phone")
            ChoiceRow(
                title = "Delivery",
                options = listOf("unifiedpush", "direct", "off"),
                selected = settings.ccDelivery,
                label = { mapOf("unifiedpush" to "UnifiedPush", "direct" to "Direct connection", "off" to "Off")[it]!! },
                onSelect = { v ->
                    if (v == "unifiedpush" && distributors.isEmpty()) {
                        Toast.makeText(context, "Install a UnifiedPush distributor app first, such as ntfy (Google Play or F-Droid).", Toast.LENGTH_LONG).show()
                    } else {
                        settings.ccDelivery = v
                        CommandCenter.stopDelivery(context)
                        CommandCenter.startDelivery(context)
                        version++
                    }
                },
                subtitle = when (settings.ccDelivery) {
                    "unifiedpush" -> "Through ${distributors.firstOrNull() ?: "a distributor app"}: instant and battery-friendly, without Google services."
                    "direct" -> "ODC keeps its own connection to your server (with a quiet notification). Works with nothing else installed; uses a little more battery."
                    else -> "No alerts on this phone. You can still see them in Command Center."
                },
            )
            OutlinedButton(onClick = {
                scope.launch {
                    val r = withContext(Dispatchers.IO) { runCatching { CommandCenter.client(settings).call("POST", "/api/me/notifications/test") } }
                    Toast.makeText(context, if (r.isSuccess) "Test alert sent. It should appear in a moment." else (r.exceptionOrNull()?.message ?: "Couldn't send"), Toast.LENGTH_LONG).show()
                }
            }) { Text("Send a test alert") }
            SectionHeader("Alerts I get")
            Hint("For your account, on every phone and browser you use.")
            if (prefs == null) Hint("Loading…")
            ALERT_LABELS.forEach { (kind, label) ->
                SwitchRow(title = label, checked = alerts.optBoolean(kind, true), onChange = { on ->
                    val next = JSONObject(alerts.toString()).put(kind, on)
                    alerts = next
                    scope.launch(Dispatchers.IO) { runCatching { CommandCenter.client(settings).call("PUT", "/api/me/prefs", JSONObject().put("alerts", next)) } }
                })
            }
            SectionHeader("Account")
            OutlinedButton(onClick = {
                scope.launch {
                    withContext(Dispatchers.IO) { CommandCenter.signOut(context) }
                    onSignedOut()
                }
            }) { Text("Sign out of Command Center") }
        }
    }
}
