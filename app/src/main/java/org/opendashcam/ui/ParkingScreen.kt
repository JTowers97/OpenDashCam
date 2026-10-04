package org.opendashcam.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.Point
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date
import java.util.Locale

data class ParkingSpot(val lat: Double, val lon: Double, val at: Long)

fun parkingSpot(settings: OdcSettings): ParkingSpot? = settings.parkedAt.split(',').takeIf { it.size == 3 }?.let {
    val lat = it[0].toDoubleOrNull()
    val lon = it[1].toDoubleOrNull()
    val at = it[2].toLongOrNull()
    if (lat != null && lon != null && at != null) ParkingSpot(lat, lon, at) else null
}

/** "Where did I park?": the last GPS position saved when parking mode started or recording/tracking stopped. */
@Composable
fun ParkingScreen(settings: OdcSettings, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val spot = parkingSpot(settings)
    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            ScreenHeader("Where I parked", onBack)
            if (spot == null) {
                Text("No parking spot saved yet.", fontWeight = FontWeight.Bold)
                Hint("ODC saves where the car is when parking mode starts or recording stops, and the last position in tracking-only mode. It needs GPS logging (Settings → Location) and doesn't save inside privacy zones.")
                return@Column
            }
            val ago = (System.currentTimeMillis() - spot.at) / 60_000
            Text(
                "Parked " + when {
                    ago < 1 -> "just now"
                    ago < 60 -> "$ago min ago"
                    ago < 24 * 60 -> "${ago / 60} h ${ago % 60} min ago"
                    else -> "on " + DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(spot.at))
                } + " · " + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(spot.at)),
                fontWeight = FontWeight.Bold,
            )
            Hint(String.format(Locale.US, "%.5f, %.5f", spot.lat, spot.lon))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                Button(onClick = {
                    val label = Uri.encode("My car")
                    val uri = Uri.parse("geo:${spot.lat},${spot.lon}?q=${spot.lat},${spot.lon}($label)")
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                    } catch (_: Exception) {
                        Toast.makeText(context, "No maps app found.", Toast.LENGTH_LONG).show()
                    }
                }) { Text("Navigate there") }
                OutlinedButton(onClick = {
                    val text = "My car is parked here: https://www.openstreetmap.org/?mlat=${spot.lat}&mlon=${spot.lon}#map=18/${spot.lat}/${spot.lon}"
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share location"))
                }) { Text("Share") }
            }
        }
        if (spot != null) {
            OdcMap(Modifier.fillMaxWidth().weight(1f)) { map, style ->
                style.addSource(GeoJsonSource("car", Feature.fromGeometry(Point.fromLngLat(spot.lon, spot.lat))))
                style.addLayer(CircleLayer("car-halo", "car").withProperties(PropertyFactory.circleRadius(18f), PropertyFactory.circleColor("#ff5a36"), PropertyFactory.circleOpacity(0.25f)))
                style.addLayer(CircleLayer("car-dot", "car").withProperties(PropertyFactory.circleRadius(9f), PropertyFactory.circleColor("#ff5a36"), PropertyFactory.circleStrokeColor("#ffffff"), PropertyFactory.circleStrokeWidth(3f)))
                map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(spot.lat, spot.lon), 17.0))
            }
        }
    }
}
