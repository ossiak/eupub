# Signing Eupub for Android

Every Android APK must be signed — an unsigned one simply won't install.
`./gradlew assembleDebug` has always worked, because Gradle silently signs debug
builds with a throwaway keystore; `assembleRelease` produced
`app-release-unsigned.apk`, which no phone will accept.

[`android/app/build.gradle.kts`](../android/app/build.gradle.kts) now carries the
`signingConfigs` plumbing (Step 3), so all that's left is to **create a release
key and tell the build where it is**. Until you do, `assembleRelease` still runs
and still emits an unsigned apk — the build never fails for want of a keystore,
which is what keeps a fresh clone and a secret-less CI run working.

Unlike Windows and macOS, there is no certificate authority and nothing to buy:
Android signing keys are **self-signed and self-generated**. What matters is not
who vouches for the key but that you never lose it — Android identifies an app by
`applicationId` *plus* signing key, and a phone refuses to update an installed
app whose new APK is signed with a different key.

> **The keystore is the single irreplaceable artifact in this project.** Lose it
> and every existing install becomes un-updatable: users must uninstall (losing
> their library, bookmarks, and reading positions, which live in the WebView's
> localStorage) before they can install again. Back it up somewhere that is not
> this machine, and not this repo.

## Step 1 — Create the release keystore

`keytool` ships with the JDK you already build with. Put the file **outside the
repository** — a keystore inside a git working tree is one `git add -A` away
from being published.

```powershell
keytool -genkeypair -v `
  -keystore $HOME\keys\eupub-release.jks `
  -storetype PKCS12 `
  -alias eupub `
  -keyalg RSA -keysize 4096 `
  -validity 10000 `
  -dname "CN=Kamran Ossia, O=Euspell, C=GB"
```

It prompts for a password (used for both the store and the key with PKCS12).
Choose a strong one and put it in your password manager along with the alias —
`eupub` — because you will need all three every release for the next 27 years.

- **`-validity 10000`** ≈ 27 years. Google requires a key valid past **22 October
  2033**; anything shorter can't be used to publish updates after it expires.
- **PKCS12**, not the old proprietary JKS format — it's the modern default and
  what `apksigner` and Play both expect.
- Adjust `-dname` to taste; it's cosmetic here (nothing verifies it), but it does
  show up in `apksigner --print-certs` output.

## Step 2 — Keep the credentials out of git

Create `android/keystore.properties` — referenced by the build, never committed:

```properties
storeFile=C:/Users/kamra/keys/eupub-release.jks
storePassword=…
keyAlias=eupub
keyPassword=…
```

Use forward slashes (Gradle handles them on Windows; backslashes are escape
characters in a `.properties` file). `keystore.properties`, `*.jks` and
`*.keystore` are already in [`android/.gitignore`](../android/.gitignore), so
none of this can be committed by accident — but the keystore itself still belongs
outside the working tree, as Step 1 says.

## Step 3 — How the Gradle side works (already wired)

[`android/app/build.gradle.kts`](../android/app/build.gradle.kts) reads that file
at configuration time and attaches a `signingConfig` to the `release` build type
only when it's there:

```kotlin
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystoreProperties.containsKey("storeFile")

android {
    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // …
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}
```

The config is *created* only when the credentials exist, rather than created
empty and conditionally used — an empty `signingConfig` is the kind of thing AGP
rejects later, at a much less obvious moment.

Check which way it resolved without building anything:

```powershell
cd android
.\gradlew.bat :app:signingReport
```

`Variant: release / Config: null` means no keystore was found (you'd get an
unsigned apk); `Config: release` with your store path and alias means Step 2
landed. This is the fastest way to confirm a CI runner picked up its secrets, too.

> Environment variables work as an alternative to the file — swap
> `keystoreProperties.getProperty("storePassword")` for
> `System.getenv("EUPUB_STORE_PASSWORD") ?: keystoreProperties.getProperty(…)`.
> The CI section below writes the properties file instead, which keeps one code
> path for local and remote builds.

## Step 4 — Build a signed APK

The Android assets are generated from the Electron renderer, so build those
first — a stale `app/src/main/assets/` is the usual cause of "it signed fine but
the reader is the old one":

```powershell
npm run build                      # engine, lexicon, PDF viewer (repo root)
node android\prepare-assets.mjs    # -> android/app/src/main/assets/
cd android
.\gradlew.bat assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`. Rename it to
`eupub-<version>.apk` to match what [installing.md](installing.md) tells users to
download.

Gradle applies **v2 + v3** here — v2 by AGP's default for this `minSdk`, v3
because the release `signingConfig` asks for it explicitly. **v1 is off, and that
is correct**: v1 is the old jar signing, needed only below API 24, and `minSdk`
here is 26, so nothing that can install Eupub would ever read it. AGP drops it
for exactly that reason.

> **v3 is requested rather than defaulted, and the comment in
> [`build.gradle.kts`](../android/app/build.gradle.kts) says why.** AGP left it
> off; v3 carries the signing lineage that key rotation depends on, and it cannot
> be added to an APK after the fact, so an install signed without it could never
> be rotated to a new key. It was turned on (16 August 2026) while nothing was
> published and the answer was still free. Rotation is honoured only on Android
> 9+ even so — this buys an option, not a guarantee.

## Step 5 — Verify

`apksigner` lives in the SDK build-tools, not on `PATH` by default:

```powershell
& "$env:ANDROID_HOME\build-tools\34.0.0\apksigner.bat" verify --print-certs --verbose `
    app\build\outputs\apk\release\app-release.apk
```

What a correct build actually prints — the `false` on v1 is expected, for the
reasons above:

```text
Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): true
Signer #1 certificate DN: CN=Kamran Ossia, O=Euspell, C=GB
Signer #1 certificate SHA-256 digest: 1a36d06e…
```

**The line that matters is the first one.** `Verifies` on its own is the verdict;
the scheme list says which mechanisms were used, not whether the signature is
good. Do not "fix" a `false` by forcing v1 back on — it adds a second signature
that no supported device will ever read.

**The key's SHA-256 fingerprint, recorded 16 August 2026:**

```text
1a:36:d0:6e:7e:56:87:e4:6c:cf:cb:59:61:3f:e2:ea:
8b:c1:c6:fa:59:38:7a:2f:69:77:ac:e6:76:16:2e:b4
```

Publish it beside the download so anyone can confirm an APK came from you, and
check it before every release — a build that quietly fell back to the debug key
prints a different fingerprint and nothing else complains.

Then install onto a real device over the top of the previous release
(`adb install -r eupub-<version>.apk`). Success proves key continuity; an
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` means you've signed with a different key
than last time — stop and find the original keystore.

## Sideloading, and Google's developer verification

Eupub's Android build is distributed as a **sideloaded APK** from the Releases
page (see [installing.md](installing.md)), not through Play. Signing it correctly
is necessary but no longer sufficient for very long:

Google is phasing in **developer verification for apps installed outside Play**.
Registration through the Android Developer Console opened to all developers in
March 2026; the requirement starts biting in **September 2026** for users in
Brazil, Indonesia, Singapore and Thailand, and globally from 2027. After that, a
certified Android device will refuse to install an APK from an unverified
developer. There is a lighter-weight path for hobbyist and student developers,
but it still means registering an identity and associating it with this app's
signing key. If Eupub is still shipping as a sideloaded APK then, budget for
that — it's paperwork, not code.

## If you publish to Google Play later

> The full route — target API level, the app bundle, the console account, the
> closed-testing schedule and the store listing — is in
> [android-play-submission.md](android-play-submission.md). What follows is the
> signing half of it.

Play doesn't take APKs from new apps — it takes an **Android App Bundle**, and it
re-signs your upload with a key it holds:

```powershell
.\gradlew.bat bundleRelease   # -> app/build/outputs/bundle/release/app-release.aab
```

- **Play App Signing** splits the key in two. The keystore from Step 1 becomes
  your **upload key** (it authenticates you to Play); Google holds the **app
  signing key** that end users' devices actually verify. Practical upshot: an
  upload key can be **reset** if you lose it, which is a real safety net — but
  the APKs you have already sideloaded were signed with your key, so a Play
  release will be signed with a *different* key and cannot update an existing
  sideloaded install. Users would have to uninstall first. Plan the switch as a
  clean cutover and say so in the release notes.
- **Target API level.** Play requires new apps and updates to target **Android 16
  (API 36)** from 31 August 2026, and existing apps to target at least API 35 to
  stay available on newer devices. `android/app/build.gradle.kts` currently sets
  `compileSdk = 34` / `targetSdk = 34`, so a Play submission needs that raised
  first (and the behaviour changes for 35 and 36 checked — mainly edge-to-edge
  display and the WebView/storage rules, both of which touch this app).
- **`versionCode` must increase with every upload**, and Play never accepts a
  repeat. Both numbers now come from [`package.json`](../package.json), which
  `build.gradle.kts` reads at configuration time — `versionName` is the string
  verbatim, `versionCode` is `major*10000 + minor*100 + patch` (`0.3.0` → `300`),
  monotonic across any bump and readable backwards. So `npm version <x.y.z>`
  moves the APK along with the three desktop builds, and there is nothing to
  remember. Two consequences worth knowing:
  - Sideloaded builds carry `versionCode 1` (the old hardcoded value). The jump
    to 200-something is an upgrade, so it installs cleanly over them — but only
    while the signing key is the same one, which the Play App Signing cutover
    above changes anyway.
  - Re-uploading a **fixed build of the same version** needs a new code. Bump the
    patch (`npm version patch`) rather than hand-editing the gradle file; the
    derivation is deliberately the only path.

## Signing in CI

The Android build needs no Windows or macOS runner — add an `apk` job on
`ubuntu-latest` alongside the existing `appimage` and `dmg` jobs (the steps below
assume that, hence `bash`). The keystore is binary, so pass it base64-encoded in
a repository secret and reconstitute it on the runner:

```powershell
# locally, once:
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\keys\eupub-release.jks")) | Set-Clipboard
```

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the base64 blob above |
| `ANDROID_KEYSTORE_PASSWORD` | the store password |
| `ANDROID_KEY_ALIAS` | `eupub` |
| `ANDROID_KEY_PASSWORD` | the key password |

```yaml
      - name: Restore keystore
        if: env.ANDROID_KEYSTORE_BASE64 != ''
        env:
          ANDROID_KEYSTORE_BASE64: ${{ secrets.ANDROID_KEYSTORE_BASE64 }}
        run: |
          echo "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$RUNNER_TEMP/eupub.jks"
          cat > android/keystore.properties <<EOF
          storeFile=$RUNNER_TEMP/eupub.jks
          storePassword=${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          keyAlias=${{ secrets.ANDROID_KEY_ALIAS }}
          keyPassword=${{ secrets.ANDROID_KEY_PASSWORD }}
          EOF
      - name: Build APK
        run: |
          npm run build
          node android/prepare-assets.mjs
          cd android && ./gradlew assembleRelease
```

As with the macOS job in
[`release.yml`](../.github/workflows/release.yml), keep it degrading gracefully:
without the secrets the job still builds (unsigned), so forks and dry runs don't
fail. Note this needs a *third* checkout pattern in that workflow — the Android
build imports from the sibling `euspell_ext` checkout exactly as the desktop
builds do.

## Notes

- **Debug builds are signed too**, with `~/.android/debug.keystore` — a shared,
  publicly-known key that Gradle regenerates on demand. Fine for `adb install`
  during development; never ship it, and never let it become the key an installed
  base depends on.
- **Key rotation exists but is limited.** APK Signature Scheme v3 supports
  rotating to a new key with a signing lineage (`apksigner rotate`, then
  `apksigner sign --lineage`), but only Android 9+ honours it — older devices
  still require the original key. Treat rotation as damage control, not a plan.
- **`storetype PKCS12` vs JKS.** An older `.jks` file in the proprietary format
  still works; `keytool -importkeystore -srckeystore x.jks -destkeystore x.p12
  -deststoretype pkcs12` converts it if you want the warning to stop.
- **iOS is a different world.** The `ios/` project is signed with an Apple
  Developer certificate and provisioning profiles — see
  [macos-signing.md](macos-signing.md) for the Apple account setup that shares its
  first steps.

## Sources

- [Android Developers — Sign your app](https://developer.android.com/studio/publish/app-signing)
- [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- [Understanding Android developer verification](https://support.google.com/android-developer-console/answer/16561738)
