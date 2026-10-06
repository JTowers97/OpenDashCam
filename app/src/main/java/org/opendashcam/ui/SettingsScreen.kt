package org.opendashcam.ui

import androidx.compose.material3.OutlinedTextField
import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.opendashcam.AppVersion
import org.opendashcam.autostart.AutoStart
import org.opendashcam.autostart.StandbyService
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.camera.CameraCapabilities
import org.opendashcam.sensors.ImpactDetector
import org.opendashcam.settings.ParkingMode
import org.opendashcam.settings.Sensitivity
import org.opendashcam.settings.SpeedUnit
import org.opendashcam.recording.ProfileBuilder
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.AfterUpload
import org.opendashcam.settings.BackupWhat
import org.opendashcam.settings.CameraMode
import org.opendashcam.settings.Codec
import org.opendashcam.settings.DisplayMode
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.Quality
import org.opendashcam.storage.ClipStorage
import java.util.Locale

private fun btGranted(context: Context): Boolean =
    Build.VERSION.SDK_INT < 31 || granted(context, Manifest.permission.BLUETOOTH_CONNECT)

/** Paired Bluetooth devices as (address, name). */
@SuppressLint("MissingPermission")
private fun bondedDevices(context: Context): List<Pair<String, String>> = try {
    val adapter = context.getSystemService(BluetoothManager::class.java)?.adapter
    adapter?.bondedDevices.orEmpty().map { it.address to (it.name ?: it.address) }.sortedBy { it.second }
} catch (e: Exception) {
    emptyList()
}

private fun autoUnitLabel(): String =
    if (Locale.getDefault().country.uppercase() in setOf("US", "GB", "LR", "MM")) "mph" else "km/h"

@Composable
fun SettingsScreen(
    settings: OdcSettings,
    onBack: () -> Unit,
    onRerunSetup: () -> Unit,
    onOpenPrivacyZones: () -> Unit,
    onOpenServerClips: () -> Unit,
    onOpenCommandCenter: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val caps = remember { CameraCapabilities(context) }
    val storage = remember { ClipStorage(context, settings) }
    val recState by RecordingService.state.collectAsStateWithLifecycle()

    // Settings live in SharedPreferences; bumping this re-reads them. Everything below is in
    // inline layouts (Column), so the whole screen recomposes when it changes.
    var version by remember { mutableIntStateOf(0) }
    @Suppress("UNUSED_VARIABLE") val v = version
    fun set(block: () -> Unit) {
        block()
        version++
    }

    var showAudioDisclaimer by remember { mutableStateOf(false) }
    var showPassphraseDialog by remember { mutableStateOf(false) }
    var showScreenOffTest by remember { mutableStateOf(false) }
    var enableUploadEncryptionAfterPassphrase by remember { mutableStateOf(false) }
    val impactAvailable = remember { ImpactDetector.isAvailable(context) }
    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val ok = granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
        set { settings.gpsEnabled = ok }
        if (!ok) Toast.makeText(context, "Precise location is needed for GPS logging.", Toast.LENGTH_LONG).show()
    }
    val btLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        set { settings.autoStartBluetooth = ok }
        if (!ok) Toast.makeText(context, "Nearby devices permission is needed to see your car's Bluetooth.", Toast.LENGTH_LONG).show()
    }
    val overlayLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        version++
    }
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        set { settings.audioEnabled = ok }
        if (!ok) Toast.makeText(context, "Microphone permission denied; audio stays off.", Toast.LENGTH_LONG).show()
    }

    // Which cameras the current mode uses, for filtering options.
    val activeCams = when (settings.cameraMode) {
        CameraMode.REAR -> listOfNotNull(caps.rear)
        CameraMode.FRONT -> listOfNotNull(caps.front)
        CameraMode.DUAL -> listOfNotNull(caps.rear, caps.front)
    }.ifEmpty { listOfNotNull(caps.rear ?: caps.front) }

    val heights = activeCams.map { caps.supportedHeights(it).toSet() }
        .reduceOrNull { a, b -> a intersect b }.orEmpty()
        .sortedDescending().ifEmpty { listOf(720) }
    val fpsOptions = listOf(24, 30, 60).filter { f -> activeCams.all { caps.supportsFps(it, f) } }.ifEmpty { listOf(30) }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        ScreenHeader("Settings", onBack)
        if (recState.active) Hint("Changes take effect the next time recording starts.")

        // ------------------------------------------------------------ Recording
        SectionHeader("Recording")
        ChoiceRow(
            title = "Cameras",
            options = CameraMode.entries,
            selected = settings.cameraMode,
            label = { it.label },
            enabled = {
                when (it) {
                    CameraMode.REAR -> caps.rear != null
                    CameraMode.FRONT -> caps.front != null
                    CameraMode.DUAL -> caps.supportsDual
                }
            },
            onSelect = { mode -> set { settings.cameraMode = mode } },
            subtitle = if (caps.supportsDual) "This phone can record front and rear at the same time."
            else "This phone can't record front and rear at the same time.",
        )
        ChoiceRow(
            title = "Resolution",
            options = heights,
            selected = heights.firstOrNull { it <= settings.resolution } ?: heights.last(),
            label = { CameraCapabilities.heightLabel(it) },
            onSelect = { h -> set { settings.resolution = h } },
            subtitle = if (settings.cameraMode == CameraMode.DUAL) "Some phones only record both cameras at 720p; ODC lowers it automatically if needed." else null,
        )
        ChoiceRow(
            title = "Frame rate",
            options = fpsOptions,
            selected = if (settings.fps in fpsOptions) settings.fps else fpsOptions.last(),
            label = { "$it fps" },
            onSelect = { f -> set { settings.fps = f } },
        )
        ChoiceRow(
            title = "Quality",
            options = Quality.entries,
            selected = settings.quality,
            label = { it.label },
            onSelect = { q -> set { settings.quality = q } },
            subtitle = String.format(
                Locale.US, "About %.1f GB per hour of driving at these settings.",
                ProfileBuilder.estimateGbPerHour(settings, caps),
            ),
        )
        ChoiceRow(
            title = "Video format",
            options = Codec.entries,
            selected = if (caps.hevcEncoder) settings.codec else Codec.H264,
            label = { it.label },
            enabled = { it == Codec.H264 || caps.hevcEncoder },
            onSelect = { c -> set { settings.codec = c } },
            subtitle = if (caps.hevcEncoder) "H.265 uses about half the space. H.264 plays on more devices."
            else "This phone has no H.265 encoder, so ODC uses H.264.",
        )
        ChoiceRow(
            title = "Clip length",
            options = listOf(1, 3, 5),
            selected = settings.segmentMinutes,
            label = { "$it min" },
            onSelect = { m -> set { settings.segmentMinutes = m } },
            subtitle = "Clips are saved continuously as they record, so a crash or power loss costs at most about a second.",
        )
        ChoiceRow(
            title = "Screen while recording",
            options = DisplayMode.entries,
            selected = settings.displayMode,
            label = { it.label },
            onSelect = { d -> set { settings.displayMode = d } },
            subtitle = "Dimmed keeps the screen on at minimum brightness (tap to wake). Screen off saves the most power, " +
                "but some phones stop recording with the screen off. " + screenOffStatus(settings),
        )
        TextButton(onClick = { showScreenOffTest = true }) { Text("Test screen-off recording") }
        SwitchRow(
            title = "Date and time stamp on video",
            checked = settings.overlayEnabled,
            onChange = { on -> set { settings.overlayEnabled = on } },
            subtitle = "Burned into the picture (bottom-left), so it shows in any player and stays with the footage. Uses the clock corrected by GPS when available.",
        )
        if (settings.overlayEnabled) {
            SwitchRow(
                title = "Include speed",
                checked = settings.overlaySpeed,
                onChange = { on -> set { settings.overlaySpeed = on } },
                subtitle = if (settings.gpsEnabled) "In ${settings.resolvedSpeedUnit.label}." else "Needs GPS logging (Settings → Location).",
            )
            SwitchRow(
                title = "Include GPS coordinates",
                checked = settings.overlayCoords,
                onChange = { on -> set { settings.overlayCoords = on } },
                subtitle = "Never shown inside privacy zones.",
            )
            SwitchRow(
                title = "Include your license plate",
                checked = settings.overlayPlate,
                onChange = { on -> set { settings.overlayPlate = on } },
                subtitle = "Shows which car the footage came from, e.g. for insurance claims.",
            )
            if (settings.overlayPlate) {
                var plate by remember { mutableStateOf(settings.ownPlate) }
                OutlinedTextField(
                    value = plate,
                    onValueChange = { v -> plate = v.take(12); settings.ownPlate = plate },
                    label = { Text("Your license plate") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        SwitchRow(
            title = "Record audio",
            checked = settings.audioEnabled,
            onChange = { on ->
                if (!on) set { settings.audioEnabled = false } else showAudioDisclaimer = true
            },
            subtitle = "Off by default. Recording conversations may require everyone's consent where you live.",
        )

        // ------------------------------------------------------------ Parking
        SwitchRow(
            title = "Spoken feedback",
            checked = settings.spokenFeedback,
            onChange = { on ->
                set { settings.spokenFeedback = on }
                if (on) org.opendashcam.feedback.Announcer.say(context, "Spoken feedback on")
            },
            subtitle = "Short announcements like \"Recording started\", \"Parking mode\" or \"Impact detected\", so you know ODC is working without looking at the phone. Plays through the car's speakers when connected, lowering music briefly.",
        )

        SectionHeader("Parking mode")
        SwitchRow(
            title = "Parking mode when unplugged",
            checked = settings.parkingEnabled,
            onChange = { on -> set { settings.parkingEnabled = on } },
            subtitle = "When charging stops, ODC keeps watching at 720p to save battery.",
        )
        if (settings.parkingEnabled) {
            ChoiceRow(
                title = "Parking recording",
                options = ParkingMode.entries,
                selected = settings.parkingMode,
                label = { it.label },
                onSelect = { m -> set { settings.parkingMode = m } },
                subtitle = when (settings.parkingMode) {
                    ParkingMode.CONTINUOUS -> "Records everything, non-stop."
                    ParkingMode.MOTION -> "Watches at 15 fps and keeps only clips with motion, plus 10 to 25 seconds before and after. Saves the most storage."
                    ParkingMode.TIMELAPSE -> "Captures one frame every few seconds and plays it back fast. Uses the least battery. No audio."
                },
            )
            when (settings.parkingMode) {
                ParkingMode.CONTINUOUS -> ChoiceRow(
                    title = "Parking frame rate",
                    options = listOf(24, 30),
                    selected = settings.parkingFps,
                    label = { "$it fps" },
                    onSelect = { f -> set { settings.parkingFps = f } },
                )
                ParkingMode.MOTION -> ChoiceRow(
                    title = "Motion sensitivity",
                    options = Sensitivity.entries,
                    selected = settings.motionSensitivity,
                    label = { it.label },
                    onSelect = { m -> set { settings.motionSensitivity = m } },
                    subtitle = "Higher catches smaller movements but may also save clips of trees, rain or passing headlights.",
                )
                ParkingMode.TIMELAPSE -> ChoiceRow(
                    title = "Capture one frame every",
                    options = listOf(1, 2, 5),
                    selected = settings.timelapseIntervalSec,
                    label = { "$it s" },
                    onSelect = { sec -> set { settings.timelapseIntervalSec = sec } },
                )
            }
        }

        // ------------------------------------------------------------ Impact
        SectionHeader("Impact detection")
        SwitchRow(
            title = "Lock clips on impact",
            checked = settings.impactEnabled && impactAvailable,
            onChange = { on -> if (impactAvailable) set { settings.impactEnabled = on } },
            subtitle = if (impactAvailable) "Uses the phone's motion sensor. A jolt locks the clips before, during and after it, and sends an alert. Works while driving and parked."
            else "This phone has no accelerometer.",
        )
        if (settings.impactEnabled && impactAvailable) {
            ChoiceRow(
                title = "Impact sensitivity",
                options = Sensitivity.entries,
                selected = settings.impactSensitivity,
                label = { it.label },
                onSelect = { v -> set { settings.impactSensitivity = v } },
                subtitle = "If potholes or a loose mount trigger it, lower the sensitivity. Parked thresholds are automatically more sensitive.",
            )
        }

        // ------------------------------------------------------------ Location
        SectionHeader("Location")
        SwitchRow(
            title = "GPS and speed logging",
            checked = settings.gpsEnabled && granted(context, Manifest.permission.ACCESS_FINE_LOCATION),
            onChange = { on ->
                if (!on) set { settings.gpsEnabled = false }
                else if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) set { settings.gpsEnabled = true }
                else locationLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            },
            subtitle = "Saves location, speed and heading with each clip as a GPX file. Only while ODC is open or recording; never in the background otherwise.",
        )
        ChoiceRow(
            title = "Speed units",
            options = SpeedUnit.entries,
            selected = settings.speedUnit,
            label = { if (it == SpeedUnit.AUTO) "Auto (${autoUnitLabel()})" else it.label },
            onSelect = { u -> set { settings.speedUnit = u } },
        )
        SwitchRow(
            title = "Subtitle file with date, time and speed",
            checked = settings.subtitlesEnabled,
            onChange = { on -> set { settings.subtitlesEnabled = on } },
            subtitle = "Saves a subtitle file with each clip that players like VLC can show or hide. For a stamp that's part of the picture, use \"Date and time stamp on video\" under Recording.",
        )
        val zoneCount = settings.privacyZones.size
        OutlinedButton(onClick = onOpenPrivacyZones, modifier = Modifier.padding(vertical = 6.dp)) {
            Text(if (zoneCount == 0) "Privacy zones (map)" else "Privacy zones on the map ($zoneCount)")
        }
        Hint("No location is logged inside a privacy zone, and parking mode can be switched off there.")

        // ------------------------------------------------------------ Auto-start
        SectionHeader("Auto-start")
        SwitchRow(
            title = "Start recording when charging begins",
            checked = settings.autoStartCharging,
            onChange = { on ->
                set { settings.autoStartCharging = on }
                if (on) StandbyService.start(context) else StandbyService.stop(context)
            },
            subtitle = "Keeps a small \"ready\" notification while waiting. Uses almost no battery.",
        )
        SwitchRow(
            title = "Start recording when connected to car Bluetooth",
            checked = settings.autoStartBluetooth && btGranted(context),
            onChange = { on ->
                if (!on) set { settings.autoStartBluetooth = false }
                else if (btGranted(context)) set { settings.autoStartBluetooth = true }
                else btLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT)
            },
        )
        if (settings.autoStartBluetooth && btGranted(context)) {
            val devices = bondedDevices(context)
            if (devices.isEmpty()) {
                Hint("No paired Bluetooth devices found. Pair the phone with your car first.")
            } else {
                Text("Car devices", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 4.dp))
                devices.forEach { (address, name) ->
                    SwitchRow(
                        title = name,
                        checked = address in settings.autoStartBtDevices,
                        onChange = { on ->
                            set {
                                settings.autoStartBtDevices =
                                    if (on) settings.autoStartBtDevices + address else settings.autoStartBtDevices - address
                            }
                        },
                    )
                }
            }
        }
        if (settings.autoStartCharging || settings.autoStartBluetooth) {
            val canOverlay = AutoStart.canOpenFromBackground(context)
            if (canOverlay) {
                Hint("✓ ODC can open itself to start recording.")
            } else {
                Hint("Android only lets ODC open itself if you allow \"Display over other apps\". Without it, you'll get a notification to tap instead.")
                OutlinedButton(onClick = {
                    overlayLauncher.launch(
                        Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${context.packageName}"))
                    )
                }) { Text("Allow ODC to open itself") }
            }
        }

        // ------------------------------------------------------------ Storage
        SectionHeader("Storage")
        val volumes = storage.volumes()
        ChoiceRow(
            title = "Save footage to",
            options = volumes.map { it.index },
            selected = settings.storageVolumeIndex.coerceAtMost(volumes.lastIndex.coerceAtLeast(0)),
            label = { i ->
                val vol = volumes.first { it.index == i }
                "${vol.label} (${ClipStorage.formatBytes(vol.freeBytes)} free)"
            },
            onSelect = { i -> set { settings.storageVolumeIndex = i } },
            subtitle = "Footage is kept in ODC's own folder on that drive. Uninstalling ODC deletes it, so copy off anything you want to keep first.",
        )
        val volumeTotalGb = (volumes.getOrNull(settings.storageVolumeIndex)?.totalBytes ?: 0L) / (1024L * 1024 * 1024)
        val capOptions = listOf(0, 8, 16, 32, 64, 128, 256, 512).filter { it == 0 || it < volumeTotalGb }
        ChoiceRow(
            title = "Footage size limit",
            options = capOptions,
            selected = if (settings.storageCapGb in capOptions) settings.storageCapGb else 0,
            label = { if (it == 0) "Auto (80%)" else "$it GB" },
            onSelect = { gb -> set { settings.storageCapGb = gb } },
            subtitle = "When footage reaches the limit, the oldest unlocked clips are replaced. You'll get a warning at 90%.",
        )

        Text("On-phone encryption", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 6.dp))
        Hint(
            "Encrypt clips whenever you like from the Clips screen. Encrypted clips show a small key icon and " +
                "play only after you enter your passphrase. The same passphrase is used for encrypted uploads."
        )
        TextButton(onClick = { showPassphraseDialog = true }) {
            Text(if (settings.encryptionPassphrase.isNullOrEmpty()) "Set encryption passphrase" else "Change encryption passphrase")
        }
        if (!settings.encryptionPassphrase.isNullOrEmpty()) {
            Hint("Changing it doesn't re-encrypt existing clips; they still open with the passphrase they were encrypted with.")
        }

        // ------------------------------------------------------------ Device health
        SectionHeader("Battery and temperature")
        SliderRow(
            title = "Stop recording at",
            value = settings.batteryCutoff,
            range = 2..50,
            valueLabel = { "$it%" },
            onChange = { pct -> set { settings.batteryCutoff = pct } },
            subtitle = "When unplugged, ODC closes the current clip and pauses at this level so footage isn't corrupted. It resumes when charging.",
        )
        SwitchRow(
            title = "Overheating protection",
            checked = settings.thermalProtection,
            onChange = { on -> set { settings.thermalProtection = on } },
            subtitle = "Alerts you and lowers quality when the phone gets hot; pauses only if it gets dangerously hot.",
        )

        // ------------------------------------------------------------ ODC Server
        SectionHeader("Command Center")
        Hint(if (settings.ccSignedIn) "Signed in to ${settings.ccUrl} as ${settings.ccUsername}. Manage your server and get its alerts from this phone."
            else "Use this phone to manage your ODC Server and get its alerts, such as impacts with their photo, from any of your cars. Signs in with your ODC Server account.")
        Button(onClick = onOpenCommandCenter) { Text(if (settings.ccSignedIn) "Open Command Center" else "Set up Command Center") }

        SectionHeader("ODC Server")
        ServerSection(settings, onChanged = { version++ }, onOpenServerClips = onOpenServerClips)

        // ------------------------------------------------------------ SMB share
        SectionHeader("SMB share")
        SwitchRow(
            title = "Back up to an SMB share",
            checked = settings.smbEnabled,
            onChange = { on ->
                set { settings.smbEnabled = on }
                BackupScheduler.kick(context, replace = true)
            },
            subtitle = "A shared folder on a NAS or computer (Windows, Synology, TrueNAS, Unraid, Samba…). Works with or without an ODC Server.",
        )
        if (settings.smbEnabled) {
            SmbConfigEditor(settings, onSaved = { version++ })
            if (settings.smbEncrypted == "no") {
                Text(
                    "⚠ Traffic to this share isn't encrypted, so footage crosses your network readable. We recommend turning on SMB encryption " +
                        "for the share (for example \"Enable SMB encryption\" on Synology, or \"Encrypt data access\" in Windows share settings).",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                )
            }
            SwitchRow(
                title = "Encrypt SMB uploads",
                checked = settings.encryptUploads,
                onChange = { on ->
                    when {
                        !on -> set { settings.encryptUploads = false }
                        !settings.encryptionPassphrase.isNullOrEmpty() -> set { settings.encryptUploads = true }
                        else -> {
                            enableUploadEncryptionAfterPassphrase = true
                            showPassphraseDialog = true
                        }
                    }
                },
                subtitle = "Encrypts clips on the phone before upload, so the share only ever stores encrypted files (.odcenc). " +
                    "Decrypt them with the odc_decrypt tool from the Open Dash Cam project.",
            )
            if (settings.encryptUploads) {
                TextButton(onClick = { showPassphraseDialog = true }) { Text("Change passphrase") }
                Hint("Changing the passphrase only affects future uploads.")
            }
        }

        // ------------------------------------------------------------ Backup rules (all destinations)
        SectionHeader("Backup rules")
        val serverBackupOn = settings.serverPaired && settings.serverUploadEnabled
        if (!settings.smbEnabled && !serverBackupOn) {
            Hint("Turn on a backup destination above (ODC Server or an SMB share) to choose what gets uploaded and when.")
        } else {
            Hint(
                "These rules apply to " + listOfNotNull(
                    if (serverBackupOn) "the ODC Server" else null,
                    if (settings.smbEnabled) "the SMB share" else null,
                ).joinToString(" and ") + "."
            )
            BackupStatusPanel()
            ChoiceRow(
                title = "What to upload",
                options = BackupWhat.entries,
                selected = settings.backupWhat,
                label = { it.label },
                onSelect = { w -> set { settings.backupWhat = w }; BackupScheduler.kick(context, replace = true) },
                subtitle = "Impact clips upload first, then locked clips, then the newest footage.",
            )
            ChoiceRow(
                title = "After a verified upload",
                options = AfterUpload.entries,
                selected = settings.afterUpload,
                label = { it.label },
                onSelect = { a -> set { settings.afterUpload = a } },
                subtitle = "A clip is removed only after every backup destination has it. Locked clips and clips marked \"Keep on phone\" always stay.",
            )
            SwitchRow(
                title = "Upload over cellular data",
                checked = settings.backupCellular,
                onChange = { on -> set { settings.backupCellular = on }; BackupScheduler.kick(context, replace = true) },
                subtitle = "Off: uploads wait for Wi-Fi. A server or share at home is usually only reachable from elsewhere over HTTPS or a VPN (e.g. WireGuard or Tailscale).",
            )
            if (!settings.backupCellular) {
                SwitchRow(
                    title = "Upload impact and locked clips over cellular",
                    checked = settings.backupEventsOnMobile,
                    onChange = { on -> set { settings.backupEventsOnMobile = on }; BackupScheduler.kick(context, replace = true) },
                    subtitle = "So the clips that matter reach your backup right away, even away from Wi-Fi. Everything else still waits for Wi-Fi.",
                )
            }
            if (settings.backupCellular || settings.backupEventsOnMobile) {
                ChoiceRow(
                    title = "Monthly cellular limit",
                    options = listOf(500, 1024, 2048, 5120, 10240, 0),
                    selected = settings.cellularCapMb,
                    label = { mb -> if (mb == 0) "No limit" else if (mb < 1024) "$mb MB" else "${mb / 1024} GB" },
                    onSelect = { mb -> set { settings.cellularCapMb = mb } },
                )
            }
            SwitchRow(
                title = "Only upload while charging",
                checked = settings.backupOnlyCharging,
                onChange = { on -> set { settings.backupOnlyCharging = on }; BackupScheduler.kick(context, replace = true) },
            )
        }

        // ------------------------------------------------------------ About
        SectionHeader("Display and accessibility")
        ChoiceRow(
            title = "Theme",
            options = listOf("dark", "light", "system"),
            selected = settings.themeMode,
            label = { mapOf("dark" to "Dark", "light" to "Light", "system" to "Same as phone")[it]!! },
            onSelect = { v -> set { settings.themeMode = v; Appearance.load(settings) } },
            subtitle = "The recording screen always stays dark, for driving at night.",
        )
        ChoiceRow(
            title = "Accent color",
            options = ACCENTS.keys.toList() + listOfNotNull(if (android.os.Build.VERSION.SDK_INT >= 31) "dynamic" else null),
            selected = settings.accent,
            label = { if (it == "dynamic") "From wallpaper" else it.replaceFirstChar { c -> c.uppercase() } },
            onSelect = { v -> set { settings.accent = v; Appearance.load(settings) } },
        )
        ChoiceRow(
            title = "Text size",
            options = listOf("1.0", "1.15", "1.3"),
            selected = settings.textScale,
            label = { mapOf("1.0" to "Default", "1.15" to "Large", "1.3" to "Larger")[it]!! },
            onSelect = { v -> set { settings.textScale = v; Appearance.load(settings) } },
            subtitle = "On top of the phone's own font size setting.",
        )
        SwitchRow(
            title = "High contrast",
            checked = settings.highContrast,
            onChange = { on -> set { settings.highContrast = on; Appearance.load(settings) } },
            subtitle = "Stronger text and outlines.",
        )

        SectionHeader("App lock")
        val lockActivity = LocalContext.current as? androidx.fragment.app.FragmentActivity
        SwitchRow(
            title = "Lock clips, maps and settings",
            checked = settings.appLock,
            onChange = { on ->
                if (!on) {
                    lockActivity?.let { act -> AppLock.prompt(act, "Turn off app lock") { ok -> if (ok) set { settings.appLock = false } } }
                } else if (lockActivity == null || !AppLock.available(lockActivity)) {
                    android.widget.Toast.makeText(context, "Set up a screen lock (PIN, pattern, password, fingerprint or face) on the phone first.", android.widget.Toast.LENGTH_LONG).show()
                } else {
                    // Confirm once so nobody can lock themselves out.
                    AppLock.prompt(lockActivity, "Turn on app lock") { ok -> if (ok) set { settings.appLock = true } }
                }
            },
            subtitle = "Needs your fingerprint, face or screen lock to open clips, maps, the parking spot and settings. Recording can always be started and stopped without unlocking.",
        )
        if (settings.appLock) {
            ChoiceRow(
                title = "Lock again after leaving the app for",
                options = listOf(0, 1, 5, 15),
                selected = settings.appLockTimeoutMin,
                label = { if (it == 0) "Right away" else "$it min" },
                onSelect = { v -> set { settings.appLockTimeoutMin = v } },
            )
        }

        SectionHeader("About")
        Text("Open Dash Cam ${AppVersion.full}", style = MaterialTheme.typography.bodyLarge)
        Hint("Free software under the GNU GPL v3.")
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = onRerunSetup) { Text("Run setup again") }
        Spacer(Modifier.height(32.dp))
    }

    if (showScreenOffTest) ScreenOffTestDialog { showScreenOffTest = false; version++ }

    if (showPassphraseDialog) {
        PassphraseDialog { pass ->
            showPassphraseDialog = false
            if (pass != null) {
                settings.encryptionPassphrase = pass
                version++
                if (enableUploadEncryptionAfterPassphrase) set { settings.encryptUploads = true }
            }
            enableUploadEncryptionAfterPassphrase = false
        }
    }

    if (showAudioDisclaimer) {
        AlertDialog(
            onDismissRequest = { showAudioDisclaimer = false },
            title = { Text("Before you turn on audio") },
            text = {
                Column {
                    Text(
                        "Audio recording laws differ by country and state. Some places require consent from everyone " +
                            "being recorded, including passengers."
                    )
                    HorizontalDivider(Modifier.padding(vertical = 8.dp))
                    Text(
                        "You alone are responsible for following the laws where you drive. The Open Dash Cam project " +
                            "and its contributors accept no responsibility for how audio recording is used.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    showAudioDisclaimer = false
                    settings.audioDisclaimerAccepted = true
                    if (granted(context, Manifest.permission.RECORD_AUDIO)) set { settings.audioEnabled = true }
                    else micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }) { Text("I understand, turn on") }
            },
            dismissButton = {
                TextButton(onClick = { showAudioDisclaimer = false }) { Text("Keep audio off") }
            },
        )
    }
}
