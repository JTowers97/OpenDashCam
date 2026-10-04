package org.opendashcam.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.opendashcam.AppVersion
import org.opendashcam.camera.CameraCapabilities
import org.opendashcam.settings.OdcSettings

private const val STEPS = 5

@Composable
fun OnboardingScreen(settings: OdcSettings, onFinished: (customize: Boolean) -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    val context = LocalContext.current
    var cameraGranted by remember { mutableStateOf(granted(context, Manifest.permission.CAMERA)) }

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Step ${step + 1} of $STEPS", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        when (step) {
            0 -> WelcomeStep()
            1 -> PermissionsStep(cameraGranted) { cameraGranted = it }
            2 -> BatteryStep()
            3 -> DeviceCheckStep()
            else -> FinishStep(settings, onFinished)
        }
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth()) {
            if (step > 0) TextButton(onClick = { step-- }) { Text("Back") }
            Spacer(Modifier.weight(1f))
            if (step < STEPS - 1) {
                Button(onClick = { step++ }, enabled = step != 1 || cameraGranted) { Text("Next") }
            }
        }
    }
}

@Composable
private fun Title(text: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
}

@Composable
private fun Body(text: String) {
    Text(text, style = MaterialTheme.typography.bodyLarge)
}

@Composable
private fun WelcomeStep() {
    Title("Welcome to Open Dash Cam")
    Hint("Version ${AppVersion.full}")
    Body("ODC turns this phone into a dashcam. It records in short clips, replaces the oldest footage when storage fills up, and switches to a battery-saving parking mode when the car is turned off.")
    Body("Setup takes about a minute: permissions, battery settings, a quick check of what your cameras can do, then you choose defaults or customize.")
    Hint("ODC is free, open-source software (GPLv3). It sends nothing anywhere unless you set up a backup destination.")
}

@Composable
private fun PermissionsStep(cameraGranted: Boolean, onResult: (Boolean) -> Unit) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        onResult(granted(context, Manifest.permission.CAMERA))
    }
    val notifGranted = Build.VERSION.SDK_INT < 33 || granted(context, Manifest.permission.POST_NOTIFICATIONS)

    Title("Permissions")
    Body("Camera: required to record.")
    Body("Notifications: shows recording status and alerts for low storage, low battery and overheating.")
    Hint("Microphone, location and Bluetooth are only requested if you turn on audio, GPS logging or auto-start in Settings.")
    Button(onClick = {
        val perms = buildList {
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        launcher.launch(perms.toTypedArray())
    }) { Text("Grant permissions") }
    Text("Camera: ${if (cameraGranted) "✓ granted" else "not granted"}")
    Text("Notifications: ${if (notifGranted) "✓ granted" else "not granted"}")
}

@SuppressLint("BatteryLife")
@Composable
private fun BatteryStep() {
    val context = LocalContext.current
    var ignoring by remember { mutableStateOf(isIgnoringBatteryOptimizations(context)) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        ignoring = isIgnoringBatteryOptimizations(context)
    }
    val maker = Build.MANUFACTURER.lowercase()

    Title("Keep ODC running")
    Body("Android's battery optimization can stop recording without warning. Allow ODC to run unrestricted so it keeps recording with the screen dimmed or off.")
    Button(onClick = {
        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        try {
            launcher.launch(intent)
        } catch (_: Exception) {
            launcher.launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }, enabled = !ignoring) { Text(if (ignoring) "✓ Unrestricted" else "Allow unrestricted battery use") }

    if (maker in listOf("samsung", "xiaomi", "oneplus", "huawei", "oppo", "vivo", "realme", "honor", "meizu", "asus", "sony", "nokia")) {
        Body("${Build.MANUFACTURER} phones have extra battery managers that can still close ODC. dontkillmyapp.com has step-by-step instructions for your phone.")
        OutlinedButton(onClick = {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dontkillmyapp.com/$maker")))
            } catch (_: Exception) {
            }
        }) { Text("Open instructions for ${Build.MANUFACTURER}") }
    }
}

@Composable
private fun DeviceCheckStep() {
    val context = LocalContext.current
    val caps = remember { CameraCapabilities(context) }

    Title("Your phone's cameras")
    caps.rear?.let { rear ->
        Body("Rear camera: " + caps.supportedHeights(rear).joinToString(", ") { CameraCapabilities.heightLabel(it) }.ifEmpty { "limited" })
    } ?: Body("Rear camera: not found")
    caps.front?.let { front ->
        Body("Front camera: " + caps.supportedHeights(front).joinToString(", ") { CameraCapabilities.heightLabel(it) }.ifEmpty { "limited" })
    } ?: Body("Front camera: not found")
    Body("Front and rear at the same time: ${if (caps.supportsDual) "✓ supported" else "not supported"}")
    Body("H.265 (smaller files): ${if (caps.hevcEncoder) "✓ supported" else "not supported, H.264 will be used"}")
    var showTest by remember { mutableStateOf(false) }
    Body("Screen-off recording: " + screenOffStatus(org.opendashcam.settings.OdcSettings(context)))
    Hint("Some phones stop recording with the screen off. ODC starts in dimmed-screen mode; you can test screen-off now or any time later in Settings.")
    OutlinedButton(onClick = { showTest = true }) { Text("Test screen-off recording now") }
    if (showTest) ScreenOffTestDialog { showTest = false }
}

@Composable
private fun FinishStep(settings: OdcSettings, onFinished: (customize: Boolean) -> Unit) {
    val context = LocalContext.current
    Title("Almost done")
    Body("Recommended defaults: rear camera, 1080p at 30 fps, H.265, 3-minute clips, dimmed screen, audio off, continuous parking mode at 720p/24 fps, stop at 15% battery, overheating protection on.")
    Hint("Off until you turn them on in Settings: GPS and speed logging, impact detection, motion or time-lapse parking, and auto-start.")
    Hint("ODC Server pairing arrives in a later release. Without a server you'll miss synced multi-camera playback, trips, the live map and smart search. Everything else works on the phone alone.")
    Button(onClick = {
        settings.applyRecommendedDefaults(CameraCapabilities(context))
        settings.onboardingDone = true
        onFinished(false)
    }, modifier = Modifier.fillMaxWidth()) { Text("Use recommended defaults") }
    OutlinedButton(onClick = {
        settings.applyRecommendedDefaults(CameraCapabilities(context))
        settings.onboardingDone = true
        onFinished(true)
    }, modifier = Modifier.fillMaxWidth()) { Text("Customize settings") }
}
