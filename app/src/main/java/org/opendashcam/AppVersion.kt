package org.opendashcam

/** e.g. "0.4.0 (build 42 · a1b2c3d)". Shown on the Home screen, in Settings and sent to the server. */
object AppVersion {
    val name: String get() = BuildConfig.VERSION_NAME
    val full: String get() = "${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_LABEL})"
}
