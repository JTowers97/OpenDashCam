package org.opendashcam.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.PrivacyZone
import java.util.Locale

/**
 * Privacy zones are added at the phone's current location for now.
 * Drawing zones on a map will come with the map view.
 */
@Composable
fun PrivacyZonesScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var zones by remember { mutableStateOf(settings.privacyZones) }
    var name by remember { mutableStateOf("Home") }
    var radius by remember { mutableStateOf(250) }
    var disableParking by remember { mutableStateOf(true) }
    var locating by remember { mutableStateOf(false) }

    fun save(newZones: List<PrivacyZone>) {
        settings.privacyZones = newZones
        zones = newZones
    }

    fun addAtCurrentLocation() {
        locating = true
        currentLocation(context) { loc ->
            locating = false
            if (loc == null) {
                Toast.makeText(context, "Couldn't get your location. Go outside or near a window and try again.", Toast.LENGTH_LONG).show()
            } else {
                save(
                    zones + PrivacyZone(
                        name = name.ifBlank { "Zone ${zones.size + 1}" },
                        lat = loc.latitude, lon = loc.longitude,
                        radiusM = radius, disableParking = disableParking,
                    )
                )
                Toast.makeText(context, "Privacy zone added.", Toast.LENGTH_SHORT).show()
            }
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) addAtCurrentLocation()
    }

    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ScreenHeader("Privacy zones", onBack)
        Hint("Inside a zone ODC never logs your location. If parking mode is off for a zone, ODC pauses recording when you park there and resumes when you start the car.")

        SectionHeader("Your zones")
        if (zones.isEmpty()) Hint("No zones yet.")
        zones.forEach { z ->
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(z.name, fontWeight = FontWeight.Bold)
                    Hint(String.format(Locale.US, "%d m around %.4f, %.4f", z.radiusM, z.lat, z.lon))
                    SwitchRow(
                        title = "Parking mode off here",
                        checked = z.disableParking,
                        onChange = { on -> save(zones.map { if (it.id == z.id) it.copy(disableParking = on) else it }) },
                    )
                    TextButton(onClick = { save(zones.filter { it.id != z.id }) }) { Text("Remove zone") }
                }
            }
        }

        SectionHeader("Add a zone where you are now")
        OutlinedTextField(
            value = name,
            onValueChange = { name = it.take(40) },
            label = { Text("Name") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        ChoiceRow(
            title = "Radius",
            options = listOf(100, 250, 500, 1000),
            selected = radius,
            label = { "$it m" },
            onSelect = { radius = it },
        )
        SwitchRow(title = "Turn off parking mode here", checked = disableParking, onChange = { disableParking = it })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Button(
                enabled = !locating,
                onClick = {
                    if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) addAtCurrentLocation()
                    else permissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                },
            ) { Text(if (locating) "Finding your location…" else "Add zone here") }
        }
    }
}

/** One-shot location fix: a fresh GPS fix on Android 11+, otherwise the last known one. */
@SuppressLint("MissingPermission")
private fun currentLocation(context: Context, callback: (Location?) -> Unit) {
    val lm = context.getSystemService(LocationManager::class.java)
    try {
        if (Build.VERSION.SDK_INT >= 30) {
            val provider = if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER
            else LocationManager.NETWORK_PROVIDER
            lm.getCurrentLocation(provider, null, ContextCompat.getMainExecutor(context)) { loc ->
                callback(loc ?: lm.getLastKnownLocation(LocationManager.GPS_PROVIDER))
            }
        } else {
            callback(
                lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            )
        }
    } catch (e: Exception) {
        callback(null)
    }
}
