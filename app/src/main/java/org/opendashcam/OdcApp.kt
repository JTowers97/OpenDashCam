package org.opendashcam

import android.app.Application
import org.opendashcam.recording.Notifier
import org.opendashcam.settings.OdcSettings
import org.opendashcam.storage.ClipCrypto
import org.opendashcam.storage.ClipStorage

class OdcApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        org.opendashcam.command.AlertNotifier.createChannels(this)
        org.maplibre.android.MapLibre.getInstance(this)
        // Decrypted playback copies never outlive the app session.
        ClipCrypto.clearPlaybackCache(this)
        // A fresh process means no encryption job is running; remove any half-written output.
        try { ClipStorage(this, OdcSettings(this)).cleanupTemp() } catch (_: Exception) {}
    }
}
