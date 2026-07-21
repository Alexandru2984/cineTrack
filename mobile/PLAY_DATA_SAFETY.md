# Google Play Data Safety declaration

Fill the Data Safety form in Play Console to match this exactly. Every entry
below was verified against the schema and the app, not assumed — if the app
changes, re-verify before editing this, because a Data Safety form that
contradicts observable behaviour is grounds for removal.

## The one-line summary

The app collects an email address (for the account), watch history (the core
feature), and a push token (only if notifications are turned on). Nothing is
sold. Nothing is shared with third parties for their own purposes. Everything
is deletable in-app.

## Data collected

| Play data type | Collected? | Required? | Purpose | Notes |
| --- | --- | --- | --- | --- |
| **Email address** | Yes | Yes | Account management | Verified on signup. |
| **Name / username** | Yes | Yes | Account, app functionality | Public display name, chosen by the user. |
| **Photos** (avatar) | Optional | No | App functionality | Only if the user uploads one. |
| **App activity — watch history** | Yes | Yes | App functionality | The core feature: what the user marked watched. |
| **App activity — other (reactions, ratings, lists)** | Optional | No | App functionality | Only what the user creates. |
| **Device ID** (push token) | Optional | No | Send notifications | Only if the user enables release notifications. |
| **App info & performance — crash logs / diagnostics** | Yes | No | App functionality (stability) | Sanitised on-device before sending: tokens, emails and URLs are redacted. |
| **Approximate/precise location** | **No** | — | — | The app requests no location permission. |
| **Contacts, calendar, SMS, microphone, camera** | **No** | — | — | None of these modules or permissions are present. |
| **Financial info** | **No** | — | — | No payments. |

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
  account. Everything else — avatar, push token, ratings, reactions, lists — is
  created only by user action.

## Permissions

Only `android.permission.INTERNET` is active. Six others that Expo modules
declare by default are explicitly removed via `blockedPermissions` and appear in
the built manifest with `tools:node="remove"` (verified: 6 removed). There is no
storage, location, biometric, camera or overlay permission in the shipped app.

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
