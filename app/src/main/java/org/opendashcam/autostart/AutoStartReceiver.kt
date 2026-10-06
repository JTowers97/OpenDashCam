package org.opendashcam.autostart

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.opendashcam.settings.OdcSettings
import org.opendashcam.tracking.TrackingService

/**
 * Manifest receiver for broadcasts Android still delivers to closed apps:
 *  - Bluetooth connected: start recording if it's one of the chosen car devices
 *  - Boot / app updated: bring back the charging standby if that auto-start is on
 */
class AutoStartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val settings = OdcSettings(context)
        if (!settings.onboardingDone) return
        when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> {
                if (!settings.autoStartBluetooth) return
                val device: BluetoothDevice? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                }
                val address = device?.address ?: return
                if (address in settings.autoStartBtDevices) AutoStart.launchRecording(context, "bluetooth")
            }
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (settings.autoStartCharging) StandbyService.start(context)
                // Command Center alerts over the direct connection resume after a restart.
                if (settings.ccSignedIn && settings.ccDelivery == "direct") org.opendashcam.command.AlertConnectionService.start(context)
                // Tracking-only mode resumes by itself only with "Allow all the time" location access.
                if (settings.trackingAfterRestart && TrackingService.hasBackgroundPermission(context)) TrackingService.start(context)
            }
        }
    }
}
