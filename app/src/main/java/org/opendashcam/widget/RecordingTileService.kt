package org.opendashcam.widget

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import org.opendashcam.autostart.AutoStart
import org.opendashcam.recording.RecordingService
import org.opendashcam.ui.MainActivity

/**
 * Quick Settings tile: shows whether ODC is recording; tap to start (opens ODC, since Android only lets an
 * app start the camera while it's on screen) or stop. Meant for before driving.
 */
class RecordingTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        refresh()
    }

    override fun onClick() {
        super.onClick()
        if (RecordingService.state.value.active) {
            RecordingService.stop(this)
            refresh()
            return
        }
        val intent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(AutoStart.EXTRA_AUTO_START, "tile")
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 10, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun refresh() {
        val tile = qsTile ?: return
        val active = RecordingService.state.value.active
        tile.state = if (active) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = "Dashcam"
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = if (active) "Recording" else "Off"
        tile.updateTile()
    }

    companion object {
        /** Asks Android to refresh the tile (called when recording starts or stops). */
        fun update(context: Context) {
            try { requestListeningState(context, ComponentName(context, RecordingTileService::class.java)) } catch (_: Exception) {}
        }
    }
}
