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
without the `/api` suffix when running another backend.
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

The first audited Android preview build is recorded on
[EAS Build](https://expo.dev/accounts/micu984/projects/vazute/builds/9d809f89-792c-43d7-8732-7173a78ac53c).
It was built from `e38be8b`; create a newer build before release so the
permission hardening in `76ca89d` is included.
