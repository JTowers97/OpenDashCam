package org.opendashcam.feedback

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.opendashcam.settings.OdcSettings
import java.util.Locale

/**
 * Optional spoken feedback: short announcements so you know what ODC is doing without looking at the phone.
 * Spoken like navigation directions: through the car's speakers when connected, briefly lowering music.
 */
object Announcer {
    private var tts: TextToSpeech? = null
    private var ready = false
    private val pending = mutableListOf<String>()
    private var lastText = ""
    private var lastAt = 0L

    private val attributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    fun say(context: Context, text: String) {
        if (!OdcSettings(context).spokenFeedback) return
        // Don't repeat the same announcement within a few seconds (e.g. quick restarts).
        val now = System.currentTimeMillis()
        if (text == lastText && now - lastAt < 8_000) return
        lastText = text
        lastAt = now
        val app = context.applicationContext
        val engine = tts
        if (engine == null) {
            pending += text
            tts = TextToSpeech(app) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (ready) {
                    tts?.language = Locale.getDefault()
                    tts?.setAudioAttributes(attributes)
                    tts?.setOnUtteranceProgressListener(focus(app))
                    pending.forEach { speak(it) }
                }
                pending.clear()
            }
        } else if (ready) {
            speak(text)
        }
    }

    private fun speak(text: String) {
        tts?.speak(text, TextToSpeech.QUEUE_ADD, null, "odc-${System.nanoTime()}")
    }

    /** Lowers other audio (music) while speaking, like navigation apps do. */
    private fun focus(context: Context): UtteranceProgressListener {
        val am = context.getSystemService(AudioManager::class.java)
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(attributes).build()
        return object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) { am.requestAudioFocus(request) }
            override fun onDone(utteranceId: String?) { am.abandonAudioFocusRequest(request) }
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) { am.abandonAudioFocusRequest(request) }
        }
    }
}
