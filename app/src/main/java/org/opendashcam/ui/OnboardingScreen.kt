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

/** How this phone will be used: chooses which setup steps follow. */
private enum class Use { DASHCAM, COMMAND, BOTH }

@Composable
fun OnboardingScreen(settings: OdcSettings, onFinished: (customize: Boolean) -> Unit) {
    var use by rememberSaveable { mutableStateOf<Use?>(null) }
    var step by rememberSaveable { mutableIntStateOf(0) }
    val context = LocalContext.current
    var cameraGranted by remember { mutableStateOf(granted(context, Manifest.permission.CAMERA)) }
    var signedIn by remember { mutableStateOf(settings.ccSignedIn) }
    val dashcam = use == Use.DASHCAM || use == Use.BOTH
    val command = use == Use.COMMAND || use == Use.BOTH
    // The steps for this use of the phone.
    val steps = buildList {
        add("use")
        if (dashcam) addAll(listOf("permissions", "battery", "device", "features", "backup"))
        if (use == Use.DASHCAM) add("dashcam-only")
        if (command) addAll(listOf("signin", "alerts"))
        add("finish")
    }
    val current = steps.getOrElse(step) { "finish" }

    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (step > 0) Text("Step ${step + 1} of ${steps.size}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        when (current) {
            "use" -> UseStep(use) { choice ->
                use = choice
                if (choice != Use.COMMAND) settings.applyRecommendedDefaults(CameraCapabilities(context))
                if (choice == Use.DASHCAM) settings.dashcamOnly = true
                if (choice != Use.DASHCAM) settings.dashcamOnly = false
            }
            "permissions" -> PermissionsStep(cameraGranted) { cameraGranted = it }
            "battery" -> BatteryStep()
            "device" -> DeviceCheckStep()
            "features" -> FeaturesStep(settings)
            "backup" -> BackupStep(settings)
            "dashcam-only" -> DashcamOnlyStep(settings)
            "signin" -> if (signedIn) {
                Title("Command Center")
                Body("Signed in to ${settings.ccUrl} as ${settings.ccUsername}.")
            } else {
                CcSignInScreen(settings, onDone = { signedIn = true; step++ }, onBack = { step-- }, embedded = true)
                TextButton(onClick = { step++ }) { Text("Skip for now (set it up later in Settings → Command Center)") }
            }
            "alerts" -> AlertsStep(settings, signedIn)
            else -> FinishStep(settings, use ?: Use.DASHCAM, signedIn, onFinished)
        }
        Spacer(Modifier.height(8.dp))
        if (current != "signin" || signedIn) {
            Row(Modifier.fillMaxWidth()) {
                if (step > 0) TextButton(onClick = { step-- }) { Text("Back") }
                Spacer(Modifier.weight(1f))
                if (current != "finish") {
                    Button(onClick = { step++ }, enabled = when (current) { "use" -> use != null; "permissions" -> cameraGranted; else -> true }) { Text("Next") }
                }
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
private fun UseStep(use: Use?, onChoose: (Use) -> Unit) {
    Title("Welcome to Open Dash Cam")
    Hint("Version ${AppVersion.full}")
    Body("How will you use this phone?")
    @Composable
    fun option(value: Use, title: String, text: String) {
        val selected = use == value
        androidx.compose.material3.Card(
            onClick = { onChoose(value) },
            colors = androidx.compose.material3.CardDefaults.cardColors(
                containerColor = if (selected) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceVariant,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(14.dp)) {
                Text((if (selected) "● " else "") + title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Hint(text)
            }
        }
    }
    option(Use.DASHCAM, "As a dashcam", "Records in short clips, replaces the oldest footage when storage fills up, with parking mode, impact detection and backup to your ODC Server or a network share. Ideal for a phone that lives in the car.")
    option(Use.COMMAND, "To manage my ODC Server", "Command Center: your cars' alerts (impacts with their photo), footage, map, trips, live view and settings, on your everyday phone. Needs an ODC Server.")
    option(Use.BOTH, "Both", "Records when it's in the car, and manages your server the rest of the time.")
    Hint("ODC is free, open-source software (GPLv3). It sends nothing anywhere unless you set up a backup destination or sign in to your ODC Server.")
}

/** The main recording features, ready to switch on (each can be changed later in Settings → Dashcam Mode). */
@Composable
private fun FeaturesStep(settings: OdcSettings) {
    val context = LocalContext.current
    var version by remember { mutableIntStateOf(0) }
    val location = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        settings.gpsEnabled = r.values.any { it }
        version++
    }
    Title("Features")
    Body("Recommended settings are in place: 1080p at 30 fps, 3-minute clips, parking mode, stop at 15% battery, overheating protection. Turn on what you'd like:")
    androidx.compose.runtime.key(version) {
        SwitchRow("Date/time stamp", settings.overlayEnabled, { settings.overlayEnabled = it; version++ }, "Burned into the video, with speed if GPS logging is on.")
        SwitchRow("GPS and speed logging", settings.gpsEnabled, { on ->
            if (on && !granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
                location.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            } else { settings.gpsEnabled = on; version++ }
        }, "Where and how fast you were, for maps, trips and the stamp. Asks for location access.")
        SwitchRow("Impact detection", settings.impactEnabled, { settings.impactEnabled = it; version++ }, "Locks the clips around a sudden jolt so they're never replaced.")
        SwitchRow("Spoken feedback", settings.spokenFeedback, { settings.spokenFeedback = it; version++ }, "Says “Recording started”, “Parking mode” and so on, so you don't need to look at the phone.")
        SwitchRow("Start recording when charging starts", settings.autoStartCharging, { settings.autoStartCharging = it; version++ }, "For a phone plugged into the car. Auto-start with Bluetooth is in Settings.")
    }
    Hint("Audio recording, privacy zones and more are in Settings → Dashcam Mode.")
}

/** Backup: pair with the ODC Server now (scan its QR code), or later. */
@Composable
private fun BackupStep(settings: OdcSettings) {
    var version by remember { mutableIntStateOf(0) }
    Title("Backup")
    Body("Your ODC Server keeps your footage safe off the phone, with maps, trips, alerts and Command Center. In the server's web app, open Cars → Connect a phone, then scan its QR code here.")
    androidx.compose.runtime.key(version) {
        ServerSection(settings, onChanged = { version++ }, onOpenServerClips = {})
        if (settings.serverPaired) {
            SwitchRow("Upload impact and locked clips over mobile data", settings.backupEventsOnMobile, { settings.backupEventsOnMobile = it; version++ },
                "So they reach the server right away, even away from Wi-Fi. Other clips wait for Wi-Fi.")
        }
    }
    Hint("No server? Footage stays on the phone, and you can back up to a network (SMB) share in Settings → Backup. You can also skip this and set it up later.")
}

@Composable
private fun DashcamOnlyStep(settings: OdcSettings) {
    var on by remember { mutableStateOf(settings.dashcamOnly) }
    Title("Dashcam only?")
    Body("If this phone lives in the car, keep Command Center hidden on it: it never holds a sign-in to your ODC Server account, so it's safe if the car or the phone goes missing.")
    SwitchRow("Dashcam only", on, { on = it; settings.dashcamOnly = it }, "You can change this in Settings → App.")
}

/** How Command Center's alerts reach this phone. */
@Composable
private fun AlertsStep(settings: OdcSettings, signedIn: Boolean) {
    val context = LocalContext.current
    var delivery by remember { mutableStateOf(settings.ccDelivery) }
    Title("Alerts on this phone")
    if (!signedIn) {
        Body("Sign in to Command Center to get alerts. You can do that later in Settings → Command Center.")
        return
    }
    Body("Impacts (with their photo), arrivals, speeding and more arrive as notifications. Choose how they get here:")
    val distributors = remember { org.opendashcam.command.CommandCenter.distributors(context) }
    @Composable
    fun option(value: String, title: String, text: String) {
        androidx.compose.material3.Card(
            onClick = {
                delivery = value
                settings.ccDelivery = value
                org.opendashcam.command.CommandCenter.stopDelivery(context)
                org.opendashcam.command.CommandCenter.startDelivery(context)
            },
            colors = androidx.compose.material3.CardDefaults.cardColors(
                containerColor = if (delivery == value) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surfaceVariant,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) { Column(Modifier.padding(14.dp)) { Text((if (delivery == value) "● " else "") + title, fontWeight = FontWeight.Bold); Hint(text) } }
    }
    option("unifiedpush", "UnifiedPush (recommended)", if (distributors.isNotEmpty()) "Through ${distributors.first()}: instant and battery-friendly, without Google services."
        else "Instant and battery-friendly, without Google services. Needs a free distributor app such as ntfy.")
    if (distributors.isEmpty() && delivery == "unifiedpush") {
        OutlinedButton(onClick = {
            runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=io.heckel.ntfy"))) }
        }) { Text("Install ntfy from Google Play") }
        Hint("After installing it, come back here and choose UnifiedPush again.")
    }
    option("direct", "Direct connection", "ODC keeps its own connection to your server, with a quiet notification. Works with nothing else installed; uses a little more battery.")
    Hint("Choose which alerts you get in Command Center → More → Command Center settings.")
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
private fun FinishStep(settings: OdcSettings, use: Use, signedIn: Boolean, onFinished: (customize: Boolean) -> Unit) {
    var mode by remember { mutableStateOf(if (use == Use.COMMAND) "command" else "dashcam") }
    Title("All set")
    when (use) {
        Use.DASHCAM -> Body("Tap the record button to start, or let auto-start do it. Everything can be changed in Settings.")
        Use.COMMAND -> Body(if (signedIn) "Command Center opens now. Dashcam Mode is still a tap away if you ever want this phone to record."
            else "Sign in to Command Center from Settings → Command Center when you're ready.")
        Use.BOTH -> {
            Body("Which mode should the app open in?")
            listOf("dashcam" to "Dashcam Mode (recording)", "command" to "Command Center").forEach { (k, l) ->
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    androidx.compose.material3.RadioButton(selected = mode == k, onClick = { mode = k }, enabled = k == "dashcam" || signedIn)
                    Text(l)
                }
            }
        }
    }
    Button(onClick = {
        settings.ccDefault = mode == "command" && signedIn
        settings.onboardingDone = true
        onFinished(false)
    }, modifier = Modifier.fillMaxWidth()) { Text("Start") }
    if (use != Use.COMMAND) OutlinedButton(onClick = {
        settings.ccDefault = mode == "command" && signedIn
        settings.onboardingDone = true
        onFinished(true)
    }, modifier = Modifier.fillMaxWidth()) { Text("Review all settings") }
}
