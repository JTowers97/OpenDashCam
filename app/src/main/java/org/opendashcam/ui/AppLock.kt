package org.opendashcam.ui

import android.os.Build
import android.os.SystemClock
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.opendashcam.settings.OdcSettings

/**
 * Optional app lock: the phone's fingerprint, face or screen lock is needed to open clips, maps, the parking spot
 * and settings. The recording screen is never locked, so recording can always be started and stopped.
 */
object AppLock {
    val locked = mutableStateOf(false)
    private var backgroundAt = 0L

    /** Fingerprint/face where available, otherwise the screen lock PIN, pattern or password. */
    private val authenticators = if (Build.VERSION.SDK_INT >= 30) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_WEAK or DEVICE_CREDENTIAL

    fun available(activity: FragmentActivity): Boolean =
        BiometricManager.from(activity).canAuthenticate(authenticators) == BiometricManager.BIOMETRIC_SUCCESS

    fun onStart(settings: OdcSettings) {
        if (!settings.appLock) { locked.value = false; return }
        val away = SystemClock.elapsedRealtime() - backgroundAt
        if (backgroundAt == 0L || away >= settings.appLockTimeoutMin * 60_000L) locked.value = true
    }

    fun onStop() {
        backgroundAt = SystemClock.elapsedRealtime()
    }

    fun prompt(activity: FragmentActivity, reason: String = "Unlock Open Dash Cam", onResult: (Boolean) -> Unit) {
        val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                locked.value = false
                onResult(true)
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onResult(false)
        })
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(reason)
                .setSubtitle("Clips, maps and settings are locked")
                .setAllowedAuthenticators(authenticators)
                .build()
        )
    }
}

val PROTECTED_SCREENS = setOf(Screen.SETTINGS, Screen.CLIPS, Screen.PRIVACY_ZONES, Screen.SERVER_CLIPS, Screen.SERVER_MAP, Screen.SERVER_SYNC, Screen.PARKING,
    Screen.CC_HOME, Screen.CC_ALERT, Screen.CC_PLAYER, Screen.CC_SETTINGS)

/** Shown instead of a protected screen while the app is locked. Asks right away; the button asks again. */
@Composable
fun LockedScreen(onBack: () -> Unit) {
    val activity = LocalContext.current as? FragmentActivity
    LaunchedEffect(Unit) { activity?.let { AppLock.prompt(it) { } } }
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("🔒", style = MaterialTheme.typography.displaySmall)
        Text("Open Dash Cam is locked", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text("Use your fingerprint, face or screen lock to see clips, maps and settings. Recording works without unlocking.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Button(onClick = { activity?.let { AppLock.prompt(it) { } } }) { Text("Unlock") }
        TextButton(onClick = onBack) { Text("Back to recording") }
    }
}
