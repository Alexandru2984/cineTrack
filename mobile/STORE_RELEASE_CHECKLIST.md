# Mobile store release checklist

Nothing in this checklist authorizes a Git push, deployment, EAS build, store
submission, or credential change. Run those steps only from a reviewed commit.

## The artifact — read this first

The local `assembleRelease` build proves the app **compiles** and produced a
113 MB APK. That APK is **not** a store artifact, for two reasons:

1. **It is debug-signed** (`CN=Android Debug`). Play rejects debug-signed
   uploads. The release build must be signed with an upload key.
2. **Play wants an AAB, not an APK.** New apps upload an Android App Bundle
   (`bundleRelease` → `.aab`), and Play generates per-device APKs from it. An
   APK cannot be uploaded as a new app.

The intended path is **EAS Build** (`eas build --platform android --profile
production`), which produces a signed `.aab` using credentials EAS manages —
you never handle the keystore. That step needs the Expo account and, for
submission, the Play account. Building locally is only a compile check; do not
try to ship the local artifact.

Once EAS has built and Play has ingested the first release, note the **app
signing** SHA-256 fingerprint from Play Console (Play re-signs with its own key)
and add it to `frontend/public/.well-known/assetlinks.json` — the upload-key
fingerprint alone will not verify Android App Links on store builds.

## Repository gates

- `./scripts/check_release_metadata.sh` passes from the repository root.
- The release candidate version is `1.2.0`; EAS reports runtime `1.2.0` and a
  new remote build number before distribution.
- The Git worktree contains only the intended release commit.
- GitHub CI is green, including the Android release compile and validation of
  the final merged release manifest's permissions and exported components.
- `npm ci && npm run verify && npm run audit:high` passes in `mobile/`.
- The production Expo config reports `updates.enabled=false`.
- The app/runtime version is newer than every distributed native runtime using changed native modules.
- The backend migration job succeeds before application replicas start.

## Production secrets and operations

- `TOTP_ENCRYPTION_KEY` is a persistent random 32-byte key stored off-host; losing it disables existing 2FA setups.
- Database backups use a dedicated R2 bucket/token and `BACKUP_AGE_RECIPIENT`.
- A restore drill into a disposable database has passed and the Prometheus backup alerts are loaded.
  Last drill: 2026-07-21, `cinetrack_20260721_033001.dump.age` into `cinetrack_restore_drill`.
  Row counts matched production except 200 `media` rows added by the daily catalog
  hydration after the backup ran; no row existed in the restore that production
  lacked. Re-run after any change to the dump format or the age recipient.
  Every stored backup is now an encrypted custom-format `.dump.age`. The legacy
  plain-SQL `.sql.gz` snapshots were converted and the plaintext originals
  deleted on 2026-07-21; `restore_from_r2.sh` never accepted that older format,
  so anything still named `.sql.gz` would only restore by hand via `zcat | psql`.
  A converted snapshot was restored as part of the same drill to prove the
  conversion kept its data.
- SMTP/Resend delivery is verified for verification, reset, and security-event emails.
- No `.env`, credentials, signing keys, tokens, database dumps, or generated native projects are tracked by Git.

## Community safety

- Terms of Service and Community Guidelines open from registration and
  Settings in both supported languages.
- A fresh account must accept the current terms version before using community
  features.
- Reporting and blocking work from a second test account on both web and
  native clients; blocked members cannot regain visibility through direct API
  requests.
- Direct messages work only between mutual followers; unfollowing disables new
  sends, blocking removes the relationship, received messages can be reported,
  and message bodies never enter the persistent mobile query cache.
- The moderator test account has verified email and 2FA, and every status
  change requires a note and creates an audit entry.
- Child-safety and threatening-content reports sort ahead of the normal queue.
  A decided report can be reopened for review when someone appeals, which is
  what the Community Guidelines promise; the outcome is never flipped straight
  to the opposite one, and every transition appends its own audit entry.
- Sign-up requires both the Terms acceptance and the 16+ attestation, matching
  the target-audience declaration in Play Console.
- The public privacy policy discloses report snapshots and moderation
  retention.

## Google Play

- Create the Play application and enable Play App Signing.
- Add the Play **app signing** SHA-256 fingerprint, not only the upload/EAS fingerprint, to `frontend/public/.well-known/assetlinks.json`.
- Verify `https://vazute.micutu.com/.well-known/assetlinks.json` returns HTTP 200, no redirect, and `application/json`.
- Reinstall the signed release and test `/reset-password`, `/media`, `/episodes`, `/profile`, `/lists`, and `/messages` links with `adb`.
- Complete Data safety from the actual behavior documented at `https://vazute.micutu.com/privacy`.
- Set the account-deletion URL to `https://vazute.micutu.com/account-deletion` and verify deletion inside the app.
- Review the production AAB permissions and confirm that blocked permissions did not return.
- Add FCM v1 credentials only when release alerts are intentionally enabled for the store build.

## Apple App Store

- Enroll in the Apple Developer Program and obtain the real Team ID.
- Create `frontend/public/.well-known/apple-app-site-association` with app ID `<TEAM_ID>.com.micutu.vazute` and only the supported paths.
- Serve the AASA file over HTTPS without a redirect and verify the Associated Domains capability on the signed build.
- Complete App Privacy using the production data flows and the public privacy policy.
- Verify in-app account deletion, password reset, session revocation, and Sign in with Apple applicability before submission.

The Apple Team ID and Play App Signing fingerprint are external values and must
never be guessed or copied from an unrelated signing identity.

## Release verification

- Install the exact signed artifact on a normal device, not only Expo Orbit or an emulator.
- Test fresh install, login with and without 2FA, offline launch, token refresh, logout, reset link, and account deletion.
- Test media/episode sharing, incoming app links while signed out, login return, and incoming links while offline.
- With two mutual-follow test accounts, verify inbox badges, idempotent resend,
  read state, unfollowed/blocked composer behavior, and individual message
  reporting in both Romanian and English.
- Confirm `completed`, season bulk watch, and watched-through never add unreleased episodes.
- Confirm privacy/cache clearing, crash-report redaction, notification opt-in/out, and device-token revocation.
- Select valid and invalid TV Time exports, verify upload limits, background progress, and the completed library refresh.
- Choose, replace, and remove a profile picture; confirm the system picker requests no camera or broad media permission.
- Open the annual recap for a year with and without watch history; verify year navigation and title deep links.
- Log a watch with Today, Yesterday, and the native date picker; verify future dates cannot be selected.
- Export account data with a correct and incorrect password; inspect the JSON for completeness and absence of credential fields.
- Record the commit, version, version code/build number, signing identity, CI run, and artifact checksum in the release notes.
- Verify Romanian and English navigation, validation, legal, reporting, and
  account-management copy on at least one physical device.
