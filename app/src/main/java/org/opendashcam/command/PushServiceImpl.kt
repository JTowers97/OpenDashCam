package org.opendashcam.command

import org.json.JSONObject
import org.opendashcam.settings.OdcSettings
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

/**
 * UnifiedPush: alerts delivered through a distributor app (such as ntfy), with no permanent connection from ODC.
 * The server encrypts each alert for this phone (Web Push); the library decrypts it before it arrives here.
 */
class PushServiceImpl : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val settings = OdcSettings(this)
        val keys = endpoint.pubKeySet ?: return
        Thread {
            try {
                CommandCenter.client(settings).call("POST", "/api/push/subscribe", JSONObject()
                    .put("endpoint", endpoint.url)
                    .put("keys", JSONObject().put("p256dh", keys.pubKey).put("auth", keys.auth))
                    .put("kind", "app").put("label", CommandCenter.deviceName))
            } catch (_: Exception) {
            }
        }.start()
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (!message.decrypted) return
        val n = try { JSONObject(String(message.content)) } catch (_: Exception) { return }
        Thread { AlertNotifier.show(this, n) }.start()
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {}

    override fun onUnregistered(instance: String) {}
}
