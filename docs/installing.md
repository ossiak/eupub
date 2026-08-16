# Installing Eupub

Eupub is a standalone reader that shows **EPUB, PDF, and plain-text** books in
**euspell** reformed spelling — entirely on your own device. There is no account
and no server: the whole lexicon ships inside the app and every conversion
happens locally. This page is for people installing a released build. To build it
from source instead, see the [README](../README.md).

It runs as a desktop app on **Windows**, **macOS**, and **Linux**, an early
**Android** app, and an **iOS** app for iPhone and iPad.

## Which download

The desktop and Android builds live on the **Releases** page; **iOS is on the App
Store** (see [iOS](#ios) below).

<https://github.com/ossiak/eupub/releases>

Open the latest release and pick the file for your platform:

| Platform | Where | Kind |
| --- | --- | --- |
| **Windows** 10 / 11 (64-bit) | `eupub-Setup-<version>.exe` | Installer |
| **macOS** (Apple Silicon) | `Eupub-<version>-arm64.dmg` | Disk image |
| **Linux** (x86-64) | `Eupub-<version>.AppImage` | Single portable binary |
| **Android** 8.0+ | build it yourself | Sideloaded app (preview) |
| **iOS** 17+ (iPhone & iPad) | not available yet | — |

> The Linux AppImage, the macOS disk image and the Windows installer are built
> and attached automatically for every release — those three are what a release
> contains. **No APK is published**: the release workflow has no Android job, so
> the preview has to be built from source (see
> [Build it yourself](#build-it-yourself)). iOS has not been submitted anywhere.

## Windows

1. Download `eupub-Setup-<version>.exe` and run it.
2. The installer is **Authenticode-signed**, so the User Account Control prompt
   names the publisher — *Kamran Ossia* — instead of *Unknown publisher*.

   **SmartScreen may still warn you for a while.** Its reputation builds per
   signing certificate as installs accumulate, and Eupub's certificate is new, so
   early downloads can still meet *"Windows protected your PC."* Click **More
   info → Run anyway**. That fades on its own as the certificate ages; there is
   nothing to do at your end, and nothing is wrong with the download.
3. The installer lets you **choose the install folder** (default
   `%LOCALAPPDATA%\Programs\Eupub`), then creates **Start-menu and desktop
   shortcuts**.
4. Launch Eupub from the shortcut. Because `.epub` files are associated with it,
   you can also **double-click an EPUB** to open it in Eupub.

**Uninstall** from **Settings ▸ Apps ▸ Installed apps ▸ Eupub ▸ Uninstall**, or
the *Eupub* entry in the Start menu.

## macOS

Eupub for macOS is a **`.dmg` for Apple Silicon** (M1 or later); Intel Macs
aren't supported by this build.

1. Download `Eupub-<version>-arm64.dmg` and open it. A window opens showing the
   **Eupub** app beside an **Applications** shortcut.
2. **Drag Eupub onto the Applications folder**, then eject the disk image.
3. Launch Eupub with a normal double-click. The app is signed with a Developer ID
   certificate and notarized by Apple — and the disk image itself is notarized too
   — so Gatekeeper opens it with no prompt, even on first launch and offline.

## Linux

The AppImage is one self-contained file — no system install, no root.

1. Download `Eupub-<version>.AppImage`.
2. Make it executable, then run it:

   ```sh
   chmod +x Eupub-*.AppImage
   ./Eupub-*.AppImage
   ```

   Or, in most file managers: **Properties ▸ Permissions ▸ Allow executing as
   program**, then double-click.
3. **Missing FUSE?** Some distributions no longer ship FUSE 2, which AppImages
   need. Either install it (`sudo apt install libfuse2` on Debian/Ubuntu, or the
   equivalent) or run the file extracted: `./Eupub-*.AppImage --appimage-extract-run`.

**Desktop integration (optional).** To get a menu entry and EPUB/PDF file
associations, use a helper like **AppImageLauncher**, or accept the integration
prompt your desktop offers on first run. Eupub is verified on **KDE Plasma**; it
also runs on GNOME and other desktops.

**Update or remove** by replacing or deleting the single AppImage file.

## Android

Android is an **early preview**: it is not on the Google Play Store, and it is
not release-signed. Expect rough edges, and update it by installing a newer APK
by hand.

> **No APK is published.** The release workflow builds only the Linux, macOS and
> Windows assets, so no GitHub Release carries an `.apk` — you have to build one.
> With the Android SDK and JDK 17 installed, `./gradlew assembleDebug` in
> `android/` produces `android/app/build/outputs/apk/debug/app-debug.apk`; see
> [android-port.md](android-port.md). The steps below describe installing an APK
> you have built and transferred to the phone.

1. Get the APK onto the phone (transfer it from the computer that built it).
2. Open it with the **Files** app or your browser's downloads list and tap
   **Install**. The first time, Android asks you to **allow installing unknown
   apps** for whichever app is opening the APK — grant it, then continue.
   *(Settings path: **Apps ▸ Special app access ▸ Install unknown apps**.)*
3. Play Protect may warn about an app from outside the store — choose **Install
   anyway**.
4. Open Eupub and pick a book with the **Open** button; it uses the system file
   picker, so books in your Downloads, Drive, or other storage all work.

Requires **Android 8.0 (Oreo) or newer**.

## iOS

**Eupub is not available for iPhone or iPad yet.** The iOS port is in progress:
it has not been submitted to the App Store, so there is nothing to search for and
no way to install it without a developer setup of your own.

If you have one: open `ios/Eupub/Eupub.xcodeproj` in Xcode, set a signing
**Team**, and **Run** onto a device or simulator. That is a development build,
not a distributable one.

This section will describe the App Store route once there is one. It is written
this way deliberately — an install page that promises a store listing which does
not exist wastes the reader's time and teaches them to distrust the rest of the
page.

## First run — reading in euspell

- **Open a book** with the app's **Open** button, or (desktop) by double-clicking
  an `.epub`/`.pdf`. Your last book and reading position reopen on launch.
- **Turn euspell on or off** with the toggle in the reader chrome — it re-renders
  the current chapter in place, keeping your spot. Off shows the book's original
  spelling; on shows it reformed.
- Page with **← / →**, space, the scroll wheel (desktop), or **swipe / tap the
  side thirds** (Android/iOS). Font size and light/dark controls sit in the same
  chrome, and **bookmarks, highlights, and book-wide search** are in the side
  tabs.

Everything is local — no book, position, or highlight ever leaves the device.

## Build it yourself

If there's no prebuilt file for your platform, or you want to run from source:

- **Windows / Linux desktop** — `npm run dist` (Windows NSIS installer) or
  `npm run dist:linux` (Linux AppImage). A build of your own is **unsigned**, so
  unlike the released installer it shows *Unknown publisher* and a firmer
  SmartScreen warning; [windows-signing.md](windows-signing.md) covers signing
  one. See **Build a standalone installer** in the [README](../README.md).
- **macOS** — `npm run dist:mac` on a Mac (Apple Silicon) →
  `release/Eupub-<version>-arm64.dmg`. dmg building is macOS-only. To ship it
  **signed and notarized** so it opens with no Gatekeeper prompt, follow
  [macos-signing.md](macos-signing.md).
- **Android** — the native project lives under [`android/`](../android/); build
  the APK with Gradle (`./gradlew assembleDebug`). Its port design is documented
  in [android-port.md](android-port.md).
- **iOS** — the native app is in the repo under [`ios/Eupub/`](../ios/Eupub/). On
  a Mac with full Xcode and XcodeGen (`brew install xcodegen`), build and run it in
  the Simulator with `cd ios/Eupub && ./run.sh` — it stages the web assets,
  generates the project, builds (no signing), installs, and launches. Pass a device
  name to choose one, e.g. `./run.sh "iPad Pro 13-inch (M5)"` (any from
  `xcrun simctl list devices available`), iPad included, since it's a universal
  iPhone/iPad app. For a physical device, stage and generate the project
  (`node ios/Eupub/prepare-assets.mjs && (cd ios/Eupub && xcodegen generate)`),
  open `ios/Eupub/Eupub.xcodeproj` in Xcode, set a signing **Team**, and **Run**.
  This is the only way to run Eupub on iOS today; no App Store build has been
  submitted.

## If something looks wrong

| Symptom | Try |
| --- | --- |
| Windows: *"Windows protected your PC"* | The installer *is* signed, but SmartScreen reputation accrues per certificate and Eupub's is new, so early downloads still see this. **More info → Run anyway**. Worth checking the UAC prompt names *Kamran Ossia* as publisher — *Unknown publisher* means an unofficial or self-built copy. |
| Linux: AppImage won't start / mount error | Install FUSE 2, or run `./Eupub-*.AppImage --appimage-extract-run`. Confirm it's executable (`chmod +x`). |
| Android: *"App not installed"* or blocked | Allow **Install unknown apps** for the app opening the APK; in Play Protect choose **Install anyway**. Check the phone is Android 8.0+. |
| Android: no APK in the release | There isn't one — releases carry the Linux, macOS and Windows assets only. Build the preview yourself (see [Build it yourself](#build-it-yourself)). |
| iOS: can't find Eupub in the App Store | It is not there. The iOS port is in progress and has not been submitted, so no search or region will find it. |
| A book opens in original spelling | Toggle euspell **on** in the reader chrome — it's a per-book setting that re-renders the chapter. |
| A word looks wrong | Reforms are context-sensitive and a handful of ambiguous words are left unchanged deliberately — see the reform notes in the [README](../README.md). |
