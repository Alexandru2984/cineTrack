'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const nodeModules = path.resolve(__dirname, '..', 'node_modules');
const checkOnly = process.argv.includes('--check');
const marker = 'Vazute compatibility backport for brace-expansion DoS advisories';

const compatibilityModule = `'use strict';

// ${marker}
//
// brace-expansion 1.x has no patched release. Its legacy CommonJS consumers
// expect the package itself to be callable, while the fixed 5.x API exports an
// \`expand\` function. Delegate to an audited 5.0.9+ implementation installed
// at the project root and preserve the old calling convention.
const fs = require('node:fs');
const path = require('node:path');

function resolveSafeExpand() {
  let cursor = path.resolve(__dirname, '..');
  const ownDirectory = path.resolve(__dirname);

  while (true) {
    const candidate = path.join(cursor, 'node_modules', 'brace-expansion');
    if (path.resolve(candidate) !== ownDirectory) {
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'),
        );
        const implementation = require(candidate);
        const version = /^(\\d+)\\.(\\d+)\\.(\\d+)/.exec(manifest.version);
        const isPatched =
          version &&
          (Number(version[1]) > 5 ||
            (Number(version[1]) === 5 &&
              (Number(version[2]) > 0 ||
                (Number(version[2]) === 0 && Number(version[3]) >= 9))));
        if (isPatched && typeof implementation.expand === 'function') {
          return implementation.expand;
        }
      } catch {
        // Keep walking to the project-level node_modules directory.
      }
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  throw new Error('Patched brace-expansion 5.0.9+ implementation is missing');
}

const safeExpand = resolveSafeExpand();

module.exports = function expandCompat(pattern, options) {
  const configured = options || {};
  const max = Number.isFinite(configured.max)
    ? Math.min(Math.max(configured.max, 0), 100_000)
    : 100_000;
  const maxLength = Number.isFinite(configured.maxLength)
    ? Math.min(Math.max(configured.maxLength, 0), 4_000_000)
    : 4_000_000;

  return safeExpand(pattern, { max, maxLength });
};
`;

function findLegacyPackages(directory, matches = []) {
  if (!fs.existsSync(directory)) return matches;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);

    if (entry.name === 'brace-expansion') {
      const manifestPath = path.join(entryPath, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (/^1\./.test(manifest.version)) matches.push(entryPath);
      continue;
    }

    findLegacyPackages(entryPath, matches);
  }

  return matches;
}

const legacyPackages = findLegacyPackages(nodeModules);

const unpatched = [];
for (const packageDirectory of legacyPackages) {
  const entryPath = path.join(packageDirectory, 'index.js');
  const current = fs.readFileSync(entryPath, 'utf8');
  if (current.includes(marker)) continue;

  if (checkOnly) {
    unpatched.push(entryPath);
  } else {
    fs.writeFileSync(entryPath, compatibilityModule);
  }
}

assert.equal(
  unpatched.length,
  0,
  `Unpatched brace-expansion copies:\n${unpatched.join('\n')}`,
);

for (const packageDirectory of legacyPackages) {
  const expand = require(path.join(packageDirectory, 'index.js'));
  assert.deepEqual(expand('release-{android,ios}'), [
    'release-android',
    'release-ios',
  ]);

  const bounded = expand('{a,b}'.repeat(80), {
    max: 100_000,
    maxLength: 10_000,
  });
  const totalLength = bounded.reduce((total, value) => total + value.length, 0);
  assert(totalLength <= 10_000, 'Expansion output exceeded the configured bound');
}

console.log(
  `${checkOnly ? 'Verified' : 'Patched'} ${legacyPackages.length} legacy brace-expansion package(s).`,
);
