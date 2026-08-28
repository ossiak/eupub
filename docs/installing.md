# Installing Eupub

Eupub is a standalone reader that shows **EPUB, PDF, and plain-text** books in
**euspell** reformed spelling — entirely on your own device. There is no account
and no server: the whole lexicon ships inside the app and every conversion
happens locally. This page is for people installing a released build. To build it
from source instead, see the [README](../README.md).

It runs as a desktop app on **Windows**, **macOS**, and **Linux**, an early
**Android** app, and an **iOS** app for iPhone.

## Which download

The desktop and Android builds live on the **Releases** page. Neither is in a
store: Android is downloaded and installed directly (see [Android](#android)),
and iOS is build-it-yourself (see [iOS](#ios)).

<https://github.com/ossiak/eupub/releases>

Open the latest release and pick the file for your platform:

| Platform | Where | Kind |
| --- | --- | --- |
| **Windows** 10 / 11 (64-bit) | `eupub-Setup-<version>.exe` | Installer |
| **macOS** (Apple Silicon) | `Eupub-<version>-arm64.dmg` | Disk image |
| **Linux** (x86-64) | `Eupub-<version>.AppImage` | Single portable binary |
| **Android** 8.0+ | `eupub-<version>.apk` | Signed app, installed directly (preview) |
| **iOS** 17+ (iPhone) | build it yourself | Xcode build onto your own device |

> The Linux AppImage, the macOS disk image, the Windows installer and the Android
> APK are built and attached automatically for every release — those four are
> what a release contains. **iOS is the exception**: the release workflow has no
> iOS job, so it has to be built from source (see
> [Build it yourself](#build-it-yourself)). It has been submitted to the App
> Store but is not yet approved, so there is nothing to download — it does run on
> a real device once you have built it.

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

Android is an **early preview**, and it is **not on the Google Play Store** — the
APK is downloaded from the Releases page and installed directly. It is properly
release-signed, so it installs and updates like any other app; expect rough edges
in the reader itself rather than in the install.

1. On the phone, open the **Releases** page and download
   `eupub-<version>.apk`.

   <https://github.com/ossiak/eupub/releases>
2. Open it from your browser's downloads list or the **Files** app and tap
   **Install**. The first time, Android asks you to **allow installing unknown
   apps** for whichever app is opening the APK — grant it, then continue.
   *(Settings path: **Apps ▸ Special app access ▸ Install unknown apps**.)*
3. Play Protect may warn about an app from outside the store — choose **Install
   anyway**. This is what Android says about any app not distributed by Google;
   it is not a finding about this one.
4. Open Eupub and pick a book with the **Open** button; it uses the system file
   picker, so books in your Downloads, Drive, or other storage all work.

Requires **Android 8.0 (Oreo) or newer**.

**Updating.** Newer versions install straight over the top — the signing key
never changes, so your library, bookmarks and reading positions survive. To be
told when there is one, use **[Obtainium](https://github.com/ImranR98/Obtainium)**:
tap **Add App** and paste `https://github.com/ossiak/eupub`. It watches the
Releases page and installs updates the way a store client would. Without it,
check the Releases page yourself.

**Confirming an APK is genuinely ours.** Every release is signed with the same
key, whose SHA-256 fingerprint is

```text
1a:36:d0:6e:7e:56:87:e4:6c:cf:cb:59:61:3f:e2:ea:
8b:c1:c6:fa:59:38:7a:2f:69:77:ac:e6:76:16:2e:b4
```

Nobody needs to check this to install the app; it is here so that anyone who
wants to can.

## iOS

**[Eupub is on the App Store](https://apps.apple.com/us/app/eupub/id6801994679)** — free, and it reads both EPUB and PDF.
Building it yourself is still an option, described below, but no longer the only
way onto a phone.

It is an **iPhone** app, portrait only, and needs **iOS 17 or later**. iPad was
dropped deliberately: the reader targets phone width, and an iPad build would
have to support all four orientations to satisfy App Store validation.

1. Stage the assets and generate the project:

   ```sh
   node ios/Eupub/prepare-assets.mjs
   cd ios/Eupub && xcodegen generate
   ```

2. Open `ios/Eupub/Eupub.xcodeproj` in Xcode, set a signing **Team**, and **Run**
   onto a device or the simulator. A free Apple ID works; the resulting build is
   a development one, not something you can pass to anyone else.
3. `ios/Eupub/run.sh` drives the simulator instead, optionally with a device
   name: `./run.sh "iPhone 17 Pro"` — any iPhone from
   `xcrun simctl list devices available`.

**Getting books onto the device.** The app's Documents folder is exposed, so it
appears as **On My iPhone ▸ Eupub** in the Files app and under the device in
Finder. Drop `.epub` and `.pdf` files straight in there, then open them with the
app's **Open** button (Browse ▸ On My iPhone ▸ Eupub). The document picker also
reaches iCloud Drive and other providers.

**PDFs work as they do elsewhere** — the same embedded viewer the desktop and
Android builds use, reforming the text while keeping the page's layout, so a PDF
opened here is converted rather than just displayed.

**The listing reads 0.2.3** where every other platform reads 0.3.3, which is
worth explaining rather than leaving to be noticed. It is the same reader. The
first build went to review on 16 August, before the mobile version strings were
derived from `package.json`, and re-submitting only to change a number would
have restarted the queue for nothing. 0.3.3 was submitted on 27 August and is
in review now; the listing updates itself once Apple clears it.

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
- **Android** — the native project lives under [`android/`](../android/). Stage
  the assets and build with Gradle: `node android/prepare-assets.mjs`, then
  `./gradlew assembleDebug` in `android/`. A build of your own is signed with
  Gradle's throwaway debug key, so it cannot install over a release copy — see
  [android-signing.md](android-signing.md) to build a signed one. The port design
  is documented in [android-port.md](android-port.md).
- **iOS** — the native app is in the repo under [`ios/Eupub/`](../ios/Eupub/). On
  a Mac with full Xcode and XcodeGen (`brew install xcodegen`), build and run it in
  the Simulator with `cd ios/Eupub && ./run.sh` — it stages the web assets,
  generates the project, builds (no signing), installs, and launches. Pass a device
  name to choose one, e.g. `./run.sh "iPhone 17 Pro"` (any iPhone from
  `xcrun simctl list devices available`) — the app is iPhone-only, so an iPad
  simulator is not a valid target. For a physical device, stage and generate the project
  (`node ios/Eupub/prepare-assets.mjs && (cd ios/Eupub && xcodegen generate)`),
  open `ios/Eupub/Eupub.xcodeproj` in Xcode, set a signing **Team**, and **Run**.
  The App Store build is the easy route; build from source to run changes that
  have not shipped yet. It reads EPUB and PDF, the latter through the same embedded viewer
  the desktop and Android builds use, and its Documents folder is exposed so
  books can be dropped in from Files or Finder — see [iOS](#ios).

## If something looks wrong

| Symptom | Try |
| --- | --- |
| Windows: *"Windows protected your PC"* | The installer *is* signed, but SmartScreen reputation accrues per certificate and Eupub's is new, so early downloads still see this. **More info → Run anyway**. Worth checking the UAC prompt names *Kamran Ossia* as publisher — *Unknown publisher* means an unofficial or self-built copy. |
| Linux: AppImage won't start / mount error | Install FUSE 2, or run `./Eupub-*.AppImage --appimage-extract-run`. Confirm it's executable (`chmod +x`). |
| Android: *"App not installed"* or blocked | Allow **Install unknown apps** for the app opening the APK; in Play Protect choose **Install anyway**. Check the phone is Android 8.0+. |
| Android: the new APK won't install over the old one | You are moving between a self-built (debug-signed) copy and a released one, and Android refuses to update across a key change. Uninstall first — note that removes your library and reading positions, which live in the app. |
| iOS: can't find Eupub in the App Store | Search for **Eupub** by *Kamran Ossia*, or open [the listing](https://apps.apple.com/us/app/eupub/id6801994679) directly. It needs **iOS 17 or later** and is iPhone-only, so an older phone or an iPad will not be offered it. |
| iOS: "On My iPhone ▸ Eupub" is missing in Files | It appears once the app has been launched at least once — the folder is created on first run. Check you are in **Browse**, not **Recents**. |
| A book opens in original spelling | Toggle euspell **on** in the reader chrome — it's a per-book setting that re-renders the chapter. |
| A word looks wrong | Reforms are context-sensitive and a handful of ambiguous words are left unchanged deliberately — see the reform notes in the [README](../README.md). |
