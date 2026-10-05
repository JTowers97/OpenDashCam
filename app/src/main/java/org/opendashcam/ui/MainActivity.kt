package org.opendashcam.ui

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import org.opendashcam.autostart.AutoStart
import org.opendashcam.autostart.StandbyService
import org.opendashcam.backup.BackupScheduler
import org.opendashcam.recording.RecordingService
import org.opendashcam.settings.OdcSettings
import org.opendashcam.tracking.TrackingService

enum class Screen { ONBOARDING, HOME, SETTINGS, CLIPS, PRIVACY_ZONES, SERVER_CLIPS, SERVER_MAP, SERVER_SYNC, PARKING }

class MainActivity : FragmentActivity() {
    private lateinit var settings: OdcSettings

    /** Incremented each time an auto-start (charging / Bluetooth) opens this screen. */
    private var autoStartRequests by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        settings = OdcSettings(this)
        Appearance.load(settings)
        handleIntent(intent, fresh = savedInstanceState == null)
        setContent {
            OdcTheme { OdcRoot(settings, autoStartRequests) }
        }
    }

    override fun onStart() {
        super.onStart()
        AppLock.onStart(settings)
    }

    override fun onStop() {
        super.onStop()
        AppLock.onStop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent, fresh = true)
    }

    override fun onResume() {
        super.onResume()
        if (settings.onboardingDone && settings.smbEnabled) BackupScheduler.kick(this)
        // Tracking-only mode: make sure it's running (e.g. after the app was updated or Android stopped it).
        if (settings.onboardingDone && TrackingService.canRun(this, settings) && !TrackingService.state.value.active) TrackingService.start(this)
        // Re-arm charging auto-start whenever ODC is opened (Android allows it while on screen).
        if (settings.onboardingDone && settings.autoStartCharging && !RecordingService.state.value.active) {
            StandbyService.start(this)
        }
    }

    private fun handleIntent(intent: Intent?, fresh: Boolean) {
        if (fresh && intent?.getStringExtra(AutoStart.EXTRA_AUTO_START) != null && settings.onboardingDone) {
            intent.removeExtra(AutoStart.EXTRA_AUTO_START)
            autoStartRequests++
        }
    }
}

@Composable
fun OdcRoot(settings: OdcSettings, autoStartRequests: Int) {
    var screen by rememberSaveable {
        mutableStateOf(if (settings.onboardingDone) Screen.HOME else Screen.ONBOARDING)
    }
    var serverClipsBack by rememberSaveable { mutableStateOf(Screen.CLIPS) }
    var syncBack by rememberSaveable { mutableStateOf(Screen.SERVER_CLIPS) }
    var syncFrom by rememberSaveable { mutableStateOf(0L) }
    // Only the recording screen is forced to landscape; clips, settings and setup follow the phone.
    val activity = LocalContext.current as? Activity
    LaunchedEffect(screen) {
        activity?.requestedOrientation = if (screen == Screen.HOME) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }
    LaunchedEffect(autoStartRequests) {
        if (autoStartRequests > 0 && screen != Screen.ONBOARDING) screen = Screen.HOME
    }
    BackHandler(enabled = screen != Screen.HOME && screen != Screen.ONBOARDING) {
        screen = when (screen) {
            Screen.PRIVACY_ZONES -> Screen.SETTINGS
            Screen.SERVER_CLIPS -> serverClipsBack
            Screen.SERVER_MAP -> Screen.CLIPS
            Screen.SERVER_SYNC -> syncBack
            Screen.PARKING -> Screen.HOME
            else -> Screen.HOME
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        if (screen in PROTECTED_SCREENS && settings.appLock && AppLock.locked.value) {
            LockedScreen(onBack = { screen = Screen.HOME })
            return@Surface
        }
        when (screen) {
            Screen.ONBOARDING -> OnboardingScreen(settings) { customize ->
                screen = if (customize) Screen.SETTINGS else Screen.HOME
            }
            // The recording screen stays dark whatever the theme: it's used in the car, often at night.
            Screen.HOME -> OdcTheme(forceDark = true) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    HomeScreen(
                        settings,
                        autoStartRequests = autoStartRequests,
                        onOpenSettings = { screen = Screen.SETTINGS },
                        onOpenClips = { screen = Screen.CLIPS },
                        onOpenParking = { screen = Screen.PARKING },
                    )
                }
            }
            Screen.PARKING -> ParkingScreen(settings, onBack = { screen = Screen.HOME }, modifier = Modifier.safeDrawingPadding())
            Screen.SETTINGS -> SettingsScreen(
                settings,
                onBack = { screen = Screen.HOME },
                onRerunSetup = {
                    settings.onboardingDone = false
                    screen = Screen.ONBOARDING
                },
                onOpenPrivacyZones = { screen = Screen.PRIVACY_ZONES },
                onOpenServerClips = { serverClipsBack = Screen.SETTINGS; screen = Screen.SERVER_CLIPS },
                modifier = Modifier.safeDrawingPadding(),
            )
            Screen.CLIPS -> ClipsScreen(
                settings,
                onBack = { screen = Screen.HOME },
                onOpenServerClips = { serverClipsBack = Screen.CLIPS; screen = Screen.SERVER_CLIPS },
                onOpenMap = { screen = Screen.SERVER_MAP },
                modifier = Modifier.safeDrawingPadding(),
            )
            Screen.SERVER_MAP -> ServerMapScreen(
                settings, onBack = { screen = Screen.CLIPS },
                onOpenSync = { t -> syncFrom = t - 60_000; syncBack = Screen.SERVER_MAP; screen = Screen.SERVER_SYNC },
                modifier = Modifier.safeDrawingPadding(),
            )
            Screen.SERVER_SYNC -> ServerSyncScreen(settings, syncFrom, onBack = { screen = syncBack }, modifier = Modifier.safeDrawingPadding())
            Screen.SERVER_CLIPS -> ServerClipsScreen(
                settings, onBack = { screen = serverClipsBack },
                onOpenSync = { t -> syncFrom = t - 60_000; syncBack = Screen.SERVER_CLIPS; screen = Screen.SERVER_SYNC },
                modifier = Modifier.safeDrawingPadding(),
            )
            Screen.PRIVACY_ZONES -> PrivacyZonesScreen(
                settings, onBack = { screen = Screen.SETTINGS }, modifier = Modifier.safeDrawingPadding(),
            )
        }
    }
}
