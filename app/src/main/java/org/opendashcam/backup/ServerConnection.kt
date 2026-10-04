package org.opendashcam.backup

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Base64
import org.opendashcam.settings.OdcSettings
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * How the phone reaches the ODC Server:
 *  - Home address: on Wi-Fi, if the server's home-network address answers, use it (faster, stays local).
 *  - Pinned certificate: the server's own certificate (from the pairing QR code) is trusted for its HTTPS
 *    addresses, in addition to normal certificates from public authorities.
 */
object ServerConnection {
    private var homeCheckedAt = 0L
    private var homeReachable = false

    /** The address to use right now. Does network I/O at most every 2 minutes; call off the main thread. */
    fun baseUrl(context: Context, settings: OdcSettings): String {
        val home = settings.serverHomeUrl.trim().trimEnd('/')
        if (home.isEmpty() || !onUnmeteredNetwork(context)) return settings.serverUrl
        val now = SystemClock.elapsedRealtime()
        if (now - homeCheckedAt > 120_000) {
            homeCheckedAt = now
            homeReachable = try {
                val c = URL("$home/api/v1/time").openConnection() as HttpURLConnection
                c.connectTimeout = 1500
                c.readTimeout = 1500
                applyPin(c, settings.serverCertPin)
                val ok = c.responseCode == 200
                c.disconnect()
                ok
            } catch (_: Exception) {
                false
            }
        }
        return if (homeReachable) home else settings.serverUrl
    }

    /** Forget the cached home check (e.g. after the network changes or settings change). */
    fun reset() {
        homeCheckedAt = 0
    }

    private fun onUnmeteredNetwork(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    // ---------------------------------------------------------------- certificate pinning

    fun fingerprint(cert: X509Certificate): String =
        Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(cert.encoded), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    /** Trusts the pinned certificate for this connection, alongside the normal public authorities. */
    fun applyPin(connection: HttpURLConnection, pin: String?) {
        if (connection !is HttpsURLConnection || pin.isNullOrBlank()) return
        val system = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).run {
            init(null as KeyStore?)
            trustManagers.filterIsInstance<X509TrustManager>().first()
        }
        val pinned = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = system.checkClientTrusted(chain, authType)
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.isNotEmpty() && fingerprint(chain[0]) == pin) return
                system.checkServerTrusted(chain, authType)
            }
            override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(pinned), null) }
        connection.sslSocketFactory = ssl.socketFactory
        val defaultVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
        // The server's own certificate can't name your home IP address; the pin already proves it's your server.
        connection.hostnameVerifier = HostnameVerifier { host, session ->
            val peer = try { session.peerCertificates.firstOrNull() as? X509Certificate } catch (_: Exception) { null }
            (peer != null && fingerprint(peer) == pin) || defaultVerifier.verify(host, session)
        }
    }

    // ---------------------------------------------------------------- warnings

    /** True for localhost and private home-network addresses (10.x, 172.16–31.x, 192.168.x, *.local). */
    fun isLocalAddress(url: String): Boolean {
        val host = try { URI(url.trim()).host ?: "" } catch (_: Exception) { "" }.lowercase()
        if (host == "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true
        val p = host.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || p[0] == 127 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && p[1] in 16..31) || (p[0] == 100 && p[1] in 64..127)
    }

    /** A warning for unencrypted addresses: stronger when the address isn't on the home network. */
    fun warning(url: String): String? = when {
        !url.trim().startsWith("http://") -> null
        isLocalAddress(url) -> "This home-network address isn't encrypted (http://). That's common at home, but HTTPS is recommended."
        else -> "This address isn't encrypted (http://) and is on the internet: footage, live location and the phone's access key travel unencrypted. We strongly recommend HTTPS."
    }
}
