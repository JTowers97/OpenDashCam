package org.opendashcam.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.SystemClock
import org.opendashcam.settings.Sensitivity
import kotlin.math.sqrt

/**
 * G-sensor impact detection. Uses the linear-acceleration sensor (gravity removed) when the phone
 * has one, otherwise filters gravity out of the raw accelerometer itself.
 */
class ImpactDetector(context: Context, private val onImpact: (gForce: Float) -> Unit) : SensorEventListener {

    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val linear = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val sensor = linear ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    private val gravity = FloatArray(3)
    private var samples = 0
    private var lastImpact = 0L

    @Volatile var thresholdG = 2.0f

    fun start(handler: Handler): Boolean {
        val s = sensor ?: return false
        samples = 0
        return sensorManager.registerListener(this, s, SensorManager.SENSOR_DELAY_GAME, handler)
    }

    fun stop() {
        sensorManager.unregisterListener(this)
    }

    override fun onSensorChanged(event: SensorEvent) {
        var x = event.values[0]
        var y = event.values[1]
        var z = event.values[2]
        if (linear == null) {
            // Low-pass filter isolates gravity; subtract it to get linear acceleration.
            val a = 0.8f
            gravity[0] = a * gravity[0] + (1 - a) * x
            gravity[1] = a * gravity[1] + (1 - a) * y
            gravity[2] = a * gravity[2] + (1 - a) * z
            x -= gravity[0]; y -= gravity[1]; z -= gravity[2]
        }
        // Ignore the first second while filters settle.
        if (samples < 50) {
            samples++
            return
        }
        val g = sqrt(x * x + y * y + z * z) / SensorManager.GRAVITY_EARTH
        val now = SystemClock.elapsedRealtime()
        if (g >= thresholdG && now - lastImpact > 10_000) {
            lastImpact = now
            onImpact(g)
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    companion object {
        fun isAvailable(context: Context): Boolean {
            val sm = context.getSystemService(SensorManager::class.java)
            return sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null
        }

        /** Parked cars only get bumped, so parking thresholds are much lower than driving ones. */
        fun threshold(sensitivity: Sensitivity, parking: Boolean): Float = when (sensitivity) {
            Sensitivity.LOW -> if (parking) 1.5f else 3.0f
            Sensitivity.MEDIUM -> if (parking) 0.8f else 2.0f
            Sensitivity.HIGH -> if (parking) 0.4f else 1.3f
        }
    }
}
