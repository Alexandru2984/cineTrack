# Release process

This repository deliberately separates verification, deployment, and store
submission. A successful CI run does not deploy production, trigger EAS Build,
or submit an app to a store.

Nothing in this runbook authorizes a Git push. The repository owner reviews and
pushes release commits.

## Version sources

- `mobile/app.json` is the source of the user-facing iOS/Android version.
- `runtimeVersion.policy=appVersion` gives each user-facing native version its
  own Expo runtime.
- `mobile/eas.json` uses the remote version source only for Android
  `versionCode` and iOS `buildNumber`; EAS increments those developer-facing
  values.
- `mobile/package.json`, the root package in `mobile/package-lock.json`, and the
  current entry in `CHANGELOG.md` must match the app version.

Run the invariant locally:

```bash
./scripts/check_release_metadata.sh
```

## 1. Prepare a release candidate

1. Choose the next semantic version and update the three mobile version fields.
2. Move the matching changelog entry from `Unreleased` to the release date only
   after the signed artifact is accepted for distribution.
3. Run `./scripts/check_release_metadata.sh`.
4. Run the full local gate with `./scripts/run_tests.sh`.
5. Review the complete diff and commit it. Do not build or deploy from a dirty
   worktree.
6. Let the repository owner push the reviewed commit.

Every push to `main` runs GitHub CI. The repository has no GitHub Actions
production-deploy workflow, so a green push alone cannot modify the VPS.

## 2. Deploy the web and API manually

Record the candidate commit and the currently deployed commit before starting.
Use the production environment file already present on the host; never print or
copy its values into release notes.

```bash
git rev-parse HEAD
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d db
./scripts/provision_db_role.sh .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod build backend frontend
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm --no-deps backend /usr/local/bin/cinetrack --check-config
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  run --rm --no-deps backend /usr/local/bin/cinetrack --check-smtp
docker compose --profile ops -f docker-compose.prod.yml --env-file .env.prod \
  run --rm migrate
./scripts/provision_db_role.sh .env.prod
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

The migration job must succeed before application containers are replaced.
After deployment, verify container health, the public health endpoint, and the
main authenticated flows:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
curl --fail --silent --show-error https://vazute.micutu.com/api/health
curl --fail --silent --show-error https://vazute.micutu.com/.well-known/security.txt
```

Check login, token refresh, search, tracking, Up Next, settings, reporting, and
the moderator queue with dedicated non-production accounts. Keep the previous
source commit and database backup available until the smoke check finishes.
Application rollback must never reverse an already-applied database migration;
restore the previous application commit only when its schema compatibility is
known.

## 3. Build the native artifact

The current production profile disables OTA updates. Every production
JavaScript or native change therefore ships through a new signed binary.

Before creating an artifact:

```bash
cd mobile
npm ci
npm run verify
npm run audit:high
EAS_BUILD_PROFILE=production EXPO_UPDATES_ENABLED=false \
  npx expo config --type public
```

Build Android only until the Apple developer team and APNs/App Store
credentials listed in `mobile/STORE_RELEASE_CHECKLIST.md` exist:

```bash
npx eas-cli build --profile production --platform android
```

EAS must report app/runtime version `1.2.0` and a new remote `versionCode`.
Download the exact signed AAB, record its EAS build ID and SHA-256, then install
the corresponding signed test artifact on a normal device before submission.
An EAS build does not authorize `eas submit`.

## 4. Store release and closeout

Complete `mobile/STORE_RELEASE_CHECKLIST.md`, including Data safety/App Privacy,
account deletion, association files, permissions, deep links, and signing
fingerprints. Record:

- source commit and CI run;
- app version plus Android `versionCode` or iOS `buildNumber`;
- EAS build ID, signing identity, and artifact SHA-256;
- production deployment time and smoke-test result;
- store track, rollout percentage, and rollback owner.

Once the signed artifact is accepted for distribution, date the changelog entry
and create the release tag from the exact reviewed commit.
