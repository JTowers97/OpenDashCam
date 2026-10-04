package org.opendashcam.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.backup.BackupStatus
import org.opendashcam.backup.SmbTarget
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.SmbConfig
import java.text.DateFormat
import java.util.Date

/** SMB connection fields with Save and Test. Keeps its own text state until saved. */
@Composable
fun SmbConfigEditor(settings: OdcSettings, onSaved: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val initial = remember { settings.smbConfig }
    var host by remember { mutableStateOf(initial.host) }
    var share by remember { mutableStateOf(initial.share) }
    var path by remember { mutableStateOf(initial.path) }
    var user by remember { mutableStateOf(initial.username) }
    var password by remember { mutableStateOf(initial.password) }
    var domain by remember { mutableStateOf(initial.domain) }
    var testing by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Field("Server (IP address or hostname)", host, { host = it }, "192.168.1.20")
        Field("Share name", share, { share = it }, "Dashcam")
        Field("Folder inside the share", path, { path = it }, "OpenDashCam")
        Field("Username", user, { user = it }, "Leave blank for guest access")
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Field("Domain or workgroup (optional)", domain, { domain = it }, "")
        Hint("Use the server's IP address if the name doesn't work; many phones can't look up local network names. The password is stored encrypted on this phone.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                enabled = !testing && host.isNotBlank() && share.isNotBlank(),
                onClick = {
                    val config = SmbConfig(host, share, path, user, password, domain)
                    settings.saveSmbConfig(config)
                    onSaved()
                    testing = true
                    result = null
                    scope.launch {
                        val msg = withContext(Dispatchers.IO) {
                            try {
                                val enc = SmbTarget(settings.smbConfig).use { it.test() }
                                settings.smbEncrypted = when (enc) { true -> "yes"; false -> "no"; null -> "" }
                                "✓ Connected and able to write to the folder. " + when (enc) {
                                    true -> "Traffic to this share is encrypted."
                                    false -> "⚠ Traffic to this share isn't encrypted. We recommend turning on SMB encryption for the share on your NAS or computer."
                                    null -> "Couldn't tell whether traffic is encrypted; we recommend turning on SMB encryption for the share."
                                }
                            } catch (e: Exception) {
                                "✗ ${e.message ?: e.javaClass.simpleName}"
                            }
                        }
                        testing = false
                        result = msg
                        if (msg.startsWith("✓")) BackupScheduler.kick(context, replace = true)
                    }
                },
            ) { Text(if (testing) "Testing…" else "Save and test") }
        }
        result?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodyMedium,
                color = if (it.startsWith("✓")) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
            )
        }
    }
}

@Composable
private fun Field(label: String, value: String, onChange: (String) -> Unit, placeholder: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        placeholder = { if (placeholder.isNotEmpty()) Text(placeholder) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Live status: what's uploading, how many clips are waiting, last success. */
@Composable
fun BackupStatusPanel() {
    val context = LocalContext.current
    val status by BackupStatus.state.collectAsStateWithLifecycle()
    Column(Modifier.padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (status.running) {
            Text("Uploading ${status.currentClip ?: ""}", style = MaterialTheme.typography.bodyMedium)
            LinearProgressIndicator(progress = { status.progress }, modifier = Modifier.fillMaxWidth())
        }
        status.message?.let {
            Text(
                it, style = MaterialTheme.typography.bodySmall,
                color = if (status.error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (status.pending > 0) Hint("${status.pending} clips waiting to upload.")
        if (status.lastSuccessAt > 0) {
            Hint("Last upload: " + DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(status.lastSuccessAt)))
        }
        OutlinedButton(onClick = { BackupScheduler.kick(context, replace = true) }) { Text("Back up now") }
        Hint("Uploads start when your network and charging rules allow.")
    }
}

/** Asks for the upload passphrase twice. Returns null on cancel. */
@Composable
fun PassphraseDialog(onDone: (String?) -> Unit) {
    var p1 by remember { mutableStateOf("") }
    var p2 by remember { mutableStateOf("") }
    val valid = p1.length >= 8 && p1 == p2
    AlertDialog(
        onDismissRequest = { onDone(null) },
        title = { Text("Set an encryption passphrase") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "Uploads will be encrypted on this phone before they leave it. You'll need this passphrase to " +
                        "open them, using the odc_decrypt tool (or the ODC Server later). If you lose it, the uploaded footage " +
                        "can't be recovered by anyone.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = p1, onValueChange = { p1 = it }, label = { Text("Passphrase (8+ characters)") },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = p2, onValueChange = { p2 = it }, label = { Text("Repeat passphrase") },
                    singleLine = true, visualTransformation = PasswordVisualTransformation(),
                    isError = p2.isNotEmpty() && p1 != p2,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = { TextButton(enabled = valid, onClick = { onDone(p1) }) { Text("Turn on encryption") } },
        dismissButton = { TextButton(onClick = { onDone(null) }) { Text("Cancel") } },
    )
}
