package org.opendashcam.ui

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.Style
import org.maplibre.android.style.expressions.Expression
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonOptions
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.FeatureCollection
import org.maplibre.geojson.Point
import org.opendashcam.backup.ServerClient
import org.opendashcam.settings.OdcSettings
import java.text.DateFormat
import java.util.Date

private enum class MapRange(val label: String, val days: Int) { WEEK("7 days", 7), MONTH("30 days", 30), ALL("All", 0) }

/**
 * Clips on the ODC Server shown where they were recorded. Nearby clips group into numbered circles;
 * tap one to zoom in, tap a single clip to see it and play it.
 */
@Composable
fun ServerMapScreen(settings: OdcSettings, onBack: () -> Unit, onOpenSync: (Long) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    var all by remember { mutableStateOf<List<JSONObject>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var range by remember { mutableStateOf(MapRange.MONTH) }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    val mapRef = remember { mutableStateOf<Pair<MapLibreMap, Style>?>(null) }
    val byId = remember { mutableStateOf<Map<String, JSONObject>>(emptyMap()) }

    LaunchedEffect(Unit) {
        val result = withContext(Dispatchers.IO) {
            try {
                val arr = ServerClient.forSettings(context, settings).locatedClips(1000)
                Result.success((0 until arr.length()).map { arr.getJSONObject(it) })
            } catch (e: Exception) {
                Result.failure(e)
            }
        }
        result.onSuccess { all = it }.onFailure { error = "Can't reach the server: ${it.message ?: it.javaClass.simpleName}" }
    }

    val shown = all?.filter { c ->
        range.days == 0 || c.getLong("startedAt") >= System.currentTimeMillis() - range.days * 86_400_000L
    }

    // Put the clips on the map and fit the view to them.
    LaunchedEffect(shown, mapRef.value) {
        val (map, style) = mapRef.value ?: return@LaunchedEffect
        val clips = shown ?: return@LaunchedEffect
        byId.value = clips.associateBy { it.getString("id") }
        val features = clips.map { c ->
            Feature.fromGeometry(Point.fromLngLat(c.getDouble("lon"), c.getDouble("lat"))).apply { addStringProperty("id", c.getString("id")) }
        }
        (style.getSource("clips") as? GeoJsonSource)?.setGeoJson(FeatureCollection.fromFeatures(features))
        when {
            clips.size == 1 -> map.animateCamera(CameraUpdateFactory.newLatLngZoom(LatLng(clips[0].getDouble("lat"), clips[0].getDouble("lon")), 14.0))
            clips.size > 1 -> {
                val b = LatLngBounds.Builder()
                clips.forEach { b.include(LatLng(it.getDouble("lat"), it.getDouble("lon"))) }
                map.animateCamera(CameraUpdateFactory.newLatLngBounds(b.build(), 100))
            }
        }
    }

    Column(modifier.fillMaxSize()) {
        Column(Modifier.padding(horizontal = 16.dp)) {
            ScreenHeader("Map", onBack)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                MapRange.entries.forEach { r -> FilterChip(selected = range == r, onClick = { range = r; selected = null }, label = { Text(r.label) }) }
                Text(
                    when {
                        error != null -> ""
                        shown == null -> "Loading…"
                        else -> "${shown.size} clips"
                    },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            if (shown != null && shown.isEmpty() && all?.isEmpty() == true) {
                Hint("No clips with a location yet. Clips appear here when GPS logging is on and they've been backed up to the server.")
            }
        }
        Box(Modifier.fillMaxWidth().weight(1f).padding(top = 8.dp)) {
            OdcMap(Modifier.fillMaxSize()) { map, style ->
                style.addSource(GeoJsonSource("clips", FeatureCollection.fromFeatures(emptyList<Feature>()),
                    GeoJsonOptions().withCluster(true).withClusterMaxZoom(15).withClusterRadius(45)))
                style.addLayer(
                    CircleLayer("clusters", "clips").withFilter(Expression.has("point_count")).withProperties(
                        PropertyFactory.circleColor("#ff5a36"),
                        PropertyFactory.circleRadius(Expression.step(Expression.get("point_count"), Expression.literal(16f),
                            Expression.stop(10, 21f), Expression.stop(50, 27f))),
                        PropertyFactory.circleStrokeColor("#ffffff"), PropertyFactory.circleStrokeWidth(2f),
                    )
                )
                style.addLayer(
                    SymbolLayer("cluster-count", "clips").withFilter(Expression.has("point_count")).withProperties(
                        PropertyFactory.textField(Expression.toString(Expression.get("point_count"))),
                        PropertyFactory.textSize(13f), PropertyFactory.textColor("#120805"),
                        PropertyFactory.textAllowOverlap(true), PropertyFactory.textIgnorePlacement(true),
                    )
                )
                style.addLayer(
                    CircleLayer("clip", "clips").withFilter(Expression.not(Expression.has("point_count"))).withProperties(
                        PropertyFactory.circleColor("#ff5a36"), PropertyFactory.circleRadius(8f),
                        PropertyFactory.circleStrokeColor("#ffffff"), PropertyFactory.circleStrokeWidth(2f),
                    )
                )
                map.addOnMapClickListener { at ->
                    val pt = map.projection.toScreenLocation(at)
                    val cluster = map.queryRenderedFeatures(pt, "clusters").firstOrNull()
                    if (cluster != null) {
                        val src = style.getSourceAs<GeoJsonSource>("clips")
                        val zoom = src?.getClusterExpansionZoom(cluster)?.toDouble() ?: (map.cameraPosition.zoom + 2)
                        map.animateCamera(CameraUpdateFactory.newLatLngZoom(at, zoom))
                        return@addOnMapClickListener true
                    }
                    val clip = map.queryRenderedFeatures(pt, "clip").firstOrNull()
                    selected = clip?.getStringProperty("id")?.let { byId.value[it] }
                    true
                }
                map.moveCamera(CameraUpdateFactory.newLatLngZoom(LatLng(39.5, -98.35), 3.0))
                mapRef.value = map to style
            }
            selected?.let { c ->
                ClipCard(c, Modifier.align(Alignment.BottomCenter).padding(12.dp), onClose = { selected = null }, onAllCameras = { onOpenSync(c.getLong("startedAt")) }) {
                    if (c.optBoolean("encrypted")) {
                        Toast.makeText(context, "This clip is encrypted. Open it on the phone or with odc_decrypt.", Toast.LENGTH_LONG).show()
                    } else {
                        try {
                            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse(c.getString("streamUrl")), "video/mp4"))
                        } catch (e: Exception) {
                            Toast.makeText(context, "No video player app found.", Toast.LENGTH_LONG).show()
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ClipCard(c: JSONObject, modifier: Modifier, onClose: () -> Unit, onAllCameras: () -> Unit, onPlay: () -> Unit) {
    val thumb by produceState<ImageBitmap?>(null, c.getString("id")) {
        value = if (c.optBoolean("encrypted")) null else RemoteThumbs.load(c.getString("thumbUrl"))
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant), modifier = modifier.fillMaxWidth()) {
        Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.width(128.dp).height(72.dp).clip(RoundedCornerShape(8.dp)).background(Color.Black), contentAlignment = Alignment.Center) {
                thumb?.let { Image(it, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize()) }
                if (c.optBoolean("encrypted")) EncryptedBadge(Modifier.align(Alignment.TopStart).padding(4.dp))
            }
            Column(Modifier.padding(start = 12.dp).weight(1f)) {
                Text(DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(c.getLong("startedAt"))), fontWeight = FontWeight.Bold)
                Text(
                    listOfNotNull(c.optString("camera").ifBlank { null }, c.optString("place").takeIf { it.isNotBlank() && it != "null" }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row {
                    Button(onClick = onPlay) { Text("Play") }
                    if (!c.optBoolean("encrypted")) TextButton(onClick = onAllCameras) { Text("All cameras") }
                    TextButton(onClick = onClose) { Text("Close") }
                }
            }
        }
    }
}
