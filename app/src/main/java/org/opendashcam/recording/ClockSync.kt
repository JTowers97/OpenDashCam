package org.opendashcam.recording

import android.location.Location
import android.location.LocationManager
import android.os.SystemClock
import kotlin.math.abs

/**
 * Corrects for a phone clock that's off, so clip names, burned-in timestamps and multi-camera sync use
 * accurate time. GPS time is preferred (it's atomic-clock accurate); the ODC Server's clock is used when
 * there's no recent GPS fix. Small differences (under 200 ms) are ignored to avoid jitter.
 */
object ClockSync {
    @Volatile var offsetMs = 0L
        private set
    @Volatile var source = "phone"
        private set
    @Volatile private var lastGpsAt = 0L

    fun now(): Long = System.currentTimeMillis() + offsetMs

    fun fromGps(loc: Location) {
        if (loc.provider != LocationManager.GPS_PROVIDER) return
        val ageMs = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000
        if (ageMs < 0 || ageMs > 5_000) return
        val off = loc.time + ageMs - System.currentTimeMillis()
        if (abs(off) > 86_400_000L) return // nonsense; ignore
        apply(off)
        source = "gps"
        lastGpsAt = SystemClock.elapsedRealtime()
    }

    /** serverNow from a response; t0/t1 = phone time just before and after the request. */
    fun fromServer(serverNow: Long, t0: Long, t1: Long) {
        if (source == "gps" && SystemClock.elapsedRealtime() - lastGpsAt < 30 * 60_000) return
        if (t1 - t0 > 5_000) return // too slow to be accurate
        val off = serverNow - (t0 + t1) / 2
        if (abs(off) > 86_400_000L) return
        apply(off)
        source = "server"
    }

    private fun apply(off: Long) {
        if (abs(off - offsetMs) >= 200) offsetMs = off
    }
}
