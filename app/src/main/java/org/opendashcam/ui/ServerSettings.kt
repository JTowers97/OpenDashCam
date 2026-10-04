package org.opendashcam.ui

import android.os.Build
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opendashcam.AppVersion
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.backup.ServerClient
import org.opendashcam.backup.ServerReporter
import org.opendashcam.settings.OdcSettings
import org.opendashcam.tracking.TrackingService
import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.text.DateFormat
import java.util.Date

private val SERVER_FEATURES = listOf(
    "Synced playback of all of a car's cameras (coming soon)",
    "Trips with routes, distance and speeds",
    "Live map of where each car is",
    "Browsing footage from any browser, shared with family",
    "Smart search (coming later)",
)

/** Settings → ODC Server: pair, status, options, unpair. */
@Composable
fun ServerSection(settings: OdcSettings, onChanged: () -> Unit, onOpenServerClips: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showManual by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }
    var checkResult by remember { mutableStateOf<String?>(null) }

    fun pair(url: String, code: String, label: String?, home: String? = null, fp: String? = null) {
        busy = true
        error = null
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                try {
                    val p = ServerClient(url, null, fp).pair(code, label, "${Build.MANUFACTURER} ${Build.MODEL}", AppVersion.full)
                    settings.serverUrl = url.trim().trimEnd('/')
                    settings.serverToken = p.token
                    settings.serverHomeUrl = home.orEmpty()
                    settings.serverCertPin = fp.orEmpty()
                    // Paired by hand: learn the home address and certificate from the server over this connection.
                    try {
                        val me = ServerClient(settings.serverUrl, p.token, fp).me()
                        if (home == null) settings.serverHomeUrl = me.optString("homeUrl").takeIf { it.isNotBlank() && it != "null" }.orEmpty()
                        if (fp == null) settings.serverCertPin = me.optString("certFingerprint")
                    } catch (_: Exception) {
                    }
                    org.opendashcam.backup.ServerConnection.reset()
                    settings.serverCameraId = p.cameraId
                    settings.serverCarName = p.carName
                    settings.serverCameraLabel = p.label
                    settings.serverUploadEnabled = true
                    null
                } catch (e: Exception) {
                    e.message ?: e.javaClass.simpleName
                }
            }
            busy = false
            if (result == null) {
                Toast.makeText(context, "Connected to ${settings.serverCarName}.", Toast.LENGTH_LONG).show()
                BackupScheduler.kick(context, replace = true)
                onChanged()
            } else {
                error = "Pairing failed: $result"
            }
        }
    }

    val scanner = rememberLauncherForScan { text ->
        val parsed = text?.let { ServerClient.parseQr(it) }
        if (parsed == null) {
            if (text != null) error = "That QR code isn't an ODC pairing code."
        } else {
            pair(parsed.url, parsed.code, null, parsed.homeUrl, parsed.fingerprint)
        }
    }

    if (!settings.serverPaired) {
        Hint("Connect this phone to your self-hosted ODC Server to back up footage there and use the server's features:")
        SERVER_FEATURES.forEach { Hint("• $it") }
        Hint("Everything else works without a server.")
        Text("Tracking-only mode", style = MaterialTheme.typography.bodyLarge)
        Hint("Reports the car's position and speed to your ODC Server in the background without recording. Available once this phone is connected to a server.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = !busy, onClick = {
                scanner.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt("Scan the pairing code from the ODC Server (Cars → Connect a phone)")
                        .setBeepEnabled(false)
                        .setOrientationLocked(false)
                )
            }) { Text(if (busy) "Connecting…" else "Scan pairing code") }
            OutlinedButton(enabled = !busy, onClick = { showManual = true }) { Text("Enter code") }
        }
    } else {
        Text("Connected to ${settings.serverCarName} · ${settings.serverCameraLabel}", style = MaterialTheme.typography.bodyLarge)
        Hint(settings.serverUrl)
        if (settings.serverHomeUrl.isNotBlank()) Hint("At home: ${settings.serverHomeUrl} (used automatically on your home Wi-Fi)")
        listOfNotNull(
            org.opendashcam.backup.ServerConnection.warning(settings.serverUrl),
            org.opendashcam.backup.ServerConnection.warning(settings.serverHomeUrl).takeIf { settings.serverHomeUrl.isNotBlank() },
        ).distinct().forEach { w ->
            Text("⚠ $w", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        }
        val last = ServerReporter.lastContactAt
        if (last > 0) Hint("Last contact: " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(last)))
        ServerReporter.lastError?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        SwitchRow(
            title = "Back up footage to the server",
            checked = settings.serverUploadEnabled,
            onChange = { on -> settings.serverUploadEnabled = on; BackupScheduler.kick(context, replace = true); onChanged() },
            subtitle = "Clips are sent over the connection above. Clips you encrypted on the phone stay encrypted on the server.",
        )
        SwitchRow(
            title = "Share live location with the server",
            checked = settings.serverLiveEnabled,
            onChange = { on -> settings.serverLiveEnabled = on; onChanged() },
            subtitle = if (settings.gpsEnabled) "Every 5 seconds while recording. Never inside privacy zones."
            else "Needs GPS logging (Settings → Location).",
        )
        TrackingControls(settings, onChanged)
        Hint("What gets uploaded and when is set under Backup rules below.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onOpenServerClips) { Text("Clips on the server") }
            OutlinedButton(enabled = !busy, onClick = {
                busy = true
                scope.launch {
                    checkResult = withContext(Dispatchers.IO) {
                        try {
                            val client = ServerClient.forSettings(context, settings)
                            val me = client.me()
                            me.optString("certFingerprint").takeIf { it.isNotBlank() }?.let { settings.serverCertPin = it }
                            me.optString("homeUrl").takeIf { it.isNotBlank() && it != "null" }?.let { settings.serverHomeUrl = it }
                            "✓ ${me.optString("serverName")} ${me.optString("serverVersion")} · ${me.optString("carName")} · ${me.optString("label")} · via " +
                                org.opendashcam.backup.ServerConnection.baseUrl(context, settings)
                        } catch (e: Exception) {
                            "✗ ${e.message ?: e.javaClass.simpleName}"
                        }
                    }
                    busy = false
                }
            }) { Text("Check connection") }
        }
        checkResult?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        TextButton(onClick = { confirmUnpair = true }) { Text("Disconnect from server") }
    }
    error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

    if (showManual) {
        ManualPairDialog(onDismiss = { showManual = false }) { url, code, label ->
            showManual = false
            pair(url, code, label)
        }
    }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Disconnect from the server?") },
            text = { Text("This phone stops uploading and sharing its location. Footage already on the server stays there. To also remove this phone on the server, use Cars → Disconnect in the web app.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmUnpair = false
                    TrackingService.stop(context)
                    settings.clearServer()
                    BackupScheduler.kick(context, replace = true)
                    onChanged()
                }) { Text("Disconnect") }
            },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun rememberLauncherForScan(onResult: (String?) -> Unit) =
    androidx.activity.compose.rememberLauncherForActivityResult(ScanContract()) { result -> onResult(result.contents) }

@Composable
private fun ManualPairDialog(onDismiss: () -> Unit, onPair: (String, String, String?) -> Unit) {
    var url by remember { mutableStateOf("https://") }
    var code by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Connect to an ODC Server") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("On the server: Cars → Connect a phone shows the address and an 8-character code.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(value = url, onValueChange = { url = it.trim() }, label = { Text("Server address") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = code, onValueChange = { code = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(8) }, label = { Text("Pairing code") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(value = label, onValueChange = { label = it.take(40) }, label = { Text("Camera name (optional)") }, placeholder = { Text("e.g. Front, Rear") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = url.length > 8 && code.length == 8, onClick = { onPair(url, code, label.ifBlank { null }) }) { Text("Connect") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}


/** Settings for tracking-only mode (shown once a server is paired). */
@Composable
private fun TrackingControls(settings: OdcSettings, onChanged: () -> Unit) {
    val context = LocalContext.current
    val tracking by TrackingService.state.collectAsStateWithLifecycle()
    fun enable() {
        settings.trackingEnabled = true
        TrackingService.start(context)
        onChanged()
    }
    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (TrackingService.hasLocationPermission(context)) enable()
        else Toast.makeText(context, "Tracking needs precise location access.", Toast.LENGTH_LONG).show()
    }
    val backgroundLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        settings.trackingAfterRestart = ok
        if (!ok) Toast.makeText(context, "Without \"Allow all the time\", open ODC once after a restart to resume tracking.", Toast.LENGTH_LONG).show()
        onChanged()
    }

    SwitchRow(
        title = "Tracking-only mode",
        checked = settings.trackingEnabled && TrackingService.hasLocationPermission(context),
        onChange = { on ->
            if (!on) {
                settings.trackingEnabled = false
                TrackingService.stop(context)
                onChanged()
            } else if (TrackingService.hasLocationPermission(context)) {
                enable()
            } else {
                locationLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            }
        },
        subtitle = "Reports the car's position and speed to the server in the background, without recording. " +
            "Keeps running after you leave ODC (with a notification). Uses GPS while the car moves; almost no battery while parked. " +
            "Pauses while ODC is recording, and never logs inside privacy zones. Positions are saved on the phone and sent later if there's no connection.",
    )
    if (settings.trackingEnabled) {
        ChoiceRow(
            title = "Update every",
            options = listOf(5, 10, 30, 60),
            selected = settings.trackingIntervalSec,
            label = { "$it s" },
            onSelect = { sec ->
                settings.trackingIntervalSec = sec
                TrackingService.stop(context)
                TrackingService.start(context)
                onChanged()
            },
            subtitle = "While driving. More often gives a smoother route on the map but uses more battery and data.",
        )
        SwitchRow(
            title = "Keep tracking after the phone restarts",
            checked = settings.trackingAfterRestart && TrackingService.hasBackgroundPermission(context),
            onChange = { on ->
                if (!on) {
                    settings.trackingAfterRestart = false
                    onChanged()
                } else if (TrackingService.hasBackgroundPermission(context)) {
                    settings.trackingAfterRestart = true
                    onChanged()
                } else {
                    backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                }
            },
            subtitle = "Needs location access set to \"Allow all the time\" (Android will ask). Otherwise, open ODC once after a restart.",
        )
        val status = when {
            !tracking.active -> "Not running. Open ODC to start it."
            tracking.pausedForRecording -> "Paused while ODC is recording."
            tracking.lastError != null -> tracking.lastError!!
            tracking.lastSentAt > 0 -> "Running · last sent " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(tracking.lastSentAt)) +
                if (tracking.queued > 0) " · ${tracking.queued} points waiting" else ""
            else -> "Running · waiting for the car to move."
        }
        Hint(status)
    }
}
