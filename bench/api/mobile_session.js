// Models what the Văzute mobile client actually does, screen by screen.
//
// Latency alone is the wrong lens for a phone: a 40 ms response that ships
// 600 KB still costs the user money on cellular and stalls on a weak link. So
// every request records its decompressed body size alongside its duration, and
// the summary reports bytes per screen. Thresholds are set from what a mobile
// screen can afford, not from what the server finds easy.
//
// Run through bench/run_benchmarks.sh, which seeds data and supplies the token.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL;
const TOKEN = __ENV.TOKEN;
const SHOW_ID = __ENV.SHOW_ID;
const TODAY = new Date().toISOString().slice(0, 10);
const YEAR = new Date().getFullYear();

// Per-endpoint payload size, in bytes, tagged by the screen that pays for it.
const payload = new Trend('payload_bytes', false);
const screenBytes = new Trend('screen_total_bytes', false);
const errors = new Counter('request_errors');
const throttled = new Counter('throttled');

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  // The client accepts compression; measuring without it would flatter nobody.
  'Accept-Encoding': 'gzip, deflate, br',
};

// The server's rate limiter is capped at 100 req/s and keys on the client IP,
// so every virtual user here shares one bucket. Past that ceiling this would
// measure the limiter rather than the API. Scenarios run one at a time at low
// concurrency: the goal is the per-screen cost a phone pays, not peak
// throughput, and `throttled` below makes any 429 impossible to overlook.
// k6's `rate` counts iterations, and each iteration issues several requests,
// so the rates below are chosen per scenario to land near 45 req/s.

// Every endpoint measured, so the per-endpoint submetrics can be materialised.
// k6 only keeps a tagged submetric when a threshold references it, so these
// no-op thresholds exist purely to make the per-endpoint table below possible.
const ENDPOINTS = [
  'discovery', 'stats_me', 'up_next', 'notifications', 'calendar_summary',
  'tracking_watching', 'tracking_completed', 'tracking_plan',
  'media_detail', 'seasons', 'episodes',
  'stats_genres', 'stats_monthly', 'stats_heatmap', 'stats_wrapped',
  'auth_me',
];

const perEndpoint = {};
for (const name of ENDPOINTS) {
  perEndpoint[`payload_bytes{endpoint:${name}}`] = ['max>=0'];
  perEndpoint[`http_req_duration{endpoint:${name}}`] = ['max>=0'];
}
for (const screen of ['library', 'browse', 'stats', 'session']) {
  perEndpoint[`screen_total_bytes{screen:${screen}}`] = ['max>=0'];
}

export const options = {
  scenarios: {
    cold_start: {
      executor: 'constant-arrival-rate',
      rate: 8, timeUnit: '1s', duration: '15s', // 5 requests each -> ~40 req/s
      preAllocatedVUs: 10, maxVUs: 20, exec: 'coldStart',
    },
    library: {
      executor: 'constant-arrival-rate',
      rate: 15, timeUnit: '1s', duration: '15s', startTime: '17s', // 3 -> ~45
      preAllocatedVUs: 10, maxVUs: 20, exec: 'library',
    },
    browse: {
      executor: 'constant-arrival-rate',
      rate: 15, timeUnit: '1s', duration: '15s', startTime: '34s', // 3 -> ~45
      preAllocatedVUs: 10, maxVUs: 20, exec: 'browseShow',
    },
    statistics: {
      executor: 'constant-arrival-rate',
      rate: 11, timeUnit: '1s', duration: '15s', startTime: '51s', // 4 -> ~44
      preAllocatedVUs: 10, maxVUs: 20, exec: 'statistics',
    },
    // The /auth scope is limited to 3 req/s by design, far below the global
    // limiter. Measured separately at 2 req/s so the figure is the endpoint's
    // own cost rather than the limiter's.
    session: {
      executor: 'constant-arrival-rate',
      rate: 2, timeUnit: '1s', duration: '10s', startTime: '68s',
      preAllocatedVUs: 4, maxVUs: 8, exec: 'session',
    },
  },
  thresholds: {
    // A cold start is the one moment the user is staring at a spinner.
    'http_req_duration{screen:cold_start}': ['p(95)<800'],
    'http_req_duration{screen:library}': ['p(95)<600'],
    'http_req_duration{screen:browse}': ['p(95)<600'],
    'http_req_duration{screen:stats}': ['p(95)<1500'],
    'http_req_duration{screen:session}': ['p(95)<400'],
    // Roughly one second of a poor 3G link (~250 KB) for a whole screen.
    'screen_total_bytes{screen:cold_start}': ['p(95)<262144'],
    http_req_failed: ['rate<0.01'],
    request_errors: ['count<1'],
    // A single 429 invalidates the latency figures, so fail rather than report.
    throttled: ['count<1'],
    ...perEndpoint,
  },
};

function get(path, screen, name) {
  const res = http.get(`${BASE}${path}`, {
    headers,
    tags: { screen, endpoint: name },
  });
  const ok = check(res, { [`${name} is 200`]: (r) => r.status === 200 });
  if (res.status === 429) {
    // Measuring the rate limiter instead of the endpoint; the run is void.
    throttled.add(1, { endpoint: name });
  }
  if (!ok) {
    errors.add(1, { endpoint: name });
    console.error(`${name} -> ${res.status} ${String(res.body).slice(0, 200)}`);
  }
  // body.length is the decoded size: what the client parses and caches.
  const bytes = res.body ? res.body.length : 0;
  payload.add(bytes, { screen, endpoint: name });
  return bytes;
}

/** Home tab on launch: the burst every user pays for before seeing anything. */
export function coldStart() {
  let total = 0;
  // /auth/me is part of the real launch burst but lives behind the much
  // stricter auth limiter, so it is measured in its own scenario below rather
  // than inflating this one with 429s. Add its bytes when budgeting a launch.
  total += get('/api/media/discovery?language=en-US', 'cold_start', 'discovery');
  total += get('/api/stats/me', 'cold_start', 'stats_me');
  total += get(`/api/calendar/up-next?today=${TODAY}&limit=6`, 'cold_start', 'up_next');
  total += get('/api/notifications?limit=5', 'cold_start', 'notifications');
  total += get(`/api/calendar/summary?today=${TODAY}`, 'cold_start', 'calendar_summary');
  screenBytes.add(total, { screen: 'cold_start' });
}

/** Library tab: the list a heavy user scrolls, plus its pagination. */
export function library() {
  let total = 0;
  total += get('/api/tracking?status=watching', 'library', 'tracking_watching');
  total += get('/api/tracking?status=completed', 'library', 'tracking_completed');
  total += get('/api/tracking?status=plan_to_watch', 'library', 'tracking_plan');
  screenBytes.add(total, { screen: 'library' });
}

/** Opening a show and drilling into a season — the deepest read path. */
export function browseShow() {
  let total = 0;
  total += get(`/api/media/${SHOW_ID}?type=tv&language=en-US`, 'browse', 'media_detail');
  total += get(`/api/media/${SHOW_ID}/seasons`, 'browse', 'seasons');
  total += get(`/api/media/${SHOW_ID}/seasons/1/episodes`, 'browse', 'episodes');
  screenBytes.add(total, { screen: 'browse' });
}

/** Profile/stats tab, including the yearly recap aggregate. */
export function statistics() {
  let total = 0;
  total += get('/api/stats/me/genres', 'stats', 'stats_genres');
  total += get('/api/stats/me/monthly', 'stats', 'stats_monthly');
  total += get('/api/stats/me/heatmap', 'stats', 'stats_heatmap');
  total += get(`/api/stats/me/wrapped?year=${YEAR}`, 'stats', 'stats_wrapped');
  screenBytes.add(total, { screen: 'stats' });
}

/** Current user, behind the strict auth limiter — see the scenario comment. */
export function session() {
  const bytes = get('/api/auth/me', 'session', 'auth_me');
  screenBytes.add(bytes, { screen: 'session' });
}

/**
 * A per-endpoint table, sorted by payload size. Bytes come first deliberately:
 * on a phone the response that costs the user most is rarely the slowest one.
 */
export function handleSummary(data) {
  const rows = ENDPOINTS.map((name) => {
    const bytes = data.metrics[`payload_bytes{endpoint:${name}}`];
    const dur = data.metrics[`http_req_duration{endpoint:${name}}`];
    return {
      name,
      bytes: bytes ? bytes.values.avg : 0,
      p95: dur ? dur.values['p(95)'] : 0,
    };
  }).sort((a, b) => b.bytes - a.bytes);

  const kib = (n) => (n / 1024).toFixed(1).padStart(8);
  let out = '\n  Per-endpoint cost (sorted by payload)\n';
  out += '  ' + 'endpoint'.padEnd(20) + 'KiB'.padStart(8) + '  ' + 'p95 ms'.padStart(9) + '\n';
  out += '  ' + '-'.repeat(39) + '\n';
  for (const r of rows) {
    out += '  ' + r.name.padEnd(20) + kib(r.bytes) + '  ' + r.p95.toFixed(2).padStart(9) + '\n';
  }

  const screens = ['cold_start', 'library', 'browse', 'stats', 'session'];
  out += '\n  Total bytes per screen\n';
  for (const screen of screens) {
    const m = data.metrics[`screen_total_bytes{screen:${screen}}`];
    if (m) out += '  ' + screen.padEnd(20) + kib(m.values.avg) + ' KiB\n';
  }

  // Replacing the default summary means the pass/fail signal has to be rebuilt
  // here, or a run could look fine while a threshold was breached.
  const failures = [];
  for (const [name, metric] of Object.entries(data.metrics)) {
    for (const [expr, result] of Object.entries(metric.thresholds || {})) {
      if (!result.ok) failures.push(`${name} ${expr}`);
    }
  }

  const checks = data.metrics.checks;
  const passRate = checks ? (checks.values.rate * 100).toFixed(2) : 'n/a';
  const failed = data.metrics.http_req_failed;
  const errCount = data.metrics.request_errors ? data.metrics.request_errors.values.count : 0;
  const throttleCount = data.metrics.throttled ? data.metrics.throttled.values.count : 0;

  out += '\n  Run status\n';
  out += `  checks passed       ${passRate}%\n`;
  out += `  failed requests     ${failed ? (failed.values.rate * 100).toFixed(2) : '0'}%\n`;
  out += `  request errors      ${errCount}\n`;
  out += `  throttled (429)     ${throttleCount}\n`;
  out += failures.length
    ? `\n  THRESHOLDS BREACHED (${failures.length}):\n` +
      failures.map((f) => `    ✗ ${f}`).join('\n') + '\n'
    : '\n  all thresholds passed\n';

  return {
    stdout: out + '\n',
    'bench-summary.json': JSON.stringify(data, null, 2),
  };
}
