# CineTrack security audit

Data: 2026-06-20 (rundele 3-4; runde anterioare 2026-06-14 si 2026-06-13)

## Rezumat

Repo-ul era deja un MVP solid: SQL parametrizat prin `sqlx`, ownership checks pe resursele principale, Argon2 pentru parole, JWT-uri semnate, refresh token hash-uit in DB, validari de baza si teste unitare. Cele mai importante lacune erau in zona de sesiuni, dependency hygiene, hardening de deploy si contracte incomplete intre API si DB.

Am remediat problemele cu risc imediat: refresh token-ul nu mai este expus in JavaScript, rotatia detecteaza reuse, JWT-ul are algoritm explicit si durata mai scurta, TMDB are timeout, rate limiter-ul tine cont de reverse proxy, Nginx trimite headere de hardening, iar CI ruleaza lint/test/audit.

In runda a doua am inchis lacunele ramase pe partea de cont si operare: normalizare email, schimbare/resetare parola, gestionarea sesiunilor active, stergere de cont, CSP in Nginx, request-id plus metrics Prometheus si supply-chain scanning (Dependabot, CodeQL, gitleaks). Toate endpoint-urile noi au teste de integrare care ruleaza pe Postgres in CI.

In runda a treia am verificat repo-ul direct pe VPS/prod si am inchis trei riscuri concrete: vulnerabilitatea npm high din `form-data` (prin lockfile), logarea URL-ului de resetare parola cand SMTP lipseste in productie si hardening-ul runtime pentru containere/Nginx. Am verificat si faptul ca `.env.prod` este netracked si `chmod 600`, iar porturile publicate in Compose sunt bind-uite pe `127.0.0.1`.

## Schimbari aplicate

- Backend Rust curatat pentru `cargo clippy --all-targets -- -D warnings`.
- Dependinte reduse si `npm audit --omit=dev` adus la 0 vulnerabilitati.
- Refresh token rotation intarita cu `consumed_at`, `revoked_at`, lock tranzactional si invalidare pe reuse.
- Refresh token mutat in cookie `HttpOnly`, `SameSite=Lax`, `Secure` in productie, cu path limitat la `/api/auth`.
- Frontend-ul nu mai persista refresh token in `localStorage`.
- Validari API extinse pentru login, tracking, media type, rating, nume goale, profil si liste.
- Constrangeri DB adaugate pentru statusuri, media type, lungimi, valori pozitive si ordine de date.
- Profilurile private nu mai expun `bio` si `avatar_url` catre utilizatori neautorizati.
- Erorile DB comune sunt mapate la 400/409 fara detalii interne.
- TMDB client are timeout, connect timeout, user agent si `error_for_status`.
- Logarea erorilor TMDB evita URL-ul complet, ca sa nu scurga API key-ul.
- Rate limiter-ul foloseste `X-Forwarded-For` doar cand peer-ul este proxy privat/loopback.
- Nginx are HSTS, `nosniff`, `DENY` framing, Referrer Policy, Permissions Policy, body limit si proxy timeouts.
- CI GitHub Actions ruleaza Rust fmt/clippy/test, frontend lint/test/build, `npm audit --omit=dev` si `cargo audit`.

## Schimbari aplicate (2026-06-14)

- Email normalizat (trim + lowercase) la register si login, plus migratie care normalizeaza randurile existente, ca sa nu existe conturi duplicate dupa casing.
- Endpoint autentificat `PATCH /api/auth/password` pentru schimbarea parolei cu verificarea parolei curente; revoca toate refresh token-urile si curata cookie-ul sesiunii curente.
- Flux de resetare parola: `POST /api/auth/password/forgot` (raspuns uniform, fara user enumeration) si `POST /api/auth/password/reset`. Token-uri one-time hash-uite SHA-256, TTL 1h, consumate la folosire.
- Trimitere email prin SMTP configurabil din env (`SMTP_HOST/PORT/USERNAME/PASSWORD/FROM`, lettre cu rustls); cand SMTP nu e configurat, link-ul de reset e doar logat, deci fluxul nu cade in dev.
- Management de sesiuni: coloane `user_agent`, `ip_address`, `last_used_at` pe refresh tokens; `GET /api/auth/sessions` (cu flag `current`), `DELETE /api/auth/sessions/{id}` (scoped pe owner, 404 pe id strain) si `POST /api/auth/sessions/logout-all`.
- Stergere de cont: `DELETE /api/users/me` cu confirmare prin parola; cascade pe toate tabelele legate de user si curatarea cookie-ului.
- IP-ul real pentru sesiuni respecta acelasi trust model ca rate limiter-ul (`X-Forwarded-For` doar de la peer privat/loopback).
- Content-Security-Policy in Nginx, plus `Cross-Origin-Opener-Policy: same-origin`. CSP permite doar same-origin plus scriptul de analytics si imaginile TMDB efectiv folosite; scripturile raman stricte, `'unsafe-inline'` ramane doar pentru stiluri.
- Observability: middleware request-id (UUID per request, ignora valoarea trimisa de client, o pune in `X-Request-Id` si in access log) si endpoint `/metrics` Prometheus, servit pe portul aplicatiei si neexpus prin Nginx.
- Supply chain: `dependabot.yml` (cargo, npm, github-actions, docker), workflow CodeQL pentru JS/TS si workflow gitleaks pentru secret scanning pe intreg istoricul.
- Frontend conectat la noile endpoint-uri: pagini publice forgot/reset parola (cu link din login), pagina Settings cu schimbare parola, lista sesiunilor active (revocare per sesiune si sign out all) si danger zone pentru stergere cont cu confirmare prin parola.
- Logging de securitate si audit: `WARN` pe refresh token reuse (semnal de furt token, urmat de revocarea tuturor sesiunilor) si linii `INFO` de audit pe register, schimbare/resetare parola, revocare sesiune, sign out all si stergere cont. Se logheaza doar `user_id` (UUID), fara email/token/parola.

## Schimbari aplicate (2026-06-20)

- Frontend supply-chain: `npm audit --omit=dev` raporta vulnerabilitate high in `form-data` 4.0.0-4.0.5 via `axios`; lockfile-ul a fost actualizat astfel incat `form-data` sa rezolve la 4.0.6, iar auditul npm este acum curat.
- Reset password logging: in productie, daca SMTP nu este configurat, backend-ul nu mai logheaza `reset_url` (care contine token one-time). In dev ramane log-only pentru debugging.
- Observability: logurile aplicatiei folosesc task-local request id si sunt corelate cu `X-Request-Id`/access log, fara sa accepte valori spoofed de client.
- Runtime container hardening: `backend` si `frontend` in `docker-compose.prod.yml` ruleaza cu `read_only`, `tmpfs` pentru directoarele de write necesare, `no-new-privileges`, `cap_drop: ALL` si `pids_limit`; Postgres primeste `no-new-privileges` si `pids_limit`.
- Nginx hardening: `server_tokens off`, TLS limitat la 1.2/1.3, session cache/timeout explicit si `server_tokens off` si pentru Nginx-ul SPA intern.
- Validare operationala fara leak de secrete: pentru Compose se foloseste `docker compose config --no-env-resolution --no-interpolate --quiet`, nu `docker compose config` simplu, deoarece acesta poate expune valorile din `env_file`.

## Schimbari aplicate (2026-06-20, runda 4)

- Build hygiene / secret-in-layer: adaugate `.dockerignore` pentru `backend` si `frontend`. Ambele Dockerfile faceau `COPY . .` fara ignore, deci contextul includea `target/`, `node_modules/`, `dist/` si orice `.env` local; acum contextele sunt curate si un `.env` ratacit nu mai poate ajunge intr-un layer de imagine.
- Onboarding fara copy-paste din README: adaugat `.env.example` tracked, care documenteaza fiecare variabila citita de backend si de fisierele compose (cu placeholdere, nu valori reale).
- Cod mort eliminat: `GET /api/users/{username}/stats` si `/heatmap` erau stub-uri care ignorau username-ul si intorceau un mesaj hardcodat catre `/api/stats/me`; nefolosite de frontend si neacoperite de teste, deci scoase (statisticile raman self-only).
- TMDB credential scos din URL-uri: cand `TMDB_READ_ACCESS_TOKEN` (v4) este setat, clientul il trimite ca header `Authorization: Bearer` marcat sensitive si renunta la `api_key` din query string; fallback la `api_key` cand token-ul lipseste sau nu e header-safe, deci deploy-urile existente raman functionale. Pentru a-l activa in productie trebuie adaugat `TMDB_READ_ACCESS_TOKEN` in `.env.prod` si rebuild.
- Bug de UX in fluxul de login reparat (descoperit prin E2E): interceptorul axios trata orice 401 ca access token expirat si incerca refresh; la o parola gresita refresh-ul (fara sesiune) raspundea tot 401, ceea ce facea logout si redirect la `/login`, inghitind mesajul "Invalid email or password". Acum 401-urile de la endpoint-urile de auth (login/register/password) sunt respinse direct, ca formularul sa afiseze eroarea; refresh-ul ramane doar pentru token expirat pe alte requesturi.
- Teste E2E: suita Playwright (`frontend/e2e`) acopera route guards, store-ul de auth persistat, login success/fail, logout, interceptorul de refresh-on-401 pe sesiune moarta si confirmarea uniforma de forgot-password. Backend-ul e mock-uit la nivel de retea (fara DB/API), deci e determinista; ruleaza ca job separat in CI.
- Acuratete documentatie: numerele de teste din README au fost corectate (113 unit + 44 integrare + 51 frontend), CSP-ul descris corect ca domain-allowlist, si adaugat un fisier `LICENSE` MIT in locul notei vagi "personal/educational use".

## Riscuri reziduale

- Access token-urile raman stateless pana expira. Durata default este 1h; `logout-all` si schimbarea parolei revoca refresh token-urile, dar un access token deja emis ramane valabil pana la expirare. Revocarea instant ar cere token versioning sau denylist.
- Cookie-ul refresh foloseste `SameSite=Lax`. Este bun pentru deploy same-site, dar daca frontend si API ajung pe site-uri complet diferite va trebui `SameSite=None; Secure` plus protectie CSRF explicita.
- `current` pentru sesiuni se determina din cookie-ul de refresh; un client care apeleaza fara cookie (doar cu access token) vede toate sesiunile drept ne-curente, dar nu este o problema de securitate.
- `/metrics` nu are autentificare; protectia e ca nu este proxat de Nginx, deci depinde de izolarea retelei de deploy. Daca portul backend devine accesibil direct, endpoint-ul trebuie restrans.
- `cargo audit` raporteaza `RUSTSEC-2023-0071` prin metadate `sqlx-mysql` din lockfile, desi build-ul foloseste doar feature-ul `postgres`. CI il ignora explicit; de revazut cand `sqlx` rezolva lockfile-ul.
- `validator_derive` trage `proc-macro-error2`, marcat unmaintained in `cargo audit` ca warning (`RUSTSEC-2026-0173`). De urmarit upgrade-ul ecosistemului `validator`.
- E2E browser tests exista acum (Playwright) pentru login/logout/refresh-401/forgot-password, dar cu backend mock-uit; nu exista inca E2E pe stiva reala (cookie HttpOnly real, rotatie refresh, reset cu token, sesiuni active, stergere cont).
- Frontend-ul nu are React error boundary: un raspuns API malformat sau gol (ex: `trending` fara `results`) arunca in render si, fara boundary, demonteaza tot arborele (ecran alb, inclusiv navbar). De adaugat un error boundary la nivel de aplicatie.
- Secretele din `.env.prod` trebuie rotate daca au fost afisate in terminal, loguri sau transcript de audit. In special, evita `docker compose config` fara `--no-env-resolution` pe masini sau sesiuni care pot persista output-ul.

## Recomandari urmatoare

- Adauga CSRF token daca deployment-ul ajunge cross-site sau daca schimbi refresh cookie pe `SameSite=None`.
- Extinde E2E-ul Playwright catre stiva reala (backend + Postgres efemer in CI) pentru reset parola cu token, sesiuni active si stergere cont, pe langa fluxurile mock-uite existente.
- Adauga un error boundary in frontend ca un singur raspuns API malformat sa nu doboare tot SPA-ul.
- Extinde observability: propaga request-id-ul si in liniile de audit/eroare (acum apare doar in access log), si conecteaza alerte pe `security: refresh token reuse` plus dashboards peste metrics-ul Prometheus.
- Decide politicile de privacy pentru follower/following counts la profile private; momentan se ascund bio/avatar si activity, dar nu si counters.
- Ruleaza periodic raportul gitleaks/CodeQL si trateaza PR-urile Dependabot ca parte din intretinere.
- Roteaza JWT secret, parola DB si cheia TMDB dupa sesiuni de audit in care valorile au fost afisate accidental. Rotatia parolei DB trebuie facuta atomic: `ALTER USER`, update `.env.prod`, apoi recreate/restart backend.

## Verificari locale

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- Teste de integrare pe Postgres: `TEST_DATABASE_URL=postgres://test_user:test_pass@127.0.0.1:55433/cinetrack_test cargo test --test api_tests -- --ignored --test-threads=1`
- `cargo audit --ignore RUSTSEC-2023-0071`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `npm run test:e2e` (Playwright; porneste singur vite dev, backend mock-uit la nivel de retea)
- `npm audit --omit=dev`
- `docker compose -f docker-compose.prod.yml config --no-env-resolution --no-interpolate --quiet`
- `docker run --rm --add-host backend:127.0.0.1 --add-host frontend:127.0.0.1 -v "$PWD/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" -v /tmp/cinetrack-nginx-ssl:/etc/nginx/ssl:ro nginx:alpine nginx -t`
- Validare config Nginx: `nginx -t` (sau in container cu certificate dummy)
- Secret scan: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --redact`
