plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.opendashcam"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.opendashcam"
        minSdk = 29
        targetSdk = 35
        // CI stamps every build: versionCode always increases (so updates install over older builds),
        // and the build number and commit appear in the app, e.g. "0.4.0 (build 42 · a1b2c3d)".
        val ciBuild = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()
        val commit = System.getenv("GITHUB_SHA")?.take(7) ?: "local"
        versionCode = 1000 + (ciBuild ?: 0)
        versionName = "0.4.1"
        buildConfigField("String", "BUILD_LABEL", "\"${ciBuild?.let { "build $it" } ?: "local build"} · $commit\"")
    }

    signingConfigs {
        // Shared debug key so every CI build installs over the previous one
        // (a signature change would force an uninstall, which deletes footage).
        // NOT for Play Store releases.
        getByName("debug") {
            storeFile = file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            // smbj pulls in BouncyCastle and other jars that ship duplicate metadata files.
            excludes += setOf(
                "META-INF/versions/9/OSGI-INF/MANIFEST.MF",
                "META-INF/DEPENDENCIES",
                "META-INF/LICENSE*",
                "META-INF/NOTICE*",
                "META-INF/INDEX.LIST",
            )
        }
    }
}

base {
    // APK file name includes the version: OpenDashCam-0.4.0-debug.apk
    archivesName.set("OpenDashCam-0.4.1")
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // QR scanning for server pairing (ZXing, Apache 2.0, no Google Play Services)
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    // Background uploads
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    // SMB 2/3 client (Apache 2.0)
    implementation("com.hierynomus:smbj:0.14.0")

    // CameraX is used only for the framing preview while idle.
    // Recording uses Camera2 + MediaRecorder directly.
    val cameraX = "1.4.1"
    implementation("androidx.camera:camera-camera2:$cameraX")
    implementation("androidx.camera:camera-lifecycle:$cameraX")
    implementation("androidx.camera:camera-view:$cameraX")
}
