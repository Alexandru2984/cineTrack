# Văzute Mobile

Native iOS and Android client built with Expo SDK 57 and Expo Router.

## Local development

Requirements:

- Node.js 22.13 or newer
- Android Studio for a local Android emulator
- Xcode on macOS for a local iOS simulator

```bash
npm ci
cp .env.example .env.local
npm start
```

The production API is used by default. Set `EXPO_PUBLIC_API_URL` to an origin
without the `/api` suffix when running another backend. Release builds reject
non-HTTPS origins; HTTP is accepted only by development bundles.
Images use the backend's write-through R2 cache by default. Set
`EXPO_PUBLIC_USE_R2_IMAGES=false` only when the target backend has no R2
storage configured.

## Verification

```bash
npm run verify
npm run export:android
npm audit --audit-level=high
```

## Builds

`eas.json` contains development, internal preview, and production profiles.
An Expo account and signing credentials are required to run EAS Build.
The app is linked to the EAS project
[`@micu984/vazute`](https://expo.dev/accounts/micu984/projects/vazute).

```bash
npx eas-cli build --profile preview --platform android
npx eas-cli build --profile production --platform all
```

The latest audited Android preview build is recorded on
[EAS Build](https://expo.dev/accounts/micu984/projects/vazute/builds/35737b10-2c3a-47c8-b7f7-d79dc5181a01).
It is Android `versionCode` 3 with runtime `1.0.0`, built from `9952eb4`, and
includes the current native permission, secure session, account deletion,
Android App Link, and EAS Update configuration. The tested preview OTA group
`faa835bc-cb68-41e1-8731-885c78daa2a1` was published from `db943a0` and adds
the mobile rating/review editor, all tracking statuses, notification inbox,
badges, complete statistics, profile/privacy editing, release-region controls,
password changes, and active-session management.

That build does **not** contain the AsyncStorage, NetInfo, Crypto, or
Notifications native modules used by the current client. The current native
runtime is `1.1.0`; never publish this JavaScript as an OTA update to runtime
`1.0.0`. Because `eas.json` uses remote app-version management, verify that the
next EAS build resolves to app/runtime version `1.1.0` before distributing it.

## Offline cache

Successful library, calendar, history, list, statistics, and media queries are
kept for up to seven days. Cache restoration is scoped to the SecureStore user
identity, and logout or an account change clears both memory and AsyncStorage.
Tokens remain in SecureStore. Notifications, social data, account sessions,
and user search results are excluded from persistence.

## Crash diagnostics

Render failures and uncaught JavaScript errors are sanitized on-device and
reported to the authenticated Văzute API. A bounded queue keeps at most ten
reports while offline and is cleared on logout or an account change. Tokens,
email addresses, URL parameters, device identifiers, and advertising
identifiers are excluded. Reports stay in the self-hosted rotating server logs;
no third-party crash-reporting SDK is used. Deploy the matching backend endpoint
before distributing this client. The reporter adds no native dependency, but
the offline-cache modules described above still require a new native build.

## Release alerts

Release alerts are off by default and the operating-system permission prompt is
shown only after the user enables them in Account settings. The installation
keeps a random revocation secret in SecureStore, while the backend stores only
its SHA-256 hash. Logout, an account change, permission withdrawal, or an
explicit opt-out removes the device; failed offline revocations stay in a
bounded SecureStore queue until connectivity returns.

The backend creates a per-device outbox for unwatched episodes airing on the
device's local date and planned movies released in the user's selected region.
Expo tickets and receipts are checked without logging tokens, transient errors
are retried, `DeviceNotRegistered` removes the device, and terminal delivery
rows expire after 30 days. `scripts/sync_release_schedules.sh` also dispatches
the outbox; run it hourly so receipts and retries are not delayed even though
fresh TMDB schedule data remains subject to its own bounded cadence.

Expo Push Service is free, but Android delivery still requires FCM v1
credentials to be added to the EAS project and a fresh native build. Remote
notifications are not available in Expo Go on Android. Enhanced Expo push
security is optional; after enabling it in the Expo dashboard, set the matching
`EXPO_PUSH_ACCESS_TOKEN` only in the backend environment. iOS delivery remains
blocked until a paid Apple Developer team and APNs credentials exist. No FCM,
APNs, Expo access token, remote build, or test notification was created by this
change.

## OTA updates

EAS Update is configured with a runtime tied to the native app version and
isolated `development`, `preview`, and `production` channels. Publish only JS
and asset changes that are compatible with the native modules already present
in that runtime:

```bash
npx eas-cli update --channel preview --environment preview --platform android --message "Describe the tested change"
npx eas-cli update --channel production --environment production --platform all --message "Describe the tested change"
```

Adding or updating a native module, changing permissions, or changing native
configuration still requires a new EAS Build. Test on `preview` before
publishing the same commit to `production`.

## Password-reset links

Android App Links are enabled for
`https://vazute.micutu.com/reset-password`. The domain association contains the
SHA-256 fingerprint of the EAS Android keystore, and the reset token stays in
the URL fragment so it is not sent in HTTP requests. After Google Play App
Signing is enabled, add the Play signing certificate fingerprint to
`frontend/public/.well-known/assetlinks.json` alongside the EAS fingerprint.

The custom `vazute` scheme remains available for local testing. iOS universal
links require the Apple Developer Team ID and an Apple App Site Association
file; until those credentials exist, the HTTPS reset link intentionally opens
the web reset flow on iOS.
