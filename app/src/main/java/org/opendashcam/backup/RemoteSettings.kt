package org.opendashcam.backup

import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import org.opendashcam.R
import org.opendashcam.recording.Notifier
import org.opendashcam.settings.OdcSettings
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Remote settings (Command Center): this phone reports the settings that can be changed remotely and applies
 * changes made from Command Center or the web app. Runs when the phone checks in (while recording or tracking),
 * when the app opens, and when a backup runs. A notification lists anything changed remotely.
 */
object RemoteSettings {
    private val busy = AtomicBoolean(false)

    /** The settings that can be changed remotely (same list as the server's), as getter/setter pairs. */
    private fun fields(s: OdcSettings): Map<String, Pair<() -> Any, (Any) -> Unit>> = mapOf(
        "resolution" to ({ s.resolution as Any } to { v: Any -> s.resolution = (v as Number).toInt() }),
        "fps" to ({ s.fps as Any } to { v: Any -> s.fps = (v as Number).toInt() }),
        "segmentMinutes" to ({ s.segmentMinutes as Any } to { v: Any -> s.segmentMinutes = (v as Number).toInt() }),
        "overlayEnabled" to ({ s.overlayEnabled as Any } to { v: Any -> s.overlayEnabled = v as Boolean }),
        "overlaySpeed" to ({ s.overlaySpeed as Any } to { v: Any -> s.overlaySpeed = v as Boolean }),
        "overlayCoords" to ({ s.overlayCoords as Any } to { v: Any -> s.overlayCoords = v as Boolean }),
        "spokenFeedback" to ({ s.spokenFeedback as Any } to { v: Any -> s.spokenFeedback = v as Boolean }),
        "parkingEnabled" to ({ s.parkingEnabled as Any } to { v: Any -> s.parkingEnabled = v as Boolean }),
        "impactEnabled" to ({ s.impactEnabled as Any } to { v: Any -> s.impactEnabled = v as Boolean }),
        "gpsEnabled" to ({ s.gpsEnabled as Any } to { v: Any -> s.gpsEnabled = v as Boolean }),
        "serverLiveEnabled" to ({ s.serverLiveEnabled as Any } to { v: Any -> s.serverLiveEnabled = v as Boolean }),
        "liveViewAllowed" to ({ s.liveViewAllowed as Any } to { v: Any -> s.liveViewAllowed = v as Boolean }),
        "backupCellular" to ({ s.backupCellular as Any } to { v: Any -> s.backupCellular = v as Boolean }),
        "backupEventsOnMobile" to ({ s.backupEventsOnMobile as Any } to { v: Any -> s.backupEventsOnMobile = v as Boolean }),
        "cellularCapMb" to ({ s.cellularCapMb as Any } to { v: Any -> s.cellularCapMb = (v as Number).toInt() }),
        "backupOnlyCharging" to ({ s.backupOnlyCharging as Any } to { v: Any -> s.backupOnlyCharging = v as Boolean }),
        "autoStartCharging" to ({ s.autoStartCharging as Any } to { v: Any -> s.autoStartCharging = v as Boolean }),
        "batteryCutoff" to ({ s.batteryCutoff as Any } to { v: Any -> s.batteryCutoff = (v as Number).toInt() }),
        "thermalProtection" to ({ s.thermalProtection as Any } to { v: Any -> s.thermalProtection = v as Boolean }),
    )

    private val LABELS = mapOf(
        "resolution" to "video resolution", "fps" to "frame rate", "segmentMinutes" to "clip length", "overlayEnabled" to "date/time stamp",
        "overlaySpeed" to "speed in the stamp", "overlayCoords" to "coordinates in the stamp", "spokenFeedback" to "spoken feedback",
        "parkingEnabled" to "parking mode", "impactEnabled" to "impact detection", "gpsEnabled" to "GPS logging",
        "serverLiveEnabled" to "live location", "liveViewAllowed" to "live view", "backupCellular" to "backup over mobile data",
        "backupEventsOnMobile" to "impact clips over mobile data", "cellularCapMb" to "mobile data limit",
        "backupOnlyCharging" to "backup only while charging", "autoStartCharging" to "start when charging", "batteryCutoff" to "battery cutoff",
        "thermalProtection" to "heat protection",
    )

    private fun report(s: OdcSettings) = JSONObject().apply { fields(s).forEach { (k, f) -> put(k, f.first()) } }

    /** Reports this phone's settings and applies any changes waiting on the server. Call off the main thread. */
    fun sync(context: Context) {
        val s = OdcSettings(context)
        if (!s.serverPaired || !busy.compareAndSet(false, true)) return
        try {
            val client = ServerClient.forSettings(context, s)
            val r = client.settingsExchange(JSONObject().put("settings", report(s)).put("applied", s.remoteSettingsApplied))
            val changes = r.optJSONObject("changes") ?: return
            val version = r.optInt("version")
            val fields = fields(s)
            val changed = mutableListOf<String>()
            for (k in changes.keys()) {
                val f = fields[k] ?: continue
                val v = changes.get(k)
                val current = f.first()
                val same = if (current is Number && v is Number) current.toInt() == v.toInt() else current == v
                if (!same) runCatching { f.second(v) }.onSuccess { changed += LABELS[k] ?: k }
            }
            s.remoteSettingsApplied = version
            // Tell the server right away that they're applied.
            client.settingsExchange(JSONObject().put("settings", report(s)).put("applied", version))
            if (changed.isNotEmpty()) notifyChanged(context, changed)
        } catch (_: Exception) {
            // Try again at the next check-in.
        } finally {
            busy.set(false)
        }
    }

    fun syncInBackground(context: Context) {
        val app = context.applicationContext
        Thread { sync(app) }.start()
    }

    private fun notifyChanged(context: Context, changed: List<String>) {
        val text = "Changed: " + changed.joinToString(", ") + ". Recording settings take effect the next time recording starts."
        val n = NotificationCompat.Builder(context, Notifier.CHANNEL_TRACKING)
            .setSmallIcon(R.drawable.ic_stat_odc)
            .setContentTitle("Settings changed from Command Center")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .build()
        try { context.getSystemService(NotificationManager::class.java).notify(8, n) } catch (_: SecurityException) {}
    }
}
