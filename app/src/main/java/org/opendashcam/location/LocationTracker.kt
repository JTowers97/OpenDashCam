package org.opendashcam.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import androidx.core.content.ContextCompat
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.PrivacyZone

data class TrackPoint(
    val time: Long,
    val lat: Double,
    val lon: Double,
    val altitude: Double?,
    val speedMps: Float?,
    val bearing: Float?,
    val accuracyM: Float?,
)

/**
 * GPS logging using the platform LocationManager (no Google Play Services, so it works on
 * de-Googled phones and qualifies for F-Droid). Points inside privacy zones are never stored.
 */
class LocationTracker(context: Context, settings: OdcSettings) {

    fun interface Listener {
        fun onFix(speedMps: Float?, zone: PrivacyZone?)
    }

    private val appContext = context.applicationContext
    private val manager = context.getSystemService(LocationManager::class.java)
    private val zones = settings.privacyZones
    private val thread = HandlerThread("odc-gps").apply { start() }
    private val handler = Handler(thread.looper)
    private val points = ArrayDeque<TrackPoint>()
    private var running = false

    @Volatile var listener: Listener? = null
    @Volatile var lastLocation: Location? = null
        private set
    @Volatile var currentZone: PrivacyZone? = null
        private set

    // An explicit object (not a lambda): on Android 10 the other methods are still abstract,
    // and a lambda would crash with AbstractMethodError when the system calls them.
    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) = onLocation(location)
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
    }

    val hasPermission: Boolean
        get() = ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    fun start(intervalMs: Long) {
        if (!hasPermission) return
        handler.post {
            try {
                if (running) manager.removeUpdates(locationListener)
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, intervalMs, 0f, locationListener, thread.looper)
                running = true
            } catch (_: Exception) {
                running = false
            }
        }
    }

    fun stop() {
        handler.post {
            try { manager.removeUpdates(locationListener) } catch (_: Exception) {}
            running = false
        }
        thread.quitSafely()
    }

    /** Points recorded between two wall-clock times (inclusive), for a clip's sidecar files. */
    fun pointsBetween(start: Long, end: Long): List<TrackPoint> = synchronized(points) {
        points.filter { it.time in (start - 1000)..(end + 1000) }
    }

    private fun onLocation(loc: Location) {
        lastLocation = loc
        org.opendashcam.recording.ClockSync.fromGps(loc)
        val zone = zones.firstOrNull { z ->
            val d = FloatArray(1)
            Location.distanceBetween(loc.latitude, loc.longitude, z.lat, z.lon, d)
            d[0] <= z.radiusM
        }
        currentZone = zone
        val speed = if (loc.hasSpeed()) loc.speed else null
        if (zone == null) {
            val p = TrackPoint(
                time = loc.time,
                lat = loc.latitude,
                lon = loc.longitude,
                altitude = if (loc.hasAltitude()) loc.altitude else null,
                speedMps = speed,
                bearing = if (loc.hasBearing()) loc.bearing else null,
                accuracyM = if (loc.hasAccuracy()) loc.accuracy else null,
            )
            synchronized(points) {
                points.addLast(p)
                // Keep about 3 hours of 1-second fixes; older points are already in sidecar files.
                while (points.size > 11_000) points.removeFirst()
            }
        }
        listener?.onFix(speed, zone)
    }
}
