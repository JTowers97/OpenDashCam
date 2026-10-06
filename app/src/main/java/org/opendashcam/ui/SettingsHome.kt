package org.opendashcam.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.opendashcam.AppVersion
import org.opendashcam.settings.OdcSettings

/**
 * The top of Settings: one entry per category, each with a one-line summary of how it's set up, and a search box
 * that finds any setting by name.
 */
@Composable
fun SettingsHome(settings: OdcSettings, onBack: () -> Unit, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    var query by rememberSaveable { mutableStateOf("") }
    val categories = SETTINGS_CATEGORIES.filter { it.first != "command" || !settings.dashcamOnly }
    val titles = categories.toMap()
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ScreenHeader("Settings", onBack)
        OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text("Search settings") }, modifier = Modifier.fillMaxWidth())
        val q = query.trim().lowercase()
        if (q.isNotEmpty()) {
            val hits = SETTINGS_INDEX.filter { (t, c) -> c in titles && t.lowercase().contains(q) }
            if (hits.isEmpty()) Hint("No settings match “$query”.")
            hits.forEach { (title, cat) ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable { onOpen(cat) }) {
                    Column(Modifier.padding(12.dp)) { Text(title); Hint("in ${titles[cat]}") }
                }
            }
        } else {
            categories.forEach { (key, title) ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = Modifier.fillMaxWidth().clickable { onOpen(key) }) {
                    Column(Modifier.padding(14.dp)) {
                        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        Hint(summary(settings, key))
                    }
                }
            }
        }
    }
}

/** How a category is set up, in a few words. */
private fun summary(s: OdcSettings, key: String): String = when (key) {
    "dashcam" -> listOfNotNull(
        "${if (s.resolution == 2160) "4K" else "${s.resolution}p"} · ${s.fps} fps",
        "${s.segmentMinutes} min clips",
        if (s.parkingEnabled) "parking mode on" else "parking mode off",
        if (s.overlayEnabled) "date/time stamp" else null,
        if (s.impactEnabled) "impact detection" else null,
        if (s.autoStartCharging || s.autoStartBluetooth) "auto-start" else null,
    ).joinToString(" · ")
    "backup" -> listOfNotNull(
        if (s.serverPaired) "ODC Server (${s.serverCarName.ifBlank { "paired" }})" else null,
        if (s.smbEnabled) "SMB share" else null,
    ).ifEmpty { listOf("Not set up: footage stays on this phone") }.joinToString(" · ") +
        if (s.serverPaired || s.smbEnabled) (if (s.backupCellular) " · Wi-Fi and mobile data" else if (s.backupEventsOnMobile) " · Wi-Fi (impact clips on mobile data)" else " · Wi-Fi only") else ""
    "command" -> if (s.ccSignedIn) "Signed in as ${s.ccUsername} · alerts ${mapOf("unifiedpush" to "via UnifiedPush", "direct" to "via direct connection", "off" to "off")[s.ccDelivery]}"
        else "Not set up: manage your ODC Server and get its alerts on this phone"
    "app" -> listOfNotNull(
        "Opens in ${if (s.ccDefault && s.ccSignedIn) "Command Center" else "Dashcam Mode"}",
        mapOf("dark" to "dark theme", "light" to "light theme", "system" to "theme follows the phone")[s.themeMode],
        if (s.appLock) "app lock on" else null,
        if (s.dashcamOnly) "dashcam only" else null,
    ).joinToString(" · ")
    else -> "Open Dash Cam ${AppVersion.full} · run setup again · privacy"
}
