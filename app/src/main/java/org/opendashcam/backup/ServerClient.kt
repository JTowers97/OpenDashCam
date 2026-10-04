package org.opendashcam.backup

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

class ServerException(val status: Int, message: String) : Exception(message)

/**
 * Talks to the ODC Server's phone API (/api/v1). Plain HttpURLConnection, no extra libraries.
 * Uploads are resumable: the server keeps partial uploads and reports how much it already has.
 */
class ServerClient(baseUrl: String, private val token: String?, private val pin: String? = null) {
    private val base = baseUrl.trim().trimEnd('/')

    data class Pairing(val token: String, val cameraId: String, val carName: String, val label: String, val serverName: String)

    fun pair(code: String, label: String?, deviceModel: String, appVersion: String): Pairing {
        val body = JSONObject().put("code", code).put("deviceModel", deviceModel).put("appVersion", appVersion)
        if (!label.isNullOrBlank()) body.put("label", label)
        val r = json("POST", "/api/v1/devices/pair", body)
        return Pairing(r.getString("token"), r.getString("cameraId"), r.getString("carName"), r.getString("label"), r.optString("serverName"))
    }

    fun me(): JSONObject = json("GET", "/api/v1/devices/me", null)

    fun heartbeat(body: JSONObject) {
        val t0 = System.currentTimeMillis()
        val r = json("POST", "/api/v1/devices/me/heartbeat", body)
        val t1 = System.currentTimeMillis()
        if (r.has("now")) org.opendashcam.recording.ClockSync.fromServer(r.getLong("now"), t0, t1)
    }

    fun live(t: Long, lat: Double, lon: Double, speed: Float?, course: Float?, acc: Float?) {
        val b = JSONObject().put("t", t).put("lat", lat).put("lon", lon)
        speed?.let { b.put("speed", it.toDouble()) }
        course?.let { b.put("course", it.toDouble()) }
        acc?.let { b.put("acc", it.toDouble()) }
        json("POST", "/api/v1/live", b)
    }

    /** Tracking-only mode: a batch of points (possibly collected while offline). */
    fun track(points: JSONArray) {
        json("POST", "/api/v1/track", JSONObject().put("points", points))
    }

    fun sync(from: Long, to: Long): JSONObject = json("GET", "/api/v1/sync?from=$from&to=$to", null)

        fun locatedClips(limit: Int = 1000): JSONArray =
        json("GET", "/api/v1/clips?located=1&limit=$limit", null).getJSONArray("clips")

    fun event(type: String, message: String, data: JSONObject = JSONObject()) {
        json("POST", "/api/v1/events", JSONObject().put("type", type).put("t", System.currentTimeMillis()).put("message", message).put("data", data))
    }

    fun clips(limit: Int = 100, offset: Int = 0): JSONArray =
        json("GET", "/api/v1/clips?limit=$limit&offset=$offset", null).getJSONArray("clips")

    /** Uploads a clip, resuming if the server already has part of it. Returns the server's clip id. */
    fun uploadClip(file: File, meta: JSONObject, onBytes: (Long) -> Unit, shouldStop: () -> Boolean): String {
        val created = json("POST", "/api/v1/uploads", meta)
        val id = created.getString("id")
        if (created.optBoolean("complete")) return id
        val size = file.length()
        var offset = created.optLong("offset", 0)
        RandomAccessFile(file, "r").use { raf ->
            val buf = ByteArray(CHUNK)
            while (offset < size) {
                if (shouldStop()) throw UploadStoppedException()
                val n = minOf(CHUNK.toLong(), size - offset).toInt()
                raf.seek(offset)
                raf.readFully(buf, 0, n)
                val newOffset = patch(id, offset, buf, n)
                if (newOffset > offset) onBytes(newOffset - offset)
                offset = newOffset
            }
        }
        // The server recomputes the SHA-256 and rejects the upload if it doesn't match.
        json("POST", "/api/v1/uploads/$id/complete", JSONObject())
        return id
    }

    /** An event with a photo (impact snapshot). */
    fun eventWithPhoto(type: String, message: String, jpeg: ByteArray) {
        val q = "type=" + java.net.URLEncoder.encode(type, "UTF-8") + "&message=" + java.net.URLEncoder.encode(message, "UTF-8") +
            "&t=" + org.opendashcam.recording.ClockSync.now()
        val c = open("POST", "/api/v1/events/snapshot?$q")
        c.setRequestProperty("Content-Type", "image/jpeg")
        c.doOutput = true
        c.setFixedLengthStreamingMode(jpeg.size)
        c.outputStream.use { it.write(jpeg) }
        readResponse(c)
    }

    fun sidecar(clipId: String, kind: String, bytes: ByteArray, encrypted: Boolean) {
        val c = open("POST", "/api/v1/clips/$clipId/sidecar?kind=$kind${if (encrypted) "&encrypted=1" else ""}")
        c.setRequestProperty("Content-Type", "application/octet-stream")
        c.doOutput = true
        c.setFixedLengthStreamingMode(bytes.size)
        c.outputStream.use { it.write(bytes) }
        readResponse(c)
    }

    /** Sends one chunk. Returns the server's new offset (also when it reports a different offset). */
    private fun patch(id: String, offset: Long, buf: ByteArray, n: Int): Long {
        val c = open("POST", "/api/v1/uploads/$id")
        c.setRequestProperty("X-HTTP-Method-Override", "PATCH")
        c.setRequestProperty("Upload-Offset", offset.toString())
        c.setRequestProperty("Content-Type", "application/offset+octet-stream")
        c.doOutput = true
        c.setFixedLengthStreamingMode(n)
        c.outputStream.use { it.write(buf, 0, n) }
        val code = c.responseCode
        val serverOffset = c.getHeaderField("Upload-Offset")?.toLongOrNull()
        try {
            if (code == 204 || code == 409) {
                return serverOffset ?: throw ServerException(code, "Server didn't report the upload offset")
            }
            throw ServerException(code, errorMessage(c))
        } finally {
            c.disconnect()
        }
    }

    private fun json(method: String, path: String, body: JSONObject?): JSONObject {
        val c = open(method, path)
        if (body != null) {
            val bytes = body.toString().toByteArray()
            c.setRequestProperty("Content-Type", "application/json")
            c.doOutput = true
            c.setFixedLengthStreamingMode(bytes.size)
            c.outputStream.use { it.write(bytes) }
        }
        val text = readResponse(c)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    private fun readResponse(c: HttpURLConnection): String {
        try {
            val code = c.responseCode
            if (code !in 200..299) throw ServerException(code, errorMessage(c))
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    private fun errorMessage(c: HttpURLConnection): String {
        val text = try { c.errorStream?.bufferedReader()?.use { it.readText() } } catch (_: Exception) { null }
        val msg = try { text?.let { JSONObject(it).optString("error") } } catch (_: Exception) { null }
        return msg?.takeIf { it.isNotBlank() } ?: "Server responded ${c.responseCode}"
    }

    private fun open(method: String, path: String): HttpURLConnection {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 120_000
        c.useCaches = false
        ServerConnection.applyPin(c, pin)
        token?.let { c.setRequestProperty("Authorization", "Bearer $it") }
        c.setRequestProperty("Accept", "application/json")
        return c
    }

    companion object {
        private const val CHUNK = 4 * 1024 * 1024

        data class QrPayload(val url: String, val code: String, val homeUrl: String?, val fingerprint: String?)

        /** Reads a QR payload: {"odc":1,"url":"https://...","code":"ABCD2345","home":"https://192.168.1.50:8443","fp":"..."}. */
        fun parseQr(text: String): QrPayload? = try {
            val o = JSONObject(text)
            if (o.optInt("odc") != 1) null
            else QrPayload(o.getString("url"), o.getString("code"), o.optString("home").ifBlank { null }, o.optString("fp").ifBlank { null })
        } catch (e: Exception) {
            null
        }

        /** A client for the paired server, at its home address when reachable. Does network I/O; call off the main thread. */
        fun forSettings(context: android.content.Context, settings: org.opendashcam.settings.OdcSettings): ServerClient =
            ServerClient(ServerConnection.baseUrl(context, settings), settings.serverToken, settings.serverCertPin.ifBlank { null })
    }
}
