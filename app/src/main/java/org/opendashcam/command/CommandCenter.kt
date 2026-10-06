package org.opendashcam.command

import android.content.Context
import android.os.Build
import org.json.JSONObject
import org.opendashcam.backup.ServerClient
import org.opendashcam.settings.OdcSettings
import org.unifiedpush.android.connector.UnifiedPush

/** Command Center: this phone signed in to an ODC Server account to manage it and receive alerts. */
object CommandCenter {
    val deviceName: String get() = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"

    fun client(settings: OdcSettings) = ServerClient(settings.ccUrl, settings.ccToken, settings.ccPin.ifBlank { null })

    /** Signs in and turns Command Center on. Call off the main thread. */
    fun signIn(context: Context, url: String, username: String, password: String, code: String?): JSONObject {
        val settings = OdcSettings(context)
        val base = url.trim().trimEnd('/').let { if (it.startsWith("http")) it else "https://$it" }
        // Reuse the pinned certificate if this is the server the phone already records to.
        val pin = if (base == settings.serverUrl.trimEnd('/') || base == settings.serverHomeUrl.trimEnd('/')) settings.serverCertPin else ""
        val r = ServerClient(base, null, pin.ifBlank { null }).signIn(username, password, code, deviceName)
        settings.ccUrl = base
        settings.ccPin = pin
        settings.ccToken = r.getString("token")
        settings.ccUsername = r.getJSONObject("user").optString("username")
        settings.ccIsAdmin = r.getJSONObject("user").optBoolean("isAdmin")
        settings.ccEnabled = true
        settings.ccLastShownId = latestId(settings)
        startDelivery(context)
        return r
    }

    fun signOut(context: Context) {
        val settings = OdcSettings(context)
        try { client(settings).call("POST", "/api/logout") } catch (_: Exception) {}
        stopDelivery(context)
        settings.ccToken = null
        settings.ccEnabled = false
        settings.ccDefault = false
    }

    /** The newest notification on the server, so signing in doesn't replay old alerts. */
    private fun latestId(settings: OdcSettings): Long = try {
        val list = client(settings).call("GET", "/api/me/notifications?limit=1").getJSONArray("notifications")
        if (list.length() > 0) list.getJSONObject(list.length() - 1).getLong("id") else 0L
    } catch (_: Exception) { 0L }

    /** Starts the chosen alert delivery: UnifiedPush (via a distributor app) or the direct connection. */
    fun startDelivery(context: Context) {
        val settings = OdcSettings(context)
        if (!settings.ccSignedIn) return
        when (settings.ccDelivery) {
            "direct" -> AlertConnectionService.start(context)
            "unifiedpush" -> {
                AlertConnectionService.stop(context)
                Thread {
                    val vapid = try { client(settings).call("GET", "/api/push/key").getString("publicKey") } catch (_: Exception) { null }
                    UnifiedPush.register(context, messageForDistributor = "Open Dash Cam alerts", vapid = vapid)
                }.start()
            }
            else -> AlertConnectionService.stop(context)
        }
    }

    fun stopDelivery(context: Context) {
        AlertConnectionService.stop(context)
        try { UnifiedPush.unregister(context) } catch (_: Exception) {}
    }

    /** Distributor apps installed on this phone (e.g. ntfy), for UnifiedPush. */
    fun distributors(context: Context): List<String> = try { UnifiedPush.getDistributors(context) } catch (_: Exception) { emptyList() }
}
