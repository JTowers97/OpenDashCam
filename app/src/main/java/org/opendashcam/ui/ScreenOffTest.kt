package org.opendashcam.ui

import android.Manifest
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date

/** "Works on this phone (checked Oct 3)" etc. */
fun screenOffStatus(settings: OdcSettings): String {
    val at = settings.screenOffCheckedAt.toLongOrNull()?.let { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it)) }
    return when (settings.screenOffResult) {
        "pass" -> "Screen-off recording works on this phone (checked $at)."
        "fail" -> "Screen-off recording stalled on this phone (checked $at). Use dimmed-screen mode."
        else -> "Not tested on this phone yet. ODC checks automatically whenever the screen is off for 20 seconds while recording."
    }
}

/** Guided test: record, turn the screen off for 30 s, turn it back on, see the result. */
@Composable
fun ScreenOffTestDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val state by RecordingService.state.collectAsStateWithLifecycle()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Test screen-off recording") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Some phones stop recording when the screen turns off. This checks yours:")
                Text("1. Start recording below.")
                Text("2. Press the power button to turn the screen off, and wait 30 seconds.")
                Text("3. Turn the screen back on and come back to ODC.")
                when {
                    state.screenOffCheck != null -> Text(state.screenOffCheck!!, style = MaterialTheme.typography.bodyLarge)
                    state.active -> Text("Recording. Turn the screen off now for 30 seconds.", color = MaterialTheme.colorScheme.primary)
                }
                if (!granted(context, Manifest.permission.CAMERA)) {
                    Text("Camera permission is needed first.", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            if (!state.active) {
                TextButton(enabled = granted(context, Manifest.permission.CAMERA), onClick = { RecordingService.start(context) }) { Text("Start recording") }
            } else {
                OutlinedButton(onClick = { RecordingService.stop(context) }) { Text("Stop recording") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Close") } },
    )
}
