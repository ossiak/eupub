# iOS App Review — the information Apple asks for

The first submission of Eupub for iOS (version 0.2.3, build 203, submitted
16 August 2026) was rejected the next day under **Guideline 2.1 — Information
Needed**. Nothing in the app was found to be broken: 2.1 in this form is the
standard response when the **App Review Information ▸ Notes** field is empty on
a *new* app, and the reviewer is asking to be told what the app is and how to
exercise it before spending time on it.

So this is answered with text and a video, not with code. **No new build is
required** — reply on the existing submission. Uploading a new build would
restart the queue and change the version under review from 0.2.3 to 0.3.0,
buying nothing.

> **One thing not to worry about.** The reviewer will see a real book the moment
> the app opens: `Bridge.swift` seeds the bundled `sample.epub` on first launch
> (`localStorage.setItem('eupub:last','sample')`, then reloads). The app never
> shows an empty reader, which is the usual cause of a genuine 2.1 on a document
> app.

## Paste plain text, from the two `.txt` files beside this one

**App Store Connect renders no markdown anywhere.** Pasting the drafts below as
written would put literal `**`, `>` and `|` characters in front of a reviewer,
which reads worse than answering plainly. Two ready-to-paste files sit beside
this document, both pure ASCII with no markup — no smart quotes or en-dashes
either, since those can arrive mangled:

| File | Paste into | Size |
| --- | --- | --- |
| [`ios-app-review-reply.txt`](ios-app-review-reply.txt) | **Reply to App Review** — all seven answers, which is what the rejection asks for | 5,106 chars |
| [`ios-app-review-notes.txt`](ios-app-review-notes.txt) | **App Review Information ▸ Notes**, where it stays for future submissions | 3,905 chars |

They differ because **the Notes field caps at 4,000 characters** and the full
reply does not fit. The Notes version drops the two answers that are about *this*
submission rather than about the app — the video and the device list — and
tightens the rest; nothing substantive is lost. Watch the character counter in
App Store Connect regardless, and re-measure if you edit:

```powershell
(Get-Content docs\ios-app-review-notes.txt -Raw).Length
```

The sections below are the same answers with their reasoning, for editing
against. **Edit the `.txt` files, not these** — these are the explanation, those
are the artifact.

---

## 1. Screen recording — what to capture

Apple wants a recording made **on a physical device running the latest iOS**,
beginning with the app launching. Eupub has no accounts, no purchases, no
user-generated content and requests no permissions, so none of the flows they
enumerate apply; the recording is short and only has to show the core loop.

| # | Show | Why it is there |
| --- | --- | --- |
| 1 | The home screen, then tap the Eupub icon | They require the recording to begin with launch |
| 2 | The bundled sample book rendering by itself | Proves the app is not an empty shell, with no setup |
| 3 | Turn **euspell off** in the reader chrome, then on again | This *is* the product: the same page in traditional and reformed spelling. Linger a moment on each so the changed words are legible |
| 4 | Page forward and back — swipe, then tap the side thirds | Core navigation |
| 5 | Font size, and light/dark | The rest of the reader chrome |
| 6 | Bookmarks / highlights / search in the side tabs | Secondary features, briefly |
| 7 | **Open ▸** pick a PDF, and page through it | The one feature needing a file (see §4). **Do not tap the euspell toggle here** — it is disabled in PDF mode (`reader.js`, `loadPdf`), because a PDF is reformed once in the viewer at load. Tapping a dead control on camera invites the reviewer to try it too |
| 8 | Airplane mode on, and the app carrying on unchanged | Optional, and worth a few seconds: it demonstrates the claim in §5 rather than asserting it |

Two or three minutes is ample. Do not speed it up, and let each spelling toggle
sit long enough to read.

---

## 2. Devices and operating systems tested

> **Fill this in before sending — it is a statement about your testing, and I
> cannot make it for you.** List every physical iPhone and iOS version the build
> was actually run on, plus any simulators, and label them as such. For example:
> *"iPhone 15 Pro (iOS 26.x), physical device; iPhone 17 Pro simulator (iOS
> 26.x)."* If it has only been run on one device, say only that — an inflated
> list is a worse answer than a short one.

---

## 3. What the app does, and who it is for

> Eupub is an offline e-reader that displays EPUB and PDF books in **euspell**, a
> reformed English spelling, and lets the reader switch between reformed and
> original spelling at any point in the text.
>
> English spelling records history rather than pronunciation: a reader must
> already know a word to say it. That falls hardest on people learning English
> and on readers with reading difficulties. Euspell is a systematic respelling
> that makes the written form predictable, and Eupub is how a reader tries it on
> real books rather than on a table of rules — open a book, turn the reform on,
> and read.
>
> The audience is adult general readers: people learning English, readers with
> dyslexia or similar difficulties, and anyone curious about spelling reform.
> There is no age-restricted content of any kind; the app displays whatever
> book the user opens.
>
> The conversion is done by a 205,000-word lexicon bundled inside the app,
> together with a classifier that resolves words whose spelling depends on
> context. Nothing about the text leaves the device.

---

## 4. Setting up and reaching the main features

> **No account, no login, no configuration.** There are no credentials to
> provide because there is nothing to sign in to.
>
> **A sample book is built in.** On first launch the app opens a bundled sample
> automatically, so the reader has content with no setup at all. The euspell
> toggle in the reader chrome switches that text between reformed and original
> spelling — this is the app's central feature and needs nothing but the app.
>
> **To open your own book**, tap **Open** and choose an `.epub`, `.pdf` or `.txt`
> file through the standard document picker (iCloud Drive and other providers
> are reachable from there). Files can also be dropped into the app's Documents
> folder, which appears as *On My iPhone ▸ Eupub* in the Files app.
>
> **To exercise PDF support**, open any PDF through **Open**. The PDF is rendered
> normally and its text layer is reformed in place, so the page keeps its
> original layout and graphics. If it would help, we can supply a sample PDF at a
> URL — please ask and we will attach one.

---

## 5. External services, tools and platforms

> **None.** The app makes no network requests, has no server, no backend, no
> analytics, no advertising and no third-party SDKs of any kind. It does not use
> any data provider, authentication service, payment processor or AI service.
>
> Everything needed for conversion ships inside the app: the lexicon is a
> read-only SQLite database in the bundle, queried locally through the system
> `libsqlite3`. This is the same reason the submission declares
> `ITSAppUsesNonExemptEncryption = false` — there is no network traffic to
> protect.
>
> The app can be used with the device in airplane mode from first launch onwards,
> which is the simplest way to confirm the above.

---

## 6. Regional differences

> **None.** The app behaves identically in every region and on every storefront.
> It has no region-specific content, pricing, features or restrictions, and does
> not detect or respond to location — it requests no location permission and has
> no network access with which to infer one.
>
> The app's interface and the reform it implements are English-only, which is a
> property of the subject matter rather than a regional variation.

---

## 7. Regulated industries and third-party material

> The app is in no regulated industry and provides no regulated service.
>
> Eupub contains no third-party copyrighted books or texts. The bundled sample is
> written for the app itself. Every other book is one the user supplies from
> their own device or storage, and nothing is distributed with the app.
>
> The euspell reform, its lexicon and the reader are our own work, published as
> free software under GPL-3.0-or-later at
> <https://github.com/ossiak/eupub> and <https://github.com/ossiak/euspell>. The
> open-source components used are standard and permissively licensed — PDF.js
> (Apache-2.0) for PDF rendering, DOMPurify (Apache-2.0 / MPL-2.0) for sanitizing
> book markup, and ZIPFoundation (MIT) for reading EPUB archives. We are
> authorized to ship all of them.

---

## Two known issues, and why neither blocks a resubmission

Found on device on 17 August, after the rejection. Recorded here because the
question they raise — resubmit now or fix first — is worth answering once.

**The euspell toggle does nothing on a PDF.** By design, not a fault:
`loadPdf()` in [`reader.js`](../src/renderer/reader.js) sets
`els.euspell.disabled = true`, because a PDF is reformed once inside the viewer
at load and the toggle was never wired through to it. Desktop and Android behave
identically. What makes it read as a bug is that the control is left *checked*
as well as disabled, so it looks stuck rather than inapplicable. A reviewer will
not care unless the video invites them to press it — hence the warning in row 7
above.

**A rotated display does not re-fit the width.** The chapter runtime handles
this (`viewer-runtime.js` has a debounced `resize` listener); the PDF viewer does
not. `scaleFor()` fits pages to the container width at render time only, and the
canvases carry inline dimensions, so a document laid out at one width keeps it.
The browser extension shares the limitation — resizing a desktop window does the
same.

**On iOS this should be unreachable.** The app is locked to portrait and to
iPhone (`UISupportedInterfaceOrientations`, `TARGETED_DEVICE_FAMILY = 1`, added
in `3c610a1` for the App Store validation failure). If a build rotates, it
predates that commit — check that before treating rotation as a live defect.

Neither is a crash, a broken feature, or something a reviewer can stumble into
on a portrait-locked build, so neither is a reason to hold the reply. Fix them
because they are worth fixing, on their own schedule.

**Both are declared in the reply and the notes, and that is not optional.** A
reviewer's job is to press things. Finding a checkbox that does nothing, with no
explanation on file, is exactly how an information rejection becomes a bug
rejection under the same guideline — the letter's own "How to Prevent Common
Issues" opens with 2.1 bugs and crashes. Saying beforehand that the control is
deliberately disabled on PDFs, and why, converts a discovery into a confirmation.
The portrait-only and iPhone-only decisions are stated for the same reason.

## Before resubmitting

- **Answer §2 truthfully**, and test on a physical device on current iOS first if
  that has not been done. Guideline 2.1 also covers crashes found on real
  hardware, and a second rejection for that would be self-inflicted.
- **Check the App Store screenshots** show the app in use rather than a splash
  screen or title art — the rejection letter flags 2.3.3 as a common follow-on
  failure, and for this app a screenshot is only meaningful if reformed spelling
  is legible in it.
- **Reply on the existing submission** rather than uploading a new build, unless
  something else forces a rebuild.
