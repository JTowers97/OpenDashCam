package org.opendashcam.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import org.maplibre.android.MapLibre
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.geojson.Point
import org.maplibre.geojson.Polygon
import kotlin.math.cos
import kotlin.math.sin

/** OpenStreetMap data styled by OpenFreeMap: free, no API key. */
const val MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty"

/**
 * A MapLibre map inside Compose. [onReady] runs once the style has loaded; use it to add sources,
 * layers and click listeners. The map follows the screen's lifecycle.
 */
@Composable
fun OdcMap(modifier: Modifier = Modifier, onReady: (MapLibreMap, Style) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ready by rememberUpdatedState(onReady)
    val mapView = remember {
        MapLibre.getInstance(context)
        MapView(context).apply {
            onCreate(null)
            getMapAsync { map ->
                map.uiSettings.isRotateGesturesEnabled = false
                map.setStyle(Style.Builder().fromUri(MAP_STYLE_URL)) { style -> ready(map, style) }
            }
        }
    }
    DisposableEffect(lifecycle, mapView) {
        var started = false
        var resumed = false
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> if (!started) { mapView.onStart(); started = true }
                Lifecycle.Event.ON_RESUME -> if (!resumed) { mapView.onResume(); resumed = true }
                Lifecycle.Event.ON_PAUSE -> if (resumed) { mapView.onPause(); resumed = false }
                Lifecycle.Event.ON_STOP -> if (started) { mapView.onStop(); started = false }
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            if (resumed) mapView.onPause()
            if (started) mapView.onStop()
            mapView.onDestroy()
        }
    }
    AndroidView(factory = { mapView }, modifier = modifier)
}

/** A circle as a 64-sided polygon, for drawing privacy zones. */
fun circlePolygon(center: LatLng, radiusM: Double): Polygon {
    val pts = (0..64).map { i ->
        val a = 2 * Math.PI * i / 64
        val dLat = radiusM / 111_320.0 * cos(a)
        val dLon = radiusM / (111_320.0 * cos(Math.toRadians(center.latitude))) * sin(a)
        Point.fromLngLat(center.longitude + dLon, center.latitude + dLat)
    }
    return Polygon.fromLngLats(listOf(pts))
}
