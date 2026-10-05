package org.opendashcam.ui

import android.content.Context
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import org.opendashcam.settings.OdcSettings

val OdcAccent = Color(0xFFFF5A36)
val OdcRed = Color(0xFFE53935)

val ACCENTS = linkedMapOf(
    "orange" to Color(0xFFFF5A36), "blue" to Color(0xFF3D8BFF), "green" to Color(0xFF2FB36B),
    "purple" to Color(0xFF9B6BFF), "teal" to Color(0xFF14B8A6), "red" to Color(0xFFE5484D),
)

/** Appearance settings as Compose state, so changing them updates the app right away. */
data class Appearance(val themeMode: String, val accent: String, val textScale: Float, val highContrast: Boolean) {
    companion object {
        val state = mutableStateOf(Appearance("dark", "orange", 1f, false))
        fun load(settings: OdcSettings) {
            state.value = Appearance(settings.themeMode, settings.accent, settings.textScale.toFloatOrNull() ?: 1f, settings.highContrast)
        }
    }
}

private fun scheme(context: Context, a: Appearance, dark: Boolean): ColorScheme {
    if (a.accent == "dynamic" && Build.VERSION.SDK_INT >= 31) {
        return if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    }
    val accent = ACCENTS[a.accent] ?: OdcAccent
    val onAccent = if (accent.luminance() > 0.35f) Color.Black else Color.White
    return if (dark) darkColorScheme(
        primary = accent, onPrimary = onAccent, secondary = Color(0xFF8AB4F8),
        background = if (a.highContrast) Color.Black else Color(0xFF0E0F12),
        surface = if (a.highContrast) Color.Black else Color(0xFF0E0F12),
        surfaceVariant = if (a.highContrast) Color(0xFF26282D) else Color(0xFF1C1E23),
        onBackground = if (a.highContrast) Color.White else Color(0xFFECECEC),
        onSurface = if (a.highContrast) Color.White else Color(0xFFECECEC),
        onSurfaceVariant = if (a.highContrast) Color(0xFFE6E6E6) else Color(0xFFB8BBC2),
        outline = if (a.highContrast) Color(0xFFBDBDBD) else Color(0xFF6B6F78),
        error = OdcRed,
    ) else lightColorScheme(
        primary = accent, onPrimary = onAccent, secondary = Color(0xFF1A63D6),
        background = if (a.highContrast) Color.White else Color(0xFFF6F7F9),
        surface = if (a.highContrast) Color.White else Color(0xFFF6F7F9),
        surfaceVariant = if (a.highContrast) Color(0xFFE2E4E8) else Color(0xFFEAECEF),
        onBackground = if (a.highContrast) Color.Black else Color(0xFF15171A),
        onSurface = if (a.highContrast) Color.Black else Color(0xFF15171A),
        onSurfaceVariant = if (a.highContrast) Color(0xFF1F1F1F) else Color(0xFF4A4F57),
        outline = if (a.highContrast) Color(0xFF424242) else Color(0xFF8A8F98),
        error = Color(0xFFC62828),
    )
}

/**
 * The app theme, following Settings → Appearance. [forceDark] keeps the recording screen dark whatever the
 * theme, since it's used in the car, often at night.
 */
@Composable
fun OdcTheme(forceDark: Boolean = false, content: @Composable () -> Unit) {
    val a = Appearance.state.value
    val dark = forceDark || when (a.themeMode) { "light" -> false; "system" -> isSystemInDarkTheme(); else -> true }
    val density = LocalDensity.current
    MaterialTheme(colorScheme = scheme(LocalContext.current, a, dark)) {
        CompositionLocalProvider(LocalDensity provides Density(density.density, density.fontScale * a.textScale), content = content)
    }
}
