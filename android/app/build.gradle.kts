import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing credentials, read from android/keystore.properties (git-ignored;
// see docs/android-signing.md for its four keys and how CI writes it). Absent on a
// fresh clone and in CI without secrets — in that case `assembleRelease` still runs
// and emits an UNSIGNED apk rather than failing the build.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProperties.containsKey("storeFile")

// The version comes from Eupub's package.json, the same single source the three
// desktop builds use (release.yml fails a tagged build when the tag disagrees
// with it). Nothing tied the APK to it before, so versionName sat at 0.1.0 while
// the desktop shipped 0.2.3, and the gap widened with every release.
val pkgVersion = run {
    val f = rootProject.file("../package.json")
    @Suppress("UNCHECKED_CAST")
    val pkg = groovy.json.JsonSlurper().parse(f) as Map<String, Any?>
    pkg["version"] as? String ?: error("no \"version\" field in ${f.path}")
}

// Play requires versionCode to increase with every upload and never accepts a
// repeat, so it is derived from the name rather than stored: major*10000 +
// minor*100 + patch is monotonic across any bump and still readable backwards
// (0.3.0 -> 300). A non-numeric version is a hard error — silently shipping an
// APK whose code did not advance costs a whole upload slot.
val pkgVersionCode = Regex("""^(\d+)\.(\d+)\.(\d+)""").find(pkgVersion)
    ?.destructured
    ?.let { (major, minor, patch) ->
        major.toInt() * 10000 + minor.toInt() * 100 + patch.toInt()
    }
    ?: error("package.json version '$pkgVersion' is not major.minor.patch")

android {
    namespace = "org.euspell.eupub"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.euspell.eupub"
        minSdk = 26
        targetSdk = 34
        versionCode = pkgVersionCode
        versionName = pkgVersion
    }

    signingConfigs {
        // Declared only when the credentials exist, so an unconfigured clone never
        // carries a half-populated config that AGP would reject at use time.
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
                // AGP's defaults for minSdk 26 sign with v2 alone: v1 is dropped
                // because nothing above API 24 reads it, which is right, and v3
                // is off, which is not. v3 carries the signing lineage that key
                // rotation needs, and it cannot be added to an apk after the
                // fact — an install signed without it can never be rotated to a
                // new key. Asked for explicitly while nothing is published yet
                // and the answer is still free. Rotation only works on Android
                // 9+ even then, so this buys an option, not a guarantee.
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
