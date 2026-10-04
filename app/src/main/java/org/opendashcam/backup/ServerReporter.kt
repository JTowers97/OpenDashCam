package org.opendashcam.backup

import android.content.Context
import android.os.Build
import org.json.JSONObject
import org.opendashcam.AppVersion
import org.opendashcam.settings.OdcSettings
import java.util.concurrent.Executors
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.LinkedBlockingQueue

/**
 * Fire-and-forget reports to the ODC Server while recording: live position (every 5 s),
 * heartbeat (status every minute) and events (impact, overheating...). Never blocks recording;
 * if the server is unreachable, reports are dropped (the GPS track still uploads with the clips).
 */
object ServerReporter {
    // One worker thread and a short queue: stale positions are better dropped than sent late.
    private val executor = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, LinkedBlockingQueue(5), ThreadPoolExecutor.DiscardOldestPolicy())
    private var lastLive = 0L

    @Volatile var lastContactAt = 0L
        private set
    @Volatile var lastError: String? = null
        private set

    private fun submit(context: Context, block: (ServerClient) -> Unit) {
        val settings = OdcSettings(context)
        if (!settings.serverPaired) return
        val app = context.applicationContext
        executor.execute {
            try {
                block(ServerClient.forSettings(app, settings))
                lastContactAt = System.currentTimeMillis()
                lastError = null
            } catch (e: ServerException) {
                lastError = e.message
                if (e.status == 401) lastError = "The server no longer recognizes this phone. Pair it again."
            } catch (e: Exception) {
                lastError = "Can't reach the server (${e.javaClass.simpleName})"
            }
        }
    }

    fun live(context: Context, t: Long, lat: Double, lon: Double, speed: Float?, course: Float?, acc: Float?) {
        val settings = OdcSettings(context)
        if (!settings.serverLiveEnabled) return
        val now = System.currentTimeMillis()
        if (now - lastLive < 5_000) return
        lastLive = now
        submit(context) { it.live(t, lat, lon, speed, course, acc) }
    }

    fun heartbeat(context: Context, battery: Int, charging: Boolean, thermal: Int, recording: Boolean, mode: String, storageFree: Long) {
        submit(context) {
            it.heartbeat(
                JSONObject()
                    .put("battery", battery).put("charging", charging).put("thermal", thermal)
                    .put("recording", recording).put("mode", mode).put("storageFreeBytes", storageFree)
                    .put("appVersion", AppVersion.full).put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}")
            )
        }
    }

    fun event(context: Context, type: String, message: String) {
        submit(context) { it.event(type, message) }
    }

    /** An event with a photo; falls back to a plain event if the photo can't be sent. */
    fun eventWithPhoto(context: Context, type: String, message: String, jpeg: ByteArray?) {
        submit(context) { c ->
            if (jpeg == null) c.event(type, message)
            else try { c.eventWithPhoto(type, message, jpeg) } catch (_: Exception) { c.event(type, message) }
        }
    }
}
