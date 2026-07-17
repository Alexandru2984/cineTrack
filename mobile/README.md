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
[EAS Build](https://expo.dev/accounts/micu984/projects/vazute/builds/dda72b0d-2fdf-4e50-b760-a84a47c16949).
It was built from `f19130c` and includes the permission hardening, but predates
the current session, tracking lookup, account deletion, and privacy changes.
Create a new preview build before distributing another APK.

## OTA updates

EAS Update is configured with a runtime tied to the native app version and
isolated `development`, `preview`, and `production` channels. Publish only JS
and asset changes that are compatible with the native modules already present
in that runtime:

```bash
npx eas-cli update --channel preview --message "Describe the tested change"
npx eas-cli update --channel production --message "Describe the tested change"
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
