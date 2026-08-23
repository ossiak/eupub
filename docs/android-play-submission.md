# Publishing Eupub to Google Play

What remains between the Android app as it stands and a listing on Google Play.
Signing keys are covered separately in [android-signing.md](android-signing.md),
which this assumes you have read; that document ends where this one begins.
**A Play listing is not the only way to ship an Android app, and may not be the
right one — §10 sets out the alternatives and what each costs.**

Everything below was checked against the repository and against Google's own
documentation on **16 August 2026**. Two of the dates move, so re-read §3 and §6
before acting on them.

## Where this stands today

| | State |
| --- | --- |
| Release keystore | **In place.** `android/keystore.properties` is git-ignored and written by CI from secrets; the published APK verifies v2+v3 against the release key |
| `applicationId` | `org.euspell.eupub` — permanent once uploaded, so settle it now |
| `compileSdk` / `targetSdk` | **34 / 34** — below Play's floor (see §3) |
| Toolchain | AGP 8.5.2, Gradle 8.7, Kotlin 1.9.24 |
| `minSdk` | 26 (Android 8.0) |
| Version | 0.3.1, from `package.json`; `versionCode` derives to 301 automatically |
| App bundle | **Never built.** `bundleRelease` is documented but has not been run |
| CI | **`apk` job added** — `release.yml` now has `appimage`, `dmg`, `apk`, `nsis`. It reads signedness back off the artifact with `apksigner`, so a wrong keystore fails closed (see the section on the Android job in CI) |
| Launcher icons | Present, all densities |
| Play store graphics | **None** — no 512×512 icon, no feature graphic, no phone screenshots |
| Play Console account | Not registered |
| `INTERNET` permission | Absent, deliberately. This is worth more than it sounds (§7) |

## 1. The decision — settled: direct download

> **Decided 16 August 2026: Eupub for Android ships as a signed APK from the
> Releases page, not through Google Play.** The rest of this section is the
> reasoning, kept because it is also what a reversal would cost.
>
> What follows from it: the signing key stays ours, so installs update cleanly
> forever and there is no cutover to plan; §3's API 36 deadline and §6's
> three-week testing gate do not apply; and §10.1 — direct download with
> Obtainium for updates — is the live route, with §§2–9 kept as the map if the
> decision is ever revisited.
>
> The one thing this decision buys that is easy to overlook: it can be reversed
> *later at a price*, and the price only starts accruing once an APK is in
> people's hands. Moving to Play or F-Droid after that makes every existing user
> uninstall and lose their library and reading positions.



Play App Signing re-signs your upload with a key Google holds. An app installed
from Play is therefore signed with a **different key** from one you sideload, and
Android refuses to update across a key change: a user would have to uninstall
first, losing their library, bookmarks and reading positions, which live in the
WebView's `localStorage`.

The remaining obligation of the direct-download route is **Google's developer
verification** for apps installed outside Play: registration is already open, the
requirement begins in September 2026 for Brazil, Indonesia, Singapore and
Thailand, and globally from 2027. After that a certified device refuses an APK
from an unregistered developer. It is paperwork rather than code, there is a
lighter path for hobbyist developers, and it is the one dated item this decision
does not remove — so it wants a calendar entry, not a rethink.

## 2. Create the release key

[android-signing.md](android-signing.md) §1–§2, unchanged: `keytool`, a PKCS12
keystore kept outside the working tree, and `android/keystore.properties`
pointing at it. Ten minutes, nothing to buy, no certificate authority.

Under Play App Signing this becomes your **upload key** rather than the key users
verify, which means it can be reset if lost — a real safety net the sideload path
does not have. Back it up anyway.

Confirm it took with `.\gradlew.bat :app:signingReport`: `Config: release` rather
than `Config: null`.

## 3. Raise the target API level

**This is the largest piece of work, and it has a deadline.**

Play requires new apps and updates to target **Android 16 (API 36)** from
**31 August 2026** — a fortnight from this writing. Existing apps must target at
least API 35 to stay available to new users on newer devices. An extension to
**1 November 2026** can be requested from Play Console.

`compileSdk = 34` / `targetSdk = 34` is below both floors, so this blocks
submission outright rather than merely dating the app.

It is not a one-line change:

- **The toolchain has to move first.** AGP 8.5.2 cannot compile against API 36.
  The current plugin is **AGP 9.3.0** (July 2026), which requires **Gradle 9.5.0**
  and supports up to API 37 — so this is a major-version upgrade of both, not a
  patch. Read the exact minimum AGP for API 36 from the release notes at upgrade
  time rather than guessing; the Kotlin plugin will likely move with it.
- **Edge-to-edge display is enforced for `targetSdk` 35 and above.** Eupub is a
  `Theme.Material.Light.NoActionBar` WebView reader, so its content will draw
  under the status and navigation bars until window insets are handled. This is
  the behaviour change most likely to need real work, and it is visible on every
  screen.
- Re-check the WebView and storage behaviour changes for 35 and 36 as well; both
  touch this app.

Test on a device, not only an emulator: the reader's gesture handling and the
side-third tap zones interact with system gesture insets.

## 4. Build an App Bundle

Play does not accept APKs from new apps.

```powershell
npm run build                      # engine, lexicon, PDF viewer (repo root)
node android\prepare-assets.mjs    # -> android/app/src/main/assets/
cd android
.\gradlew.bat bundleRelease        # -> app/build/outputs/bundle/release/app-release.aab
```

The asset staging step is not optional. A stale `app/src/main/assets/` is the
usual cause of "it built and signed fine but the reader is the old one".

`versionCode` needs no attention: it is derived from `package.json`
(`major*10000 + minor*100 + patch`, so 0.2.3 → 203) and rises with any
`npm version` bump. Play never accepts a repeated code, so re-uploading a fixed
build of the same version means bumping the patch rather than editing Gradle.

## 5. Register the Play Console account

A one-time **$25** fee, separate from the $5 already paid for the Chrome Web
Store. Choose the account type deliberately, because it sets §6:

| Account type | Consequence |
| --- | --- |
| **Personal** | Subject to the closed-testing requirement in §6 |
| **Organisation** | Exempt from it, but requires business verification (a D-U-N-S number and matching records) |

## 6. The closed test, which sets the schedule

Personal Play Console accounts created after **13 November 2023** must run a
closed test with **at least 12 testers opted in continuously for 14 days** before
they may apply for production access.

"Continuously" is enforced: testers who opt in, test briefly and opt out do not
count, and someone who leaves and rejoins must accumulate 14 *consecutive* days.
After that you apply for production and answer questions about the testing, the
app's design and its readiness; Google's review is typically seven days or less.

> **Minimum three weeks from a working bundle to a public listing**, and that
> assumes twelve people are recruited and opted in on day one. This, not the
> code, is the long pole — and it is why an Android listing cannot be part of the
> 28 August launch.

Recruit the testers while §3 is in progress; the two do not have to be serial.

## 7. Declarations

Each is a form in Play Console, and Eupub's answers are unusually simple.

| Form | Eupub's position |
| --- | --- |
| **Data safety** | No data collected, none shared, none transmitted. The manifest has **no `INTERNET` permission** at all, which is the cleanest possible answer to a form most apps struggle with |
| **Content rating** | A reading app with no user-generated content, no ads, no purchases |
| **Target audience** | Not directed at children — say so, and avoid the Families policy programme |
| **Ads** | None |
| **App access** | No login; all functionality is available without an account |
| **News / government app** | Neither |
| **Privacy policy** | A URL is mandatory. It must be live and reachable before submission |

The privacy policy is the only one with an external dependency: it needs the site
deployed, or at least that page served.

## 8. Store listing and graphics

| Asset | Requirement | Have it? |
| --- | --- | --- |
| App name | ≤ 30 characters | `Eupub` |
| Short description | ≤ 80 characters | To write |
| Full description | ≤ 4000 characters | To write |
| App icon | 512 × 512 PNG, 32-bit | **No** — the launcher mipmaps are far smaller |
| Feature graphic | 1024 × 500 | **No** |
| Phone screenshots | 2–8, 16:9 or 9:16 | **No** — the four that exist are 1280 × 800 for the Chrome Web Store, the wrong aspect |

Screenshots have to come from the Android app itself, not from the desktop build:
Play reviewers reject listings whose imagery is not the app being submitted.

## 9. The Android job in CI (done)

[`release.yml`](../.github/workflows/release.yml) now has an `apk` job beside
`appimage`, `dmg` and `nsis`, on `ubuntu-latest`, using the same sibling
`euspell_ext` checkout the desktop jobs use. It reads the four `ANDROID_*`
secrets described in [android-signing.md](android-signing.md), and degrades the
way the others do — without them the build still runs, so forks and dry runs
work.

**One place it deliberately does not follow the others.** The macOS and Windows
jobs attach their asset whether or not it was signed, because an unsigned dmg or
installer still runs after the user clicks through a warning. An unsigned apk
does not install at all, so publishing one would put a file on the Releases page
that no phone will accept. The job therefore verifies the built apk with
`apksigner` and attaches it **only if it is signed**, leaving an unsigned build
as a workflow artifact. Signedness is read back off the artifact rather than
inferred from whether a secret was set, so a keystore that is present but wrong
fails closed.

## 10. Alternatives to listing

Play is one distribution channel among several, and its gates — §3's API deadline
and §6's three weeks — are the price of that channel specifically. None of the
alternatives below charges either.

**The decision underneath all of them is which key signs the app users install.**
Yours, Google's, or F-Droid's. Android refuses to update across a key change, so
moving between them later forces every user to uninstall and lose their library,
bookmarks and reading positions. That is why §1 matters more than it looks: the
choice is nearly free today and expensive the moment an installed base exists.

| Route | Signed by | Fee | Gate | Updates |
| --- | --- | --- | --- | --- |
| **Direct download** (§10.1) | You | — | None | Manual, or automatic via Obtainium |
| **F-Droid** (§10.2) | F-Droid | — | Build must be self-contained; weeks of review | Automatic |
| **Play internal testing** (§10.3) | Google | $25 | Account, API 36, a bundle | Automatic, ≤ 100 testers |
| **Play production** (§1–§9) | Google | $25 | API 36, 12 testers × 14 days, review | Automatic |
| **Amazon / Samsung** (§10.4) | Varies | — | Each store's own review | Automatic |

### 10.1 Direct download, with real updates

This is the route [installing.md](installing.md) already describes, and the only
thing it lacks is updating. **Obtainium** supplies that: the user installs it
once, points it at the repository, and it watches for new releases and installs
them the way a store client would.

Two prerequisites, neither of them large:

1. **Releases must actually carry an APK.** None do yet. `release.yml` now has an
   `apk` job that builds and attaches one, but it publishes **only when the build
   was signed** — an unsigned apk cannot be installed at all, so putting one on
   the Releases page would offer a file no phone accepts. So the keystore (§2)
   and the four `ANDROID_*` secrets are what turn the job from a build into a
   release asset.
2. **Name the asset consistently**, `eupub-<version>.apk`, which is what
   installing.md already tells users to look for and what the job emits.
   Obtainium matches release assets by pattern, and a name that changes shape
   between releases breaks the match silently.
3. **Correct installing.md on the same day the first apk ships**, not before. Two
   statements there are true today and become false the moment a release carries
   one, and they are worth grepping for rather than editing from memory:
   - the note under the platform table, *"**No APK is published.** The release
     workflow builds only the Linux, macOS and Windows assets…"*
   - the troubleshooting row *"Android: no APK in the release — There isn't
     one…"*

   The platform table's own Android row (`build it yourself`) and the
   [Android](installing.md#android) section's opening also need re-reading, since
   both are written around the absence of a download.

For the install page, the instructions are:

> Install **Obtainium** (from its own GitHub releases, or from F-Droid or
> IzzyOnDroid). Open it, tap **Add App**, and paste
> `https://github.com/ossiak/eupub`. Obtainium reads the Releases page, offers
> the latest APK, and notifies you when a newer one appears.

You keep your own signing key, so there is never a cutover, and updates install
over the top exactly as they should.

The costs are real but bounded: Play Protect warns on first install, and Google's
**developer verification** for apps installed outside Play begins biting in
September 2026 for Brazil, Indonesia, Singapore and Thailand, and globally from
2027 — after which a certified device refuses an APK from an unregistered
developer. There is a lighter path for hobbyist developers, but it still means
registering an identity against this app's signing key. Paperwork, not code.

### 10.2 F-Droid

The natural home for this app: GPL-3-or-later, no network permission, no
trackers, no ads, no purchases. No fee, no tester requirement, no Play API
deadline, and the F-Droid client gives genuine automatic updates.

**One blocker, and it is structural.** F-Droid's build server builds a single
repository from source, and Eupub is not independently buildable:
[`build/copy-lexicon.js`](../build/copy-lexicon.js) and
[`copy-pdf-viewer.mjs`](../build/copy-pdf-viewer.mjs) both resolve
`path.join(EUPUB, '..', 'euspell_ext')` — a **sibling** checkout — and throw if it
is absent. A fresh clone of this repository alone cannot produce an APK.

Note the shape of the fix: because the expected path is a sibling *outside* the
repository, adding `ossiak/euspell` as a submodule is not sufficient on its own —
a submodule lands *inside* the working tree, where neither script looks. The work
is therefore:

1. Add the engine as a submodule at a fixed in-repo path.
2. Change both resolvers to prefer that path and **fall back** to the sibling, so
   local development against a live `euspell_ext` checkout keeps working exactly
   as it does now.
3. Confirm nothing prebuilt is committed — F-Droid rejects binaries it cannot
   rebuild. The lexicon is generated at build time, which is the right answer
   already.
4. Expect scrutiny of the Node step: the build needs Node and an `npm install`,
   which F-Droid permits but examines, and pinning `package-lock.json` is what
   makes that argument winnable.
5. Write the metadata YAML and open a request-for-packaging and a merge request
   against `fdroiddata`.

Reckon on a day for the build work and weeks for inclusion. **F-Droid signs with
its own key**, so it carries the same cutover cost as Play against an existing
sideloaded base — which is another reason to choose before that base exists.

### 10.3 Play internal testing, without a listing

Frequently missed: the **internal testing track** takes up to 100 testers, goes
live within minutes, and skips production review entirely. §6's twelve-testers-
for-fourteen-days gate applies to *production access*, not to internal testing.

If the goal is real users on real phones soon rather than a public listing, this
is the fastest legitimate route. It still needs the account (§5), the API 36 work
(§3) and a bundle (§4) — it removes the waiting, not the engineering.

### 10.4 Amazon Appstore and Samsung Galaxy Store

Both are real stores with their own review, no tester gate, and lower bars than
Play. Both are also another listing to maintain, and the audiences are small —
Amazon skews to Fire tablets, which is not this app's shape. Worth doing when
somebody asks for it, not before.

### What this comes down to

Ship the signed APK on Releases with Obtainium instructions: it is available now,
mostly documented already, and it keeps the signing key in your hands. Then
choose Play or F-Droid **before** that APK acquires an installed base worth
protecting.

The one thing to avoid is drift — sideloading indefinitely while intending to
list eventually pays every cost of both and banks the benefits of neither.

## The order that minimises waiting

Assuming Play production is the destination. If it is not, §10 is the shorter
route, and step 1 is still step 1.

1. Create the release key (§2) — ten minutes, unblocks everything else.
2. Register the Play Console account (§5) and start recruiting testers (§6).
3. Raise the target API and fix edge-to-edge (§3) — the real work.
4. Build the bundle (§4), upload to closed testing, start the 14-day clock.
5. Write the listing and produce the graphics (§8) while the clock runs.
6. Fill in the declarations (§7); confirm the privacy policy URL is live.
7. Apply for production; allow up to seven days for review.

## Sources

- [Meet Google Play's target API level requirement](https://developer.android.com/google/play/requirements/target-sdk)
- [Prepare your app for review — closed testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)
- [Android Gradle plugin release notes](https://developer.android.com/build/releases/gradle-plugin)
- [Understanding Android developer verification](https://support.google.com/android-developer-console/answer/16561738)
