# Benchmarks

Three layers, because a slow screen has three possible causes and they need
different instruments.

| Layer | Measures | Tool |
| --- | --- | --- |
| `backend/benches/hot_paths.rs` | CPU on the auth path — Argon2, JWT, TOTP | Criterion |
| `bench/api/mobile_session.js` | Per-screen latency **and payload size** | k6 |
| `bench/db/explain_hot_queries.sh` | Query plans, and whether an index is used | `EXPLAIN ANALYZE` |

```bash
docker compose -f docker-compose.test.yml up -d      # the disposable database
bench/run_benchmarks.sh                              # everything
bench/run_benchmarks.sh --skip-micro                 # only the server-side work
```

Results land in `bench/results/<timestamp>/` (git-ignored).

## What the runner does

It builds the backend **in release mode**, points it at the test database on
port 55433, and gives it its own port. Production is never involved. A fresh
account is registered per run and seeded from `db/seed_bench_data.sql` with a
heavy library — 320 tracked titles, ~4.8k episodes, ~3.8k watches over three
years.

That seeding is the part people skip, and skipping it invalidates everything.
On an empty database every list query returns nothing, the planner prefers a
sequential scan because the tables are tiny, and payloads come back at a few
hundred bytes. You measure a system that does not exist.

## Reading the results

**Payload size deserves as much attention as latency.** A 40 ms response
carrying 600 KB is a bad response on a phone: it costs the user money on a
metered connection and stalls on a weak link. The k6 summary reports
`payload_bytes` per endpoint and `screen_total_bytes` per screen. The cold-start
threshold is 256 KB, roughly a second of poor 3G for everything the home tab
needs before it can render.

**`discovery` is not a real measurement.** The benchmark backend runs with a
dummy TMDB key, so discovery answers with an empty list. Its ~100 bytes and its
latency describe an unreachable upstream, not the endpoint. The same caveat
applies to anything else that would fan out to TMDB on a miss. Every other
endpoint reads from the seeded local tables and is measured honestly.

**In the query plans, `SEQ SCAN` is the finding and the milliseconds are
context.** The script only flags sequential scans on `watch_history`,
`user_media` and `episodes` — the tables that grow without bound. A sequential
scan there is fast on seeded data and catastrophic later, which is exactly the
failure that does not show up as a slow benchmark today.

The seed deliberately inserts watch rows for *other* accounts too. Without them
the benchmark account owned a quarter of `watch_history`, and Postgres
correctly chose sequential scans — the opposite of its production behaviour,
where one user is a sliver of the table. That produced three false alarms
before the background rows were added. If you change the seed, check the
account's share stays well under 10%.

The `stats: wrapped (EXTRACT)` case is a deliberate control. It is the
non-sargable form that the Wrapped queries used to have; it stays in the suite
so the plan difference against `stats: wrapped range` remains visible rather
than becoming folklore.

**The Argon2 numbers are supposed to be large.** Password hashing is slow by
design. What matters is that `verify: correct` and `verify: wrong` stay equal —
a gap between them leaks whether a guess was close — and that the absolute cost
stays within budget, since it is per-request CPU and therefore sets the ceiling
on concurrent sign-ins.

## Comparing runs

Criterion stores its own history and prints regressions against the previous
run automatically — treat that verdict with suspicion on a shared VPS. Anything
else running on the box moves Argon2 by several percent, so a "performance has
regressed" line after a routine run is usually the neighbours, not the code.
Re-run on an idle machine before believing it. For the API and query layers, keep the `bench/results`
directory from a known-good run and diff against it; the numbers are only
meaningful relative to the same machine, since a loaded VPS moves every figure.

## Capacity

`bench/run_benchmarks.sh --capacity` answers a different question: not what one
screen costs, but how much load the service takes before it stops being usable.
It ramps arrival rate and reports the highest window that stayed inside the
budget (p95 < 500 ms, errors < 1%). `PEAK_RPS=N` raises the target.

Two details decide whether the number means anything:

**Each VU sends its own `X-Forwarded-For`.** The rate limiter keys on client IP
and trusts that header from a loopback peer, so without it every VU shares one
bucket and the run measures the limiter. With it, each VU is a separate client
through the real code path.

**Watch `dropped by k6` in the summary.** Once every VU is blocked on a slow
response, k6 cannot issue the requested rate and drops the rest. A large number
there means the offered load never reached the configured peak — so the
achieved rate is the server's ceiling, not evidence that it survived the peak.

What the ramp does *not* cover: sign-ins (Argon2 is ~38 ms of CPU each, a
different and much lower ceiling), writes, and anything that falls through to
TMDB, where the external API would bound throughput long before the server did.
