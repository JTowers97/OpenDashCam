package org.opendashcam.settings

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import org.opendashcam.camera.CameraCapabilities
import java.util.Locale
import java.util.UUID
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty

enum class CameraMode(val label: String) { REAR("Rear"), FRONT("Front"), DUAL("Front + rear") }
enum class DisplayMode(val label: String) { DIM("Dimmed screen"), SCREEN_OFF("Screen off") }
enum class Codec(val label: String) { HEVC("H.265"), H264("H.264") }

enum class ParkingMode(val label: String) {
    CONTINUOUS("Continuous"), MOTION("Motion-activated"), TIMELAPSE("Time-lapse")
}
enum class Sensitivity(val label: String) { LOW("Low"), MEDIUM("Medium"), HIGH("High") }
enum class BackupWhat(val label: String) { ALL("Everything"), LOCKED("Locked and impact clips only") }
enum class AfterUpload(val label: String) { KEEP("Keep on phone"), DELETE("Delete from phone") }

data class SmbConfig(
    val host: String,
    val share: String,
    val path: String,
    val username: String,
    val password: String,
    val domain: String,
) {
    val isComplete get() = host.isNotBlank() && share.isNotBlank()
    /** Identifies the destination, so changing it triggers a fresh upload of everything. */
    val targetId get() = "smb://${host.trim().lowercase()}/${share.trim().lowercase()}/${path.trim('/', ' ').lowercase()}"
}

enum class SpeedUnit(val label: String) { AUTO("Auto"), MPH("mph"), KMH("km/h") }

/** A circle where no location is logged; optionally parking mode is switched off inside it. */
data class PrivacyZone(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val lat: Double,
    val lon: Double,
    val radiusM: Int,
    val disableParking: Boolean,
)

/** bitsPerPixel is tuned for H.265; H.264 gets a 1.6x multiplier. */
enum class Quality(val label: String, val bitsPerPixel: Double) {
    LOW("Low", 0.08), STANDARD("Standard", 0.12), HIGH("High", 0.18)
}

/** All user settings, persisted in SharedPreferences. */
class OdcSettings(context: Context) {
    private val prefs = context.applicationContext
        .getSharedPreferences("odc_settings", Context.MODE_PRIVATE)
    private val secrets = SecretStore(context)

    var onboardingDone by bool("onboarding_done", false)

    // Recording
    var cameraMode by enumPref("camera_mode", CameraMode.REAR, CameraMode.entries)
    var resolution by int("resolution", 1080)          // video height: 2160 / 1440 / 1080 / 720
    var fps by int("fps", 30)
    var quality by enumPref("quality", Quality.STANDARD, Quality.entries)
    var codec by enumPref("codec", Codec.HEVC, Codec.entries)
    var segmentMinutes by int("segment_minutes", 3)
    var displayMode by enumPref("display_mode", DisplayMode.DIM, DisplayMode.entries)
    var audioEnabled by bool("audio_enabled", false)
    /** Upload locked and impact clips over mobile data even when other backups wait for Wi-Fi. */
    var backupEventsOnMobile by bool("backup_events_mobile", false)
    /** Short spoken announcements (recording started, parking mode, impact…). */
    var spokenFeedback by bool("spoken_feedback", false)

    /** Version of the remote settings changes (from Command Center) this phone has applied. */
    var remoteSettingsApplied by int("remote_settings_applied", 0)

    /** A phone that lives in the car: Command Center is hidden, so it never holds a sign-in to the account. */
    var dashcamOnly by bool("dashcam_only", false)

    // Command Center: this phone signed in to an ODC Server account
    var ccEnabled by bool("cc_enabled", false)
    var ccDefault by bool("cc_default", false)          // open the app in Command Center
    var ccUrl by string("cc_url", "")
    var ccToken: String?
        get() = secrets.get("cc_token")
        set(value) = secrets.put("cc_token", value)
    var ccPin by string("cc_pin", "")
    var ccUsername by string("cc_username", "")
    var ccIsAdmin by bool("cc_is_admin", false)
    var ccDelivery by string("cc_delivery", "direct")   // unifiedpush | direct | off
    var ccLastShownId by long("cc_last_shown", 0L)       // newest alert already shown (avoids doubles from two routes)
    val ccSignedIn get() = ccUrl.isNotBlank() && !ccToken.isNullOrBlank()

    // Appearance and accessibility
    var themeMode by string("theme_mode", "dark")          // dark | light | system
    var accent by string("accent", "orange")               // orange | blue | green | purple | teal | red | dynamic
    var textScale by string("text_scale", "1.0")           // 1.0 | 1.15 | 1.3
    var highContrast by bool("high_contrast", false)

    // App lock: fingerprint, face or screen lock to open clips, maps and settings
    var appLock by bool("app_lock", false)
    var appLockTimeoutMin by int("app_lock_timeout", 1)    // relock after this long in the background (0 = immediately)

    var overlayEnabled by bool("overlay_enabled", false)     // burned-in date/time stamp
    /** Where the car was parked: "lat,lon,epochMs" or "" (saved when parking mode starts or recording stops). */
    var parkedAt by string("parked_at", "")

    /** Result of the latest screen-off check: "pass", "fail" or "" (not tested), and when ("" or epoch ms). */
    var screenOffResult by string("screen_off_result", "")
    var screenOffCheckedAt by string("screen_off_checked_at", "")
    var overlaySpeed by bool("overlay_speed", true)
    var overlayCoords by bool("overlay_coords", false)
    var overlayPlate by bool("overlay_plate", false)
    /** Your own car's license plate, shown in the stamp if overlayPlate is on. */
    var ownPlate by string("own_plate", "")
    var audioDisclaimerAccepted by bool("audio_disclaimer_accepted", false)

    // Parking mode
    var parkingEnabled by bool("parking_enabled", true)
    var parkingFps by int("parking_fps", 24)
    var parkingMode by enumPref("parking_mode", ParkingMode.CONTINUOUS, ParkingMode.entries)
    var motionSensitivity by enumPref("motion_sensitivity", Sensitivity.MEDIUM, Sensitivity.entries)
    var timelapseIntervalSec by int("timelapse_interval", 1)   // 1, 2 or 5 seconds between frames

    // Impact detection (G-sensor)
    var impactEnabled by bool("impact_enabled", false)
    var impactSensitivity by enumPref("impact_sensitivity", Sensitivity.MEDIUM, Sensitivity.entries)

    // Location
    var gpsEnabled by bool("gps_enabled", false)
    var subtitlesEnabled by bool("subtitles_enabled", false)
    var speedUnit by enumPref("speed_unit", SpeedUnit.AUTO, SpeedUnit.entries)
    private var privacyZonesJson by string("privacy_zones", "[]")

    // Backup
    var smbEnabled by bool("smb_enabled", false)
    var smbHost by string("smb_host", "")
    var smbShare by string("smb_share", "")
    var smbPath by string("smb_path", "OpenDashCam")
    var smbUsername by string("smb_username", "")
    var smbDomain by string("smb_domain", "")
    var backupWhat by enumPref("backup_what", BackupWhat.ALL, BackupWhat.entries)
    var afterUpload by enumPref("after_upload", AfterUpload.KEEP, AfterUpload.entries)
    var backupCellular by bool("backup_cellular", false)
    var cellularCapMb by int("cellular_cap_mb", 1024)      // 0 = no limit
    var backupOnlyCharging by bool("backup_only_charging", false)
    var encryptUploads by bool("encrypt_uploads", false)

    // ODC Server (filled in by pairing)
    var serverUrl by string("server_url", "")
    var serverCameraId by string("server_camera_id", "")
    var serverCarName by string("server_car_name", "")
    var serverCameraLabel by string("server_camera_label", "")
    var serverUploadEnabled by bool("server_upload", true)
    var serverLiveEnabled by bool("server_live", true)
    /** Let the ODC Server ask for a live view of the cameras while recording (off by default). */
    var liveViewAllowed by bool("live_view_allowed", false)
    /** Optional server address on the home network, used automatically when reachable. */
    var serverHomeUrl by string("server_home_url", "")
    /** SHA-256 fingerprint (base64url) of the server's own certificate, trusted for its HTTPS addresses. */
    var serverCertPin by string("server_cert_pin", "")
    /** Result of the last SMB check: "yes", "no" or "" (unknown). */
    var smbEncrypted by string("smb_encrypted", "")

    // Tracking-only mode (needs a paired ODC Server)
    var trackingEnabled by bool("tracking_enabled", false)
    var trackingIntervalSec by int("tracking_interval", 10)
    var trackingAfterRestart by bool("tracking_after_restart", false)

    // Auto-start
    var autoStartCharging by bool("autostart_charging", false)
    var autoStartBluetooth by bool("autostart_bluetooth", false)
    private var autoStartBtDevicesRaw by string("autostart_bt_devices", "")

    // Storage
    var storageVolumeIndex by int("storage_volume", 0)
    var storageCapGb by int("storage_cap_gb", 0)        // 0 = auto (80% of available space)

    /** Last landscape display rotation (90 or 270), so restarts from the background stay landscape. */
    var lastLandscapeRotation by int("last_landscape_rotation", 90)

    // Device health
    var batteryCutoff by int("battery_cutoff", 15)      // 2..50, cannot be disabled
    var thermalProtection by bool("thermal_protection", true)

    /** Sensible defaults for this specific phone. */
    fun applyRecommendedDefaults(caps: CameraCapabilities) {
        cameraMode = CameraMode.REAR
        val rearHeights = caps.rear?.let { caps.supportedHeights(it) }.orEmpty()
        resolution = rearHeights.firstOrNull { it <= 1080 } ?: 720
        fps = 30
        quality = Quality.STANDARD
        codec = if (caps.hevcEncoder) Codec.HEVC else Codec.H264
        segmentMinutes = 3
        displayMode = DisplayMode.DIM
        audioEnabled = false
        parkingEnabled = true
        parkingFps = 24
        storageVolumeIndex = 0
        storageCapGb = 0
        batteryCutoff = 15
        thermalProtection = true
        parkingMode = ParkingMode.CONTINUOUS
        motionSensitivity = Sensitivity.MEDIUM
        timelapseIntervalSec = 1
        impactEnabled = false
        impactSensitivity = Sensitivity.MEDIUM
        gpsEnabled = false
        subtitlesEnabled = false
        speedUnit = SpeedUnit.AUTO
        autoStartCharging = false
        autoStartBluetooth = false
    }

    val smbConfig: SmbConfig
        get() = SmbConfig(smbHost, smbShare, smbPath, smbUsername, secrets.get(SECRET_SMB_PASSWORD).orEmpty(), smbDomain)

    fun saveSmbConfig(c: SmbConfig) {
        smbHost = c.host.trim()
        smbShare = c.share.trim().trim('/', '\\')
        smbPath = c.path.trim().replace('\\', '/').trim('/')
        smbUsername = c.username.trim()
        smbDomain = c.domain.trim()
        secrets.put(SECRET_SMB_PASSWORD, c.password)
    }

    var serverToken: String?
        get() = secrets.get(SECRET_SERVER_TOKEN)
        set(value) = secrets.put(SECRET_SERVER_TOKEN, value)

    val serverPaired: Boolean get() = serverUrl.isNotBlank() && !serverToken.isNullOrEmpty()

    /** Identifies this server + camera pairing, so re-pairing elsewhere uploads everything again. */
    val serverKey: String get() = "${serverUrl.trimEnd('/')}#$serverCameraId"

    fun clearServer() {
        trackingEnabled = false
        serverHomeUrl = ""
        serverCertPin = ""
        serverToken = null
        serverUrl = ""
        serverCameraId = ""
        serverCarName = ""
        serverCameraLabel = ""
    }

        var encryptionPassphrase: String?
        get() = secrets.get(SECRET_PASSPHRASE)
        set(value) = secrets.put(SECRET_PASSPHRASE, value)

    /** mph in the US, UK, Liberia and Myanmar; km/h elsewhere, unless the user overrides it. */
    val resolvedSpeedUnit: SpeedUnit
        get() = when (speedUnit) {
            SpeedUnit.AUTO -> if (Locale.getDefault().country.uppercase() in MPH_COUNTRIES) SpeedUnit.MPH else SpeedUnit.KMH
            else -> speedUnit
        }

    fun formatSpeed(metersPerSecond: Float): String = when (resolvedSpeedUnit) {
        SpeedUnit.MPH -> "${(metersPerSecond * 2.23694f).toInt()} mph"
        else -> "${(metersPerSecond * 3.6f).toInt()} km/h"
    }

    var privacyZones: List<PrivacyZone>
        get() = try {
            val arr = JSONArray(privacyZonesJson)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                PrivacyZone(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    name = o.optString("name", "Zone"),
                    lat = o.getDouble("lat"),
                    lon = o.getDouble("lon"),
                    radiusM = o.optInt("radius", 250),
                    disableParking = o.optBoolean("disableParking", false),
                )
            }
        } catch (e: Exception) {
            emptyList()
        }
        set(value) {
            val arr = JSONArray()
            value.forEach { z ->
                arr.put(
                    JSONObject()
                        .put("id", z.id).put("name", z.name)
                        .put("lat", z.lat).put("lon", z.lon)
                        .put("radius", z.radiusM).put("disableParking", z.disableParking)
                )
            }
            privacyZonesJson = arr.toString()
        }

    var autoStartBtDevices: Set<String>
        get() = autoStartBtDevicesRaw.split(',').map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        set(value) {
            autoStartBtDevicesRaw = value.joinToString(",")
        }

    private fun bool(key: String, def: Boolean) = object : ReadWriteProperty<Any?, Boolean> {
        override fun getValue(thisRef: Any?, property: KProperty<*>) = prefs.getBoolean(key, def)
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: Boolean) {
            prefs.edit().putBoolean(key, value).apply()
        }
    }

    private fun string(key: String, def: String) = object : ReadWriteProperty<Any?, String> {
        override fun getValue(thisRef: Any?, property: KProperty<*>) = prefs.getString(key, def) ?: def
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: String) {
            prefs.edit().putString(key, value).apply()
        }
    }

    private fun long(key: String, def: Long) = object : ReadWriteProperty<Any?, Long> {
        override fun getValue(thisRef: Any?, property: KProperty<*>) = prefs.getLong(key, def)
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: Long) {
            prefs.edit().putLong(key, value).apply()
        }
    }

    private fun int(key: String, def: Int) = object : ReadWriteProperty<Any?, Int> {
        override fun getValue(thisRef: Any?, property: KProperty<*>) = prefs.getInt(key, def)
        override fun setValue(thisRef: Any?, property: KProperty<*>, value: Int) {
            prefs.edit().putInt(key, value).apply()
        }
    }

    private fun <T : Enum<T>> enumPref(key: String, def: T, values: List<T>) =
        object : ReadWriteProperty<Any?, T> {
            override fun getValue(thisRef: Any?, property: KProperty<*>): T {
                val name = prefs.getString(key, null) ?: return def
                return values.firstOrNull { it.name == name } ?: def
            }
            override fun setValue(thisRef: Any?, property: KProperty<*>, value: T) {
                prefs.edit().putString(key, value.name).apply()
            }
        }

    companion object {
        private val MPH_COUNTRIES = setOf("US", "GB", "LR", "MM")
        private const val SECRET_SMB_PASSWORD = "smb_password"
        private const val SECRET_PASSPHRASE = "upload_passphrase"
        private const val SECRET_SERVER_TOKEN = "server_token"
    }
}
