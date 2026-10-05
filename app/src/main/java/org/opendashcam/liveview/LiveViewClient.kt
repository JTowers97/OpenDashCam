package org.opendashcam.liveview

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import org.opendashcam.backup.ServerClient
import org.opendashcam.recording.CameraStreamRecorder
import org.opendashcam.recording.Notifier
import org.opendashcam.settings.OdcSettings
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Live view while recording: keeps one long-poll open to the ODC Server ("anything for me?"). When someone
 * starts a live view of this car, it sends a picture from each camera 1–2 times a second until the server says
 * to stop. Runs only while recording, only if "Allow live view" is on, and shows a notification while watched.
 */
class LiveViewClient(
    private val context: Context,
    private val settings: OdcSettings,
    /** Current recorders (one per camera), read each time a frame is sent. */
    private val recorders: () -> List<CameraStreamRecorder>,
) {
    companion object {
        private const val TAG = "OdcLiveView"
        private val _watching = MutableStateFlow(false)
        val watching: StateFlow<Boolean> = _watching.asStateFlow()
    }

    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        if (running || !settings.serverPaired || !settings.liveViewAllowed) return
        running = true
        thread = Thread({ loop() }, "odc-live-view").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
        setWatching(false)
    }

    private fun setWatching(on: Boolean) {
        if (_watching.value == on) return
        _watching.value = on
        Notifier.liveView(context, on)
    }

    private fun loop() {
        var backoff = 2_000L
        while (running) {
            try {
                val offer = ServerClient.forSettings(context, settings).liveViewWait()
                backoff = 2_000L
                if (offer != null && running) stream(offer)
            } catch (e: InterruptedException) {
                return
            } catch (e: Exception) {
                // No connection or server unavailable: try again later.
                try { Thread.sleep(backoff) } catch (_: InterruptedException) { return }
                backoff = minOf(60_000L, backoff * 2)
            }
        }
    }

    private fun stream(first: JSONObject) {
        val session = first.getString("session")
        var fps = first.optDouble("fps", 1.0).coerceIn(0.2, 4.0)
        var maxWidth = first.optInt("maxWidth", 960)
        val client = ServerClient.forSettings(context, settings)
        setWatching(true)
        try {
            while (running) {
                val started = System.currentTimeMillis()
                var keepGoing = false
                for (r in recorders()) {
                    val jpeg = snapshot(r, maxWidth) ?: continue
                    val ans = client.liveViewFrame(session, r.profile.label, r.profile.cameraName, jpeg)
                    keepGoing = keepGoing || ans.optBoolean("continue", false)
                    fps = ans.optDouble("fps", fps).coerceIn(0.2, 4.0)
                    maxWidth = ans.optInt("maxWidth", maxWidth)
                }
                if (!keepGoing) break
                val wait = (1000 / fps).toLong() - (System.currentTimeMillis() - started)
                if (wait > 0) Thread.sleep(wait)
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (e: Exception) {
            Log.w(TAG, "live view stopped: ${e.message}")
        } finally {
            setWatching(false)
        }
    }

    private fun snapshot(r: CameraStreamRecorder, maxWidth: Int): ByteArray? {
        val latch = CountDownLatch(1)
        var out: ByteArray? = null
        r.requestSnapshot(maxWidth, 70) { jpeg -> out = jpeg; latch.countDown() }
        latch.await(3, TimeUnit.SECONDS)
        return out
    }
}
