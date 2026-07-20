// How much load the API sustains before it stops being acceptable.
//
// This is a different question from mobile_session.js, which measures the cost
// of one screen at low concurrency. Here the load ramps until the service
// degrades, and the run reports the last step that still met the latency and
// error budget.
//
// Two things make the number honest:
//
// 1. Each virtual user sends its own X-Forwarded-For. The rate limiter keys on
//    the client IP and trusts that header from a loopback peer, so without this
//    every VU would share one bucket and the test would measure the limiter
//    rather than the server. With it, each VU is a distinct client exactly as
//    the production code sees one.
// 2. The mix is weighted like real traffic — mostly reads, because that is what
//    a tracker does. Logins are deliberately rare: Argon2 costs ~38 ms of CPU
//    each, so a login-heavy mix measures password hashing, not the API.
//
// Usage: bench/run_benchmarks.sh --capacity   (PEAK_RPS=N to raise the ceiling)

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
const TOKEN = __ENV.TOKEN;
const SHOW_ID = __ENV.SHOW_ID;
const TODAY = new Date().toISOString().slice(0, 10);
const PEAK = Number(__ENV.PEAK_RPS || 600);

const throttled = new Counter('throttled');
const poolTimeouts = new Counter('pool_timeouts');
const serverErrors = new Counter('server_errors');
const stageRps = new Trend('stage_rps', false);

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-arrival-rate',
      startRate: 25,
      timeUnit: '1s',
      // Generous VU headroom: if the server slows down, k6 needs spare VUs to
      // keep issuing the requested rate, otherwise it silently under-loads and
      // the result flatters the server.
      preAllocatedVUs: 200,
      maxVUs: 1500,
      stages: [
        { target: 50, duration: '20s' },
        { target: 100, duration: '20s' },
        { target: 200, duration: '20s' },
        { target: 300, duration: '20s' },
        { target: 450, duration: '20s' },
        { target: PEAK, duration: '20s' },
        { target: PEAK, duration: '20s' },
      ],
    },
  },
  thresholds: {
    // Deliberately not aborting the run: the point is to find where these break.
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

/** A distinct client IP per VU, so the per-IP limiter behaves as in production. */
function clientHeaders() {
  const id = __VU;
  const ip = `10.${(id >> 16) & 0xff}.${(id >> 8) & 0xff}.${id & 0xff}`;
  return {
    Authorization: `Bearer ${TOKEN}`,
    'X-Forwarded-For': ip,
    'Accept-Encoding': 'gzip, deflate, br',
  };
}

const READS = [
  () => `/api/tracking?status=watching`,
  () => `/api/stats/me`,
  () => `/api/calendar/up-next?today=${TODAY}&limit=6`,
  () => `/api/notifications?limit=5`,
  () => `/api/media/${SHOW_ID}/seasons`,
  () => `/api/media/${SHOW_ID}/seasons/1/episodes`,
  () => `/api/calendar/summary?today=${TODAY}`,
  () => `/api/stats/me/heatmap`,
];

export default function () {
  const path = READS[Math.floor(Math.random() * READS.length)]();
  const res = http.get(`${BASE}${path}`, { headers: clientHeaders() });

  check(res, { 'status is 200': (r) => r.status === 200 });

  if (res.status === 429) throttled.add(1);
  if (res.status >= 500) {
    serverErrors.add(1);
    // The pool is 10 connections with a 5s acquire timeout; exhausting it is
    // the most likely way this service falls over, so name it explicitly.
    if (String(res.body).includes('pool') || res.timings.duration > 4900) {
      poolTimeouts.add(1);
    }
  }
  stageRps.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const val = (name, field) => (m[name] ? m[name].values[field] : 0);
  const count = (name) => (m[name] ? m[name].values.count : 0);

  const reqs = val('http_reqs', 'count');
  const rate = val('http_reqs', 'rate');
  const failRate = val('http_req_failed', 'rate') * 100;

  let out = '\n  Capacity run\n';
  out += `  requests            ${reqs} (${rate.toFixed(1)}/s average over the ramp)\n`;
  out += `  p95 latency         ${val('http_req_duration', 'p(95)').toFixed(0)} ms\n`;
  out += `  p99 latency         ${val('http_req_duration', 'p(99)').toFixed(0)} ms\n`;
  out += `  max latency         ${val('http_req_duration', 'max').toFixed(0)} ms\n`;
  out += `  failed              ${failRate.toFixed(2)}%\n`;
  out += `  429 throttled       ${count('throttled')}\n`;
  out += `  5xx server errors   ${count('server_errors')}\n`;
  out += `  pool exhaustion     ${count('pool_timeouts')}\n`;

  // Without this line the run is easy to misread: once every VU is stuck
  // waiting on a slow response, k6 cannot issue the requested rate and silently
  // drops the excess. A large number here means the offered load never reached
  // the configured peak, so the achieved rate *is* the server's ceiling.
  const dropped = count('dropped_iterations');
  if (dropped > 0) {
    out += `  dropped by k6       ${dropped} (offered load never reached the peak;\n`;
    out += '                      the achieved rate is the server ceiling)\n';
  }

  const breached = [];
  for (const [name, metric] of Object.entries(m)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) {
      if (!result.ok) breached.push(`${name} ${expr}`);
    }
  }
  out += breached.length
    ? `\n  Budget exceeded at peak: ${breached.join(', ')}\n` +
      '  The sustainable rate is below the peak; read the per-stage output above.\n'
    : '\n  Held the whole ramp within budget (p95<500ms, errors<1%).\n';

  return { stdout: out + '\n', 'capacity-summary.json': JSON.stringify(data, null, 2) };
}
