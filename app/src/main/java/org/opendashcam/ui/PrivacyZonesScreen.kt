@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.FillLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.opendashcam.settings.OdcSettings
import org.opendashcam.settings.PrivacyZone

/**
 * Privacy zones on a map: tap the map to add a zone, tap a zone to edit it, tap again to move it.
 * Inside a zone ODC logs no location; optionally parking mode is off there.
 */
@Composable
fun PrivacyZonesScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var zones by remember { mutableStateOf(settings.privacyZones) }
    var draft by remember { mutableStateOf<PrivacyZone?>(null) }
    var isNew by remember { mutableStateOf(false) }
    val mapRef = remember { mutableStateOf<Pair<MapLibreMap, Style>?>(null) }
    val zonesNow = remember { mutableStateOf(zones) }
    val draftNow = remember { mutableStateOf<PrivacyZone?>(null) }
    zonesNow.value = zones
    draftNow.value = draft

    fun save(newZones: List<PrivacyZone>) {
        settings.privacyZones = newZones
        zones = newZones
    }

    fun moveCamera(lat: Double, lon: Double, zoom: Double = 15.0) {
        mapRef.value?.first?.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(lat, lon), zoom))
    }

    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
            currentLocation(context) { loc -> loc?.let { moveCamera(it.latitude, it.longitude) } }
        }
    }

    // Redraw zones and the zone being edited whenever they change.
    LaunchedEffect(zones, draft, mapRef.value) {
        val (_, style) = mapRef.value ?: return@LaunchedEffect
        val shown = zones.filter { it.id != draft?.id }.map { z ->
            Feature.fromGeometry(circlePolygon(LatLng(z.lat, z.lon), z.radiusM.toDouble()))
        }
        (style.getSource("zones") as? GeoJsonSource)?.setGeoJson(FeatureCollection.fromFeatures(shown))
        val d = draft
        (style.getSource("draft") as? GeoJsonSource)?.setGeoJson(
            FeatureCollection.fromFeatures(
                if (d == null) emptyList() else listOf(Feature.fromGeometry(circlePolygon(LatLng(d.lat, d.lon), d.radiusM.toDouble())))
            )
        )
    }

    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            ScreenHeader("Privacy zones", onBack)
            Hint("Tap the map to add a zone, or tap a zone to change it. Inside a zone ODC logs no location, and parking mode can be turned off there.")
        }
        OdcMap(Modifier.fillMaxWidth().weight(1f).padding(top = 8.dp)) { map, style ->
            style.addSource(GeoJsonSource("zones"))
            style.addSource(GeoJsonSource("draft"))
            style.addLayer(FillLayer("zones-fill", "zones").withProperties(PropertyFactory.fillColor("#3d8bff"), PropertyFactory.fillOpacity(0.2f)))
            style.addLayer(LineLayer("zones-line", "zones").withProperties(PropertyFactory.lineColor("#3d8bff"), PropertyFactory.lineWidth(2f)))
            style.addLayer(FillLayer("draft-fill", "draft").withProperties(PropertyFactory.fillColor("#ff5a36"), PropertyFactory.fillOpacity(0.25f)))
            style.addLayer(LineLayer("draft-line", "draft").withProperties(PropertyFactory.lineColor("#ff5a36"), PropertyFactory.lineWidth(3f)))
            map.addOnMapClickListener { at ->
                val editing = draftNow.value
                if (editing != null) {
                    // Move the zone being edited.
                    draft = editing.copy(lat = at.latitude, lon = at.longitude)
                } else {
                    val hit = zonesNow.value.firstOrNull { z ->
                        val d = FloatArray(1)
                        Location.distanceBetween(at.latitude, at.longitude, z.lat, z.lon, d)
                        d[0] <= z.radiusM
                    }
                    if (hit != null) {
                        draft = hit
                        isNew = false
                    } else {
                        draft = PrivacyZone(
                            name = if (zonesNow.value.isEmpty()) "Home" else "Zone ${zonesNow.value.size + 1}",
                            lat = at.latitude, lon = at.longitude, radiusM = 250, disableParking = true,
                        )
                        isNew = true
                    }
                }
                true
            }
            // Start on the existing zones, or on the phone's last known position.
            val existing = zonesNow.value
            when {
                existing.size == 1 -> map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(existing[0].lat, existing[0].lon), 14.0))
                existing.size > 1 -> {
                    val b = LatLngBounds.Builder()
                    existing.forEach { b.include(LatLng(it.lat, it.lon)) }
                    map.moveCamera(CameraUpdateFactory.newLatLngBounds(b.build(), 120))
                }
                else -> lastKnown(context)?.let { map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(it.latitude, it.longitude), 14.0)) }
                    ?: map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(39.5, -98.35), 3.0))
            }
            mapRef.value = map to style
        }

        // Bottom panel: edit the selected zone, or list zones.
        Column(
            Modifier.fillMaxWidth().heightIn(max = 340.dp).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val d = draft
            if (d != null) {
                Text(if (isNew) "New zone" else "Edit zone", fontWeight = FontWeight.Bold)
                Hint("Tap the map to move it.")
                OutlinedTextField(
                    value = d.name, onValueChange = { draft = d.copy(name = it.take(40)) },
                    label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                SliderRow(
                    title = "Radius", value = d.radiusM / 50, range = 1..40,
                    valueLabel = { r -> formatDistance(r * 50, settings.resolvedSpeedUnit == org.opendashcam.settings.SpeedUnit.MPH) },
                    onChange = { r -> draft = d.copy(radiusM = r * 50) },
                )
                SwitchRow(title = "Turn off parking mode here", checked = d.disableParking, onChange = { draft = d.copy(disableParking = it) })
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = {
                        val named = d.copy(name = d.name.ifBlank { "Zone" })
                        save(if (isNew) zones + named else zones.map { if (it.id == d.id) named else it })
                        draft = null
                        Toast.makeText(context, "Privacy zone saved.", Toast.LENGTH_SHORT).show()
                    }) { Text("Save") }
                    TextButton(onClick = { draft = null }) { Text("Cancel") }
                    if (!isNew) TextButton(onClick = { save(zones.filter { it.id != d.id }); draft = null }) { Text("Delete") }
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = {
                        if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) {
                            currentLocation(context) { loc ->
                                if (loc == null) Toast.makeText(context, "Couldn't get your location.", Toast.LENGTH_SHORT).show()
                                else moveCamera(loc.latitude, loc.longitude)
                            }
                        } else {
                            permissionLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        }
                    }) { Text("Go to my location") }
                }
                if (zones.isEmpty()) Hint("No zones yet. Tap the map where you'd like one, such as your home.")
                zones.forEach { z ->
                    Card(
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { draft = z; isNew = false; moveCamera(z.lat, z.lon) },
                    ) {
                        Column(Modifier.padding(12.dp)) {
                            Text(z.name, fontWeight = FontWeight.Bold)
                            Hint(
                                formatDistance(z.radiusM, settings.resolvedSpeedUnit == org.opendashcam.settings.SpeedUnit.MPH) + " radius" +
                                    if (z.disableParking) " · parking mode off" else ""
                            )
                        }
                    }
                }
            }
        }
    }
}

private fun formatDistance(meters: Int, imperial: Boolean): String =
    if (imperial) "${Math.round(meters / 0.3048 / 10) * 10} ft" else "$meters m"

@SuppressLint("MissingPermission")
private fun lastKnown(context: Context): Location? = try {
    if (!granted(context, Manifest.permission.ACCESS_FINE_LOCATION)) null
    else context.getSystemService(LocationManager::class.java).let { lm ->
        lm.getLastKnownLocation(LocationManager.GPS_PROVIDER) ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
    }
} catch (e: Exception) {
    null
}

/** One-shot location fix: a fresh fix on Android 11+, otherwise the last known one. */
@SuppressLint("MissingPermission")
private fun currentLocation(context: Context, callback: (Location?) -> Unit) {
    val lm = context.getSystemService(LocationManager::class.java)
    try {
        if (Build.VERSION.SDK_INT >= 30) {
            val provider = if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else LocationManager.NETWORK_PROVIDER
            lm.getCurrentLocation(provider, null, ContextCompat.getMainExecutor(context)) { loc -> callback(loc ?: lastKnown(context)) }
        } else {
            callback(lastKnown(context))
        }
    } catch (e: Exception) {
        callback(null)
    }
}
