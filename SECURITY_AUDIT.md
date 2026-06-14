# CineTrack security audit

Data: 2026-06-14 (runda 2; prima trecere 2026-06-13)

## Rezumat

Repo-ul era deja un MVP solid: SQL parametrizat prin `sqlx`, ownership checks pe resursele principale, Argon2 pentru parole, JWT-uri semnate, refresh token hash-uit in DB, validari de baza si teste unitare. Cele mai importante lacune erau in zona de sesiuni, dependency hygiene, hardening de deploy si contracte incomplete intre API si DB.

Am remediat problemele cu risc imediat: refresh token-ul nu mai este expus in JavaScript, rotatia detecteaza reuse, JWT-ul are algoritm explicit si durata mai scurta, TMDB are timeout, rate limiter-ul tine cont de reverse proxy, Nginx trimite headere de hardening, iar CI ruleaza lint/test/audit.

In runda a doua am inchis lacunele ramase pe partea de cont si operare: normalizare email, schimbare/resetare parola, gestionarea sesiunilor active, stergere de cont, CSP in Nginx, request-id plus metrics Prometheus si supply-chain scanning (Dependabot, CodeQL, gitleaks). Toate endpoint-urile noi au teste de integrare care ruleaza pe Postgres in CI.

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

## Riscuri reziduale

- Access token-urile raman stateless pana expira. Durata default este 1h; `logout-all` si schimbarea parolei revoca refresh token-urile, dar un access token deja emis ramane valabil pana la expirare. Revocarea instant ar cere token versioning sau denylist.
- Cookie-ul refresh foloseste `SameSite=Lax`. Este bun pentru deploy same-site, dar daca frontend si API ajung pe site-uri complet diferite va trebui `SameSite=None; Secure` plus protectie CSRF explicita.
- `current` pentru sesiuni se determina din cookie-ul de refresh; un client care apeleaza fara cookie (doar cu access token) vede toate sesiunile drept ne-curente, dar nu este o problema de securitate.
- `/metrics` nu are autentificare; protectia e ca nu este proxat de Nginx, deci depinde de izolarea retelei de deploy. Daca portul backend devine accesibil direct, endpoint-ul trebuie restrans.
- `cargo audit` raporteaza `RUSTSEC-2023-0071` prin metadate `sqlx-mysql` din lockfile, desi build-ul foloseste doar feature-ul `postgres`. CI il ignora explicit; de revazut cand `sqlx` rezolva lockfile-ul.
- `validator_derive` trage `proc-macro-error2`, marcat unmaintained in `cargo audit` ca warning permis. De urmarit upgrade-ul ecosistemului `validator`.
- Nu exista inca E2E browser tests pentru fluxuri auth reale cu cookie, refresh si logout.

## Recomandari urmatoare

- Adauga CSRF token daca deployment-ul ajunge cross-site sau daca schimbi refresh cookie pe `SameSite=None`.
- Adauga teste E2E cu Playwright pentru login, refresh dupa 401, logout, reset parola, sesiuni active si stergere cont.
- Extinde observability: propaga request-id-ul si in liniile de audit/eroare (acum apare doar in access log), si conecteaza alerte pe `security: refresh token reuse` plus dashboards peste metrics-ul Prometheus.
- Decide politicile de privacy pentru follower/following counts la profile private; momentan se ascund bio/avatar si activity, dar nu si counters.
- Ruleaza periodic raportul gitleaks/CodeQL si trateaza PR-urile Dependabot ca parte din intretinere.

## Verificari locale

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- Teste de integrare pe Postgres: `TEST_DATABASE_URL=postgres://test_user:test_pass@127.0.0.1:5433/cinetrack_test cargo test --test api_tests -- --ignored --test-threads=1`
- `cargo audit --ignore RUSTSEC-2023-0071`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `npm audit --omit=dev`
- Validare config Nginx: `nginx -t` (sau in container cu certificate dummy)
- Secret scan: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --redact`

