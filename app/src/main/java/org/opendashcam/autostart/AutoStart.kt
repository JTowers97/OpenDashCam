package org.opendashcam.autostart

import android.content.Context
import android.content.Intent
import android.provider.Settings
import org.opendashcam.recording.Notifier
import org.opendashcam.recording.RecordingService
import org.opendashcam.ui.MainActivity

/**
 * Android only lets a camera service start while the app is on screen, so auto-start opens
 * ODC's screen first, and the screen starts recording. Opening a screen from the background needs
 * the "Display over other apps" permission; without it, ODC posts a tap-to-start notification.
 */
object AutoStart {
    const val EXTRA_AUTO_START = "org.opendashcam.extra.AUTO_START"

    fun canOpenFromBackground(context: Context): Boolean = Settings.canDrawOverlays(context)

    fun launchRecording(context: Context, reason: String) {
        if (RecordingService.state.value.active) return
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_AUTO_START, reason)
        if (canOpenFromBackground(context)) {
            try {
                context.startActivity(intent)
                return
            } catch (_: Exception) {
            }
        }
        Notifier.autoStartPrompt(context, intent)
    }
}
