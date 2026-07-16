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

## Verification

```bash
npm run verify
npm run export:android
npm audit --audit-level=high
```

## Builds

`eas.json` contains development, internal preview, and production profiles.
An Expo account and signing credentials are required to run EAS Build.

```bash
npx eas-cli build --profile preview --platform android
npx eas-cli build --profile production --platform all
```
