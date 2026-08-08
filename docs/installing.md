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
| **Android** 8.0+ | `eupub-<version>.apk` | Sideloaded app (preview) |
| **iOS** 17+ (iPhone & iPad) | App Store | Store app |

> The Linux AppImage is built and attached automatically for every release. The
> Windows installer, the macOS disk image, and the Android APK are added to the
> same release by the maintainer — if one is missing from a given release, build
> it from source (see [Build it yourself](#build-it-yourself)).

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

Android is an **early preview**: it's distributed as a sideloaded APK, not through
the Google Play Store, and isn't release-signed yet. Expect rough edges, and
update it by installing a newer APK by hand.

1. On the phone, download `eupub-<version>.apk` (or transfer it from a computer).
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

Eupub for iPhone and iPad is on the **App Store** — Apple-reviewed and signed, so
it installs like any other app, with no security prompts to override.

1. Open the **App Store** on your iPhone or iPad and search **Eupub**, or open the
   listing directly:
   <https://apps.apple.com/app/eupub/id000000000> *(replace with the real App
   Store link once published)*.
2. Tap **Get** and install as usual.
3. Open Eupub and add a book with the **Open** button — it uses the iOS document
   picker, so books in Files, iCloud Drive, and other providers all work.

Requires **iOS 17 or later**, on iPhone or iPad. Updates arrive through the App
Store automatically.

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
  The App Store build is produced and submitted separately.

## If something looks wrong

| Symptom | Try |
| --- | --- |
| Windows: *"Windows protected your PC"* | The installer *is* signed, but SmartScreen reputation accrues per certificate and Eupub's is new, so early downloads still see this. **More info → Run anyway**. Worth checking the UAC prompt names *Kamran Ossia* as publisher — *Unknown publisher* means an unofficial or self-built copy. |
| Linux: AppImage won't start / mount error | Install FUSE 2, or run `./Eupub-*.AppImage --appimage-extract-run`. Confirm it's executable (`chmod +x`). |
| Android: *"App not installed"* or blocked | Allow **Install unknown apps** for the app opening the APK; in Play Protect choose **Install anyway**. Check the phone is Android 8.0+. |
| iOS: can't find Eupub in the App Store | It needs **iOS 17 or later** — older iPhones/iPads won't see the listing. Check for an OS update (and your store region). |
| A book opens in original spelling | Toggle euspell **on** in the reader chrome — it's a per-book setting that re-renders the chapter. |
| A word looks wrong | Reforms are context-sensitive and a handful of ambiguous words are left unchanged deliberately — see the reform notes in the [README](../README.md). |
