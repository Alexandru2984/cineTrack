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
4. Run the full local gate with `./scripts/run_tests.sh --full`. The faster
   `./scripts/run_tests.sh` gate is intended for normal development, but does
   not run browser E2E or rebuild and scan the production images.
5. Review the complete diff and commit it. Do not build or deploy from a dirty
   worktree.
6. Let the repository owner push the reviewed commit.

Every push to `main` runs GitHub CI. The repository still has no GitHub Actions
production-deploy workflow, so a green push alone cannot modify the VPS.

That is deliberate: it keeps a compromised build action away from production.
Deployment is now automatic but still *pull*-based — `scripts/auto_deploy.sh`
runs on the VPS from cron, asks GitHub whether a commit passed, and deploys it
itself. GitHub is never given a way in, and holds no secret for this: there is
no deploy key, no host, no SSH credential in the repository settings. See
section 2a.

The cost that remains is that forgetting is silent, so
`scripts/check_deploy_drift.sh` runs hourly and reports how many deployable
commits production is missing. `GIT_REVISION` below is what makes that check
possible — an image built without it cannot say which commit it came from, and
the check raises `CineTrackDeployRevisionUnknown` rather than assuming it is
current.

## 2. Deploy the web and API manually

Record the candidate commit and the currently deployed commit before starting.
Use the production environment file already present on the host; never print or
copy its values into release notes.

### One-time prerequisite: the metrics scrape credential

`METRICS_BEARER_TOKEN` is **required in production**. Compose refuses to
interpolate without it and `--check-config` refuses to load, so a deploy that
skips this fails before anything is replaced rather than quietly starting an
unauthenticated `/metrics`. Do this once, before the first deploy that includes
access-token revocation:

```bash
printf 'METRICS_BEARER_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env.prod
scripts/render_metrics_token.sh
scripts/check_secret_hygiene.sh
```

Then recreate Prometheus so it picks up the credential file; until both sides
agree, scrapes return 401 and `CineTrackBackendDown` will fire:

```bash
docker compose -f docker-compose.monitoring.yml --env-file .env.prod \
  up -d --force-recreate prometheus
curl --fail --silent --show-error \
  --header "Authorization: Bearer $(grep -oP '(?<=^METRICS_BEARER_TOKEN=).*' .env.prod)" \
  http://127.0.0.1:8090/metrics | head -1
```

The same `curl` without the header must answer `401`.

### Deploy

```bash
git rev-parse HEAD
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d db
./scripts/provision_db_role.sh .env.prod
GIT_REVISION="$(git rev-parse HEAD)" \
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

### Query visibility, once

`pg_stat_statements` records what every query costs in real traffic.
`docker-compose.prod.yml` preloads it, but creating the extension needs
superuser, so no migration can do it. Once, after the database has restarted
with the new configuration:

```bash
docker exec -i cinetrack-db-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
```

Then `scripts/slow_queries.sh` ranks statements by the share of database time
they consume. It answers a different question from `bench/db`, which measures
fourteen queries chosen by hand against seeded data: this one notices the query
nobody thought to benchmark. A hot path once reached thirteen seconds in
production while every check reported healthy, which is the gap it closes.

Note that preloading a library requires the database container to restart, so
the deploy above stops the database rather than reloading it.

### The nginx vhost is a separate artifact

`nginx/vazute.micutu.com.conf` is not in any image. Compose will not install it,
so a release that changes it is only half deployed until it is copied to the
host by hand — and the symptom is subtle: the site stays up and serves the new
bundle while the edge behaves as it did before.

That is not hypothetical. The release that introduced the event stream shipped
its `proxy_buffering off` in the repository and left the running vhost
unchanged, so the stream would have worked while delivering in batches.

```bash
# Nothing here is destructive until `cp`, and `nginx -t` runs before reload, so
# a bad config is refused rather than loaded.
sudo cp /etc/nginx/sites-available/vazute.micutu.com \
  "/etc/nginx/sites-available/vazute.micutu.com.bak.$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp nginx/vazute.micutu.com.conf /etc/nginx/sites-available/vazute.micutu.com
sudo nginx -t && sudo systemctl reload nginx
```

`scripts/check_deploy_drift.sh` reports this as the `nginx` artifact, so
forgetting it now surfaces hourly rather than at the next time somebody happens
to run the local gate.

The migration job must succeed before application containers are replaced.
After deployment, verify container health, the public health endpoint, and the
main authenticated flows:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
curl --fail --silent --show-error https://vazute.micutu.com/api/health
curl --fail --silent --show-error https://vazute.micutu.com/.well-known/security.txt

# Confirm every artifact actually moved. Both images carry the commit they were
# built from, and the check compares each against the paths that affect it —
# reading one image's label to speak for all three was wrong in both directions
# and produced an alert that could not be cleared.
scripts/check_deploy_drift.sh
```

A silent run means backend, frontend and nginx are all current. Anything it
prints names the artifact still to deploy.

Check login, token refresh, search, tracking, Up Next, settings, reporting, and
the moderator queue with dedicated non-production accounts. Keep the previous
source commit and database backup available until the smoke check finishes.
Application rollback must never reverse an already-applied database migration;
restore the previous application commit only when its schema compatibility is
known.

## 2a. Automatic deployment

`scripts/auto_deploy.sh` does section 2 without a person, for the commits where
that is safe. It runs from cron on the VPS:

```cron
*/10 * * * * /usr/bin/flock -n /tmp/cinetrack_auto_deploy.lock /home/micu/vazute/cineTrack/scripts/auto_deploy.sh >> /home/micu/backups/vazute/auto-deploy.log 2>&1
```

`flock -n` matters: a build outlasts the ten-minute interval, and two deploys
replacing the same containers at once is worse than a late one.

It authenticates to nothing. The repository is public, so the fetch and both
API calls are anonymous reads — deliberately not via `gh`, whose stored token
carries `admin:org`, `repo` and `workflow` scopes. An unattended deploy path
should not have a credential in it that can write, when what it needs is two
GETs. The cost is the anonymous rate limit, 60 requests an hour per address;
this spends two per run and refuses to deploy rather than guess when it cannot
get an answer.

### What it refuses

- **Anything CI has not passed.** Every check run and every commit status must
  have completed successfully. `skipped` and `neutral` count as passes; a job
  correctly deciding it had nothing to do is not a failure.
- **Anything CI has not checked at all.** Zero check runs means "not tested
  yet", never "nothing to object to". This is the difference between shipping a
  bad commit and shipping an unexamined one.
- **Revisions that change the nginx vhost.** It is not in any image, installing
  it needs root, and the reload is shared with every other site on this host.
  Deploy those by hand, per section 2.

Check what it would do without doing it:

```bash
scripts/auto_deploy.sh --dry-run
```

### What it can undo, and what it cannot

Before building, it tags the running images `:rollback`. If the new revision
fails its health check it puts them back.

The health check that decides this is the two containers on their own published
ports (`127.0.0.1:8090`, `127.0.0.1:8091`), not the public URL. Those are
different questions: the public name additionally crosses nginx and Cloudflare,
which are in no image. A Cloudflare incident must not revert a good release, so
that case reports `edge_unhealthy` and changes nothing.

That only works when the revision applied no migrations. Migrations run forward
only, and `ensure_migrations_current` refuses to start a binary against a
database holding a migration it does not know — so restoring the old image
after a migration would replace a broken application with one that will not
boot at all.

So when a failed deploy included a migration, it stops and alerts instead:
`CineTrackAutoDeployStuck`, severity critical. Production is left running the
broken revision, because broken and reachable can be fixed by a person and
broken and refusing to start cannot. **That alert means go and look.**

A rollback that does not restore health reports `stuck` as well, for the same
reason — the images were never the problem, and closing the alert would close
it on an outage still in progress.

### What it reports

Textfile metrics next to `deploy_drift.prom`, one gauge per state:

| state | meaning |
| --- | --- |
| `idle` | production already runs `main` |
| `deployed` | a revision shipped and is healthy |
| `waiting_ci` | CI has not finished, or has not started |
| `blocked_ci` | a check or status failed |
| `blocked_nginx` | the revision needs a manual vhost install |
| `rolled_back` | shipped, failed, previous images restored |
| `edge_unhealthy` | containers fine, public URL not — nginx or Cloudflare |
| `blocked_api` | GitHub could not be asked; rate limit or network |
| `stuck` | failed and could not be undone — needs a person |

`CineTrackAutoDeployNotRunning` fires if no run reports for an hour, so the
mechanism disappearing is itself visible rather than looking like calm.

### Turning it off

Comment out the cron line. Nothing else holds state, and section 2 keeps
working by hand exactly as before.

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
