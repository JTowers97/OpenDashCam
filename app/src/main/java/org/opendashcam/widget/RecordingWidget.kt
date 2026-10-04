package org.opendashcam.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import org.opendashcam.R
import org.opendashcam.autostart.AutoStart
import org.opendashcam.recording.RecordingService
import org.opendashcam.ui.MainActivity

/** Home-screen widget: recording status and a Start/Stop button. */
class RecordingWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { manager.updateAppWidget(it, views(context)) }
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_STOP) {
            RecordingService.stop(context)
        }
    }

    companion object {
        private const val ACTION_STOP = "org.opendashcam.widget.STOP"

        private fun views(context: Context): RemoteViews {
            val s = RecordingService.state.value
            val v = RemoteViews(context.packageName, R.layout.widget_recording)
            v.setTextViewText(R.id.widget_status, if (s.active) "● Recording · ${s.mode.label}" else "Not recording")
            v.setTextViewText(R.id.widget_button, if (s.active) "Stop" else "Start")
            val click = if (s.active) {
                PendingIntent.getBroadcast(
                    context, 20, Intent(context, RecordingWidget::class.java).setAction(ACTION_STOP),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            } else {
                PendingIntent.getActivity(
                    context, 21,
                    Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra(AutoStart.EXTRA_AUTO_START, "widget"),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                )
            }
            v.setOnClickPendingIntent(R.id.widget_button, click)
            v.setOnClickPendingIntent(
                R.id.widget_root,
                PendingIntent.getActivity(context, 22, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE),
            )
            return v
        }

        /** Refreshes all ODC widgets and the Quick Settings tile (called when recording starts or stops). */
        fun update(context: Context) {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(ComponentName(context, RecordingWidget::class.java))
            if (ids.isNotEmpty()) mgr.updateAppWidget(ids, views(context))
            RecordingTileService.update(context)
        }
    }
}
