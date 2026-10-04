package org.opendashcam.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.opendashcam.AppVersion
import org.opendashcam.recording.RecordingService
import org.opendashcam.tracking.TrackingService
import org.opendashcam.settings.CameraMode
import org.opendashcam.settings.DisplayMode
import org.opendashcam.settings.OdcSettings

private const val WAKE_MS = 10_000L
private const val DIM_BRIGHTNESS = 0.01f

@Composable
fun HomeScreen(
    settings: OdcSettings,
    autoStartRequests: Int,
    onOpenSettings: () -> Unit,
    onOpenClips: () -> Unit,
    onOpenParking: () -> Unit = {},
) {
    val context = LocalContext.current
    val activity = context as? Activity
    val state by RecordingService.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    val active = state.active
    val dimMode = settings.displayMode == DisplayMode.DIM
    var awake by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var cameraGranted by remember { mutableStateOf(granted(context, Manifest.permission.CAMERA)) }

    LaunchedEffect(awake) {
        if (awake) {
            delay(WAKE_MS)
            awake = false
        }
    }
    LaunchedEffect(state.status) {
        if (state.status != RecordingService.Status.IDLE) starting = false
    }

    // Keep the screen on (at minimum brightness) while recording in dimmed mode.
    DisposableEffect(active, awake, dimMode) {
        val window = activity?.window
        if (window != null) {
            if (active && dimMode) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            val lp = window.attributes
            lp.screenBrightness = if (active && dimMode && !awake) DIM_BRIGHTNESS
            else WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            window.attributes = lp
        }
        onDispose {
            activity?.window?.let { w ->
                w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                val lp = w.attributes
                lp.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
                w.attributes = lp
            }
        }
    }

    fun beginRecording() {
        starting = true
        scope.launch {
            delay(400) // let the preview release the camera first
            RecordingService.start(context)
            delay(8_000)
            starting = false
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        cameraGranted = granted(context, Manifest.permission.CAMERA)
        if (cameraGranted) beginRecording()
    }

    fun onStartTapped() {
        val needed = buildList {
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
            if (settings.audioEnabled) add(Manifest.permission.RECORD_AUDIO)
            if (settings.gpsEnabled) add(Manifest.permission.ACCESS_FINE_LOCATION)
        }.filter { !granted(context, it) }
        if (needed.isEmpty()) beginRecording() else permissionLauncher.launch(needed.toTypedArray())
    }

    // Opened by auto-start (charging or car Bluetooth): start right away.
    LaunchedEffect(autoStartRequests) {
        if (autoStartRequests > 0 && !RecordingService.state.value.active && !starting) onStartTapped()
    }

    Box(Modifier.fillMaxSize()) {
        // Landscape layout: preview on the left, status and controls on the right.
        Row(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(
                Modifier
                    .weight(1.25f)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color.Black),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    !active && !starting && cameraGranted ->
                        CameraPreview(useFront = settings.cameraMode == CameraMode.FRONT)
                    active -> Text("Recording · preview off to save power", color = Color.White)
                    starting -> Text("Starting…", color = Color.White)
                    else -> Text("Camera permission needed", color = Color.White)
                }
            }

            Column(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text("Open Dash Cam", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(
                        "  v${AppVersion.full}",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                StatusCard(state)

                Button(
                    onClick = { if (active) RecordingService.stop(context) else onStartTapped() },
                    enabled = !starting || active,
                    modifier = Modifier.fillMaxWidth().height(56.dp),
                    colors = if (active) ButtonDefaults.buttonColors(containerColor = OdcRed, contentColor = Color.White)
                    else ButtonDefaults.buttonColors(),
                ) {
                    Text(if (active) "Stop recording" else "Start recording", fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }

                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = onOpenClips, modifier = Modifier.weight(1f)) { Text("Clips") }
                    OutlinedButton(onClick = onOpenSettings, modifier = Modifier.weight(1f)) { Text("Settings") }
                }
                if (!active && parkingSpot(settings) != null) {
                    TextButton(onClick = onOpenParking) { Text("Where I parked") }
                }

                val tracking by TrackingService.state.collectAsStateWithLifecycle()
                if (tracking.active && !active) {
                    Text(
                        "Tracking-only mode is on: reporting the car's location to your ODC Server in the background." +
                            if (tracking.queued > 0) " ${tracking.queued} points waiting to send." else "",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (!isIgnoringBatteryOptimizations(context)) {
                    Text(
                        "Battery optimization is on for ODC. Android may stop recording in the background. " +
                            "Run setup again from Settings to fix this.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                if (active && !dimMode) {
                    Text(
                        "Screen-off mode: you can turn the screen off; recording continues.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // Dimmed recording overlay: pure black (near-zero power on OLED), tap to wake for 10 s.
        if (active && dimMode && !awake) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black)
                    .clickable(
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { awake = true },
            ) {
                Row(
                    Modifier.align(Alignment.TopEnd).safeDrawingPadding().padding(16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val dotColor = if (state.status == RecordingService.Status.RECORDING) Color(0xFF7A1A12) else Color(0xFF3A3A3A)
                    Box(Modifier.size(8.dp).clip(CircleShape).background(dotColor))
                    Spacer(Modifier.width(6.dp))
                    Text("REC", color = Color(0xFF3A3A3A), fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun StatusCard(state: RecordingService.State) {
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            val statusColor = when (state.status) {
                RecordingService.Status.RECORDING -> OdcRed
                RecordingService.Status.ERROR -> MaterialTheme.colorScheme.error
                else -> MaterialTheme.colorScheme.onSurface
            }
            Text(
                if (state.status == RecordingService.Status.RECORDING) "● Recording · ${state.mode.label}" else state.status.label,
                color = statusColor, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium,
            )
            state.streams.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
            state.message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            state.notes.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (state.active) {
                state.speed?.let { Text(it, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold) }
                state.privacyZone?.let { Text("In privacy zone: $it (location not logged)", style = MaterialTheme.typography.bodySmall) }
                val events = buildList {
                    if (state.motionEvents > 0) add("${state.motionEvents} motion events")
                    if (state.impacts > 0) add("${state.impacts} impacts")
                }
                if (events.isNotEmpty()) Text(events.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = OdcAccent)
                val battery = if (state.batteryPct >= 0) "${state.batteryPct}%${if (state.charging) " · charging" else ""}" else "unknown"
                Text("Battery: $battery · Clips this session: ${state.segments}", style = MaterialTheme.typography.bodySmall)
                if (state.thermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
                    Text("Phone is warm (thermal level ${state.thermalStatus})", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}

internal fun granted(context: Context, permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

internal fun isIgnoringBatteryOptimizations(context: Context): Boolean =
    context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(context.packageName)
