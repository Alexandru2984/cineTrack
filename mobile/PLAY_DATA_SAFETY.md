# Google Play Data Safety declaration

Fill the Data Safety form in Play Console to match this exactly. Every entry
below was verified against the schema and the app, not assumed — if the app
changes, re-verify before editing this, because a Data Safety form that
contradicts observable behaviour is grounds for removal.

## The one-line summary

The app collects an email address (for the account), watch history (the core
feature), optional aggregate feature-interaction counts, and a push token (only
if notifications are turned on). Nothing is sold. Nothing is shared with third
parties for their own purposes. Account data is deletable in-app; the aggregate
counters alone cannot identify an account.

## Data collected

| Play data type | Collected? | Required? | Purpose | Notes |
| --- | --- | --- | --- | --- |
| **Email address** | Yes | Yes | Account management | Verified on signup. |
| **Name / username** | Yes | Yes | Account, app functionality | Public display name, chosen by the user. |
| **App activity — watch history** | Yes | Yes | App functionality | The core feature: what the user marked watched. |
| **App activity — other (reactions, ratings, lists)** | Optional | No | App functionality | Only what the user creates. |
| **App activity — app interactions** | Optional | No | Analytics | Successful use of a fixed set of optional features is counted only in aggregate, without a user/device identifier or free-form property. |
| **Photos** (profile avatar) | Optional | No | Account management, app functionality | Only the single profile picture the user explicitly chooses. |
| **Device ID** (push token) | Optional | No | Send notifications | Only if the user enables release notifications. |
| **App info & performance — crash logs / diagnostics** | Yes | No | App functionality (stability) | Sanitised on-device before sending: tokens, emails and URLs are redacted. |
| **Approximate/precise location** | **No** | — | — | The app requests no location permission. |
| **Contacts, calendar, SMS, microphone, camera** | **No** | — | — | None of these permissions are requested. |
| **Financial info** | **No** | — | — | No payments. |

TV Time import is user-initiated and processes the selected export as watch
history/app activity under the entries above. The system document picker grants
access only to explicitly selected files; no broad media or storage permission
is requested, and the raw files are not retained after the import job is
accepted.

Avatar upload is also user-initiated. The system photo picker grants access only
to the selected image; the app resizes it and re-encodes it without EXIF
metadata before upload. The resulting avatar is stored until the user removes
it or deletes the account.

Account export is user-initiated and password-confirmed. It creates a portable
JSON snapshot, opens the operating system share sheet, and deletes the
temporary plaintext cache file when that sheet closes. The export excludes
password hashes, session token hashes, 2FA secrets and recovery-code hashes,
push tokens, and device-unregister secrets.

The backend derives fixed, aggregate product-action counters only after
successful feature requests. The app sends no separate analytics event and
contains no analytics SDK. Prometheus retains the counters for 30 days; the
only label is one of eight source-controlled action names. There is no user or
device identifier, IP address, search, title, per-action timestamp, or arbitrary
event property in these counters.

## Answers to Play's specific questions

- **Is any data shared with third parties?** No. Third parties (TMDB, Cloudflare,
  Resend, Expo) are *service providers* processing on the app's behalf, which
  Play does not count as "sharing." They do not receive data for their own use.
- **Is data encrypted in transit?** Yes. HTTPS only; the app declares
  `usesCleartextTraffic="false"` on Android and `NSAllowsArbitraryLoads=false`
  on iOS.
- **Can users request deletion?** Yes, in-app: Settings → delete account, which
  removes the account and all associated rows. The account-deletion URL for the
  store listing is `https://vazute.micutu.com/account-deletion`.
- **Is data collection optional?** Email and username are required for an
  account. Everything else — push token, ratings, reactions, lists, avatar, and
  aggregate interaction counts for optional features — is created only by user
  action.

## Permissions

Verified against the generated production manifest and the native library
manifests, not only the `app.json` source. Re-check the final signed AAB in Play
Console because the shipped app merges permissions from its libraries.

**No sensitive permission is present:** no location, contacts, camera,
microphone, SMS, call log, calendar, or broad storage. That is the part Play's
Data Safety review cares about, and it is clean.

What does ship, and why:

| Permission(s) | Source | Runtime prompt? |
| --- | --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | networking / offline detection | No |
| `POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `c2dm.RECEIVE` | push notifications (opt-in) | `POST_NOTIFICATIONS` only |
| `DETECT_SCREEN_CAPTURE` | the recovery-code screen guard | No |
| `BIND_GET_INSTALL_REFERRER_SERVICE` | Play install attribution | No |
| Launcher badge permissions (Samsung, HTC, Sony, Oppo, Huawei, …) | notification badge count | No |

The only runtime-prompt permission is `POST_NOTIFICATIONS`, requested only if
the user turns on release notifications.

Camera, microphone, media/storage read, storage write, system-alert-window,
vibrate, biometric, and fingerprint permissions contributed by Expo modules
are removed by plugin configuration or `blockedPermissions`.
`READ_MEDIA_IMAGES` is contributed by `expo-screen-capture` for the optional
screenshot-listener API; Văzute only blocks capture, which does not need photo
access.

## Account deletion — Play's dedicated requirement

Play now requires a deletion path reachable **without** installing the app, plus
the in-app one. Both exist:

- In-app: Settings → delete account (requires the password).
- Web: `https://vazute.micutu.com/account-deletion` — must be listed in the
  store entry's "Account deletion" field.

## What still needs the real Play account

- The **app signing** SHA-256 fingerprint (Play re-signs uploads) must be added
  to `frontend/public/.well-known/assetlinks.json` before Android App Links
  verify on store builds. The upload-key fingerprint alone is not enough.
- The privacy policy URL (`https://vazute.micutu.com/privacy`, already live) goes
  in the store listing and must stay reachable.
