package org.opendashcam.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val OdcAccent = Color(0xFFFF5A36)
val OdcRed = Color(0xFFE53935)

private val scheme = darkColorScheme(
    primary = OdcAccent,
    onPrimary = Color.Black,
    secondary = Color(0xFF8AB4F8),
    background = Color(0xFF0E0F12),
    surface = Color(0xFF0E0F12),
    surfaceVariant = Color(0xFF1C1E23),
    onBackground = Color(0xFFECECEC),
    onSurface = Color(0xFFECECEC),
    onSurfaceVariant = Color(0xFFB8BBC2),
    error = OdcRed,
)

/** Always dark: ODC mostly runs in a car, often at night. */
@Composable
fun OdcTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
