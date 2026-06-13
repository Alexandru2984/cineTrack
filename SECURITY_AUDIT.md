# CineTrack security audit

Data: 2026-06-13

## Rezumat

Repo-ul era deja un MVP solid: SQL parametrizat prin `sqlx`, ownership checks pe resursele principale, Argon2 pentru parole, JWT-uri semnate, refresh token hash-uit in DB, validari de baza si teste unitare. Cele mai importante lacune erau in zona de sesiuni, dependency hygiene, hardening de deploy si contracte incomplete intre API si DB.

Am remediat problemele cu risc imediat: refresh token-ul nu mai este expus in JavaScript, rotatia detecteaza reuse, JWT-ul are algoritm explicit si durata mai scurta, TMDB are timeout, rate limiter-ul tine cont de reverse proxy, Nginx trimite headere de hardening, iar CI ruleaza lint/test/audit.

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

## Riscuri reziduale

- Access token-urile raman stateless pana expira. Durata default este 1h, dar revocarea imediata ar cere token versioning, denylist sau sesiuni server-side.
- Cookie-ul refresh foloseste `SameSite=Lax`. Este bun pentru deploy same-site, dar daca frontend si API sunt pe site-uri complet diferite va trebui `SameSite=None; Secure` plus protectie CSRF explicita.
- Testele de integrare cu Postgres exista, dar sunt marcate `ignored`; CI-ul actual nu porneste inca serviciul Postgres ca sa le ruleze.
- CSP nu este activat in Nginx. Merita adaugat dupa inventarierea exacta a surselor pentru API, imagini TMDB, fonturi si eventuale scripturi third-party.
- `cargo audit` raporteaza `RUSTSEC-2023-0071` prin metadate `sqlx-mysql` din lockfile, desi build-ul foloseste doar feature-ul `postgres`. CI il ignora explicit; trebuie revazut cand `sqlx` rezolva lockfile-ul.
- `validator_derive` trage `proc-macro-error2`, marcat unmaintained in `cargo audit` ca warning permis. De urmarit upgrade-ul ecosistemului `validator`.
- Nu exista inca E2E browser tests pentru fluxuri auth reale cu cookie, refresh si logout.
- Nu exista inca secret scanning/CodeQL/Dependabot configurat in repo.

## Recomandari urmatoare

- Adauga job CI cu Postgres service si ruleaza testele ignorate prin `cargo test --test api_tests -- --ignored`.
- Adauga CSRF token daca deployment-ul ajunge cross-site sau daca schimbi refresh cookie pe `SameSite=None`.
- Adauga CSP dupa un pass de asset inventory; incepe cu `default-src 'self'`, `img-src 'self' data: https://image.tmdb.org`, `object-src 'none'`, `base-uri 'self'`.
- Adauga sesiuni vizibile in UI: lista de device-uri, logout all, revocare per device.
- Adauga Dependabot pentru Cargo/npm/GitHub Actions si secret scanning in platforma GitHub.
- Adauga teste E2E cu Playwright pentru login, refresh dupa 401, logout si pagini protejate.
- Adauga observability minima: request id, structured logs, rate-limit metrics si alerte pe refresh token reuse.
- Decide politicile de privacy pentru follower/following counts la profile private; momentan se ascund bio/avatar si activity, dar nu si counters.

## Verificari locale

- `cargo fmt --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo test`
- `cargo audit --ignore RUSTSEC-2023-0071`
- `npm run lint`
- `npm test -- --run`
- `npm run build`
- `npm audit --omit=dev`

