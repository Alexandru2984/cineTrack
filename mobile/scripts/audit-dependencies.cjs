'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const allowedAdvisory = 'https://github.com/advisories/GHSA-mh99-v99m-4gvg';

const patchCheck = spawnSync(
  process.execPath,
  [path.join(__dirname, 'patch-brace-expansion.cjs'), '--check'],
  { encoding: 'utf8' },
);
process.stdout.write(patchCheck.stdout);
process.stderr.write(patchCheck.stderr);
assert.equal(patchCheck.status, 0, 'The brace-expansion compatibility patch is missing');

const audit = spawnSync('npm', ['audit', '--audit-level=high', '--json'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  process.stderr.write(audit.stderr);
  throw new Error('npm audit did not return valid JSON');
}

if (report.error) {
  process.stderr.write(`${JSON.stringify(report.error, null, 2)}\n`);
  process.exit(audit.status || 1);
}

const vulnerabilities = report.vulnerabilities || {};

function inspectPatchedAdvisoryChain(name, visiting = new Set()) {
  if (visiting.has(name)) return { allowed: true, foundAdvisory: false };
  const vulnerability = vulnerabilities[name];
  if (!vulnerability || !Array.isArray(vulnerability.via) || vulnerability.via.length === 0) {
    return { allowed: false, foundAdvisory: false };
  }

  const next = new Set(visiting);
  next.add(name);
  const causes = vulnerability.via.map((cause) => {
    if (typeof cause === 'string') return inspectPatchedAdvisoryChain(cause, next);
    const allowed = Boolean(cause && cause.url === allowedAdvisory);
    return { allowed, foundAdvisory: allowed };
  });

  return {
    allowed: causes.every((cause) => cause.allowed),
    foundAdvisory: causes.some((cause) => cause.foundAdvisory),
  };
}

const blocked = Object.keys(vulnerabilities).filter((name) => {
  const result = inspectPatchedAdvisoryChain(name);
  return !result.allowed || !result.foundAdvisory;
});

if (blocked.length > 0) {
  process.stderr.write(`Unmitigated dependency vulnerabilities: ${blocked.join(', ')}\n`);
  process.exit(audit.status || 1);
}

if (Object.keys(vulnerabilities).length === 0) {
  console.log('No HIGH or CRITICAL dependency vulnerabilities found.');
} else {
  console.log(
    `Accepted only ${allowedAdvisory}; affected legacy consumers are redirected to patched brace-expansion 5.0.8.`,
  );
}
