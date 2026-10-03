package org.opendashcam.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opendashcam.backup.OdcEncryption
import java.io.File

/** Remembers the passphrase briefly after it's entered, so opening several clips doesn't re-prompt. */
object PassphraseSession {
    private var value: String? = null
    private var at = 0L
    private const val VALID_MS = 5 * 60_000L

    fun get(): String? = value?.takeIf { System.currentTimeMillis() - at < VALID_MS }
    fun set(p: String) {
        value = p
        at = System.currentTimeMillis()
    }
}

/** Small, quiet key badge for encrypted clips (deliberately distinct from the "Locked" padlock). */
@Composable
fun EncryptedBadge(modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(20.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.55f)),
    ) {
        Canvas(Modifier.size(20.dp).padding(4.dp)) {
            val c = Color.White.copy(alpha = 0.85f)
            val w = size.width
            val stroke = w * 0.13f
            val r = w * 0.2f
            val bow = Offset(w * 0.28f, w * 0.5f)
            drawCircle(c, radius = r, center = bow, style = Stroke(width = stroke))
            drawLine(c, Offset(bow.x + r, bow.y), Offset(w * 0.95f, bow.y), strokeWidth = stroke)
            drawLine(c, Offset(w * 0.78f, bow.y), Offset(w * 0.78f, bow.y + w * 0.2f), strokeWidth = stroke)
            drawLine(c, Offset(w * 0.93f, bow.y), Offset(w * 0.93f, bow.y + w * 0.14f), strokeWidth = stroke)
        }
    }
}

/**
 * Asks for the passphrase to open an encrypted clip and checks it against the file before
 * accepting it. Calls [onResult] with the verified passphrase, or null on cancel.
 */
@Composable
fun EnterPassphraseDialog(file: File, onResult: (String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var checking by remember { mutableStateOf(false) }
    var wrong by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { onResult(null) },
        title = { Text("Enter your passphrase") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("This clip is encrypted. Clips encrypted before a passphrase change need the old passphrase.", style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it; wrong = false },
                    label = { Text("Passphrase") },
                    singleLine = true,
                    isError = wrong,
                    supportingText = { if (wrong) Text("That passphrase doesn't open this clip.") },
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = text.isNotEmpty() && !checking, onClick = {
                checking = true
                scope.launch {
                    val ok = withContext(Dispatchers.IO) { OdcEncryption.checkPassphrase(file, text) }
                    checking = false
                    if (ok) {
                        PassphraseSession.set(text)
                        onResult(text)
                    } else {
                        wrong = true
                    }
                }
            }) { Text(if (checking) "Checking…" else "Open") }
        },
        dismissButton = { TextButton(onClick = { onResult(null) }) { Text("Cancel") } },
    )
}

@Composable
fun ProgressDialog(title: String, progress: Float) {
    AlertDialog(
        onDismissRequest = {},
        title = { Text(title) },
        text = { LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth()) },
        confirmButton = {},
    )
}
