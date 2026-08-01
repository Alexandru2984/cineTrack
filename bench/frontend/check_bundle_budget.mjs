import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, join, resolve, sep } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist');
const assets = join(dist, 'assets');
const limits = {
  initialGzip: 180 * 1024,
  largestChunkGzip: 120 * 1024,
  totalAssetsGzip: 400 * 1024,
};

function fail(message) {
  console.error(`bundle budget: ${message}`);
  process.exitCode = 1;
}

function compressedSize(file) {
  return gzipSync(readFileSync(file), { level: 9 }).length;
}

function localFile(reference) {
  const relative = reference.replace(/^\//, '');
  const file = resolve(dist, relative);
  if (file !== dist && !file.startsWith(`${dist}${sep}`)) {
    throw new Error(`build output references a path outside dist: ${reference}`);
  }
  return file;
}

const indexPath = join(dist, 'index.html');
if (!existsSync(indexPath) || !existsSync(assets)) {
  console.error(`bundle budget: no Vite build found at ${dist}; run npm run build first`);
  process.exit(2);
}

const html = readFileSync(indexPath, 'utf8');
const initialReferences = [
  ...new Set(
    [...html.matchAll(/(?:src|href)=["']([^"'?#]+)["']/g)]
      .map((match) => match[1])
      .filter((reference) => reference.startsWith('/assets/') || reference === '/theme.js'),
  ),
];

let initialGzip = compressedSize(indexPath);
for (const reference of initialReferences) {
  const file = localFile(reference);
  if (!existsSync(file)) {
    throw new Error(`initial asset is missing: ${reference}`);
  }
  initialGzip += compressedSize(file);
}

const assetFiles = readdirSync(assets)
  .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
  .map((name) => ({ name, gzip: compressedSize(join(assets, name)) }));
const totalAssetsGzip = assetFiles.reduce((total, file) => total + file.gzip, 0);
const largestChunk = assetFiles
  .filter((file) => file.name.endsWith('.js'))
  .sort((left, right) => right.gzip - left.gzip)[0];

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
console.log(`Initial route (gzip): ${kib(initialGzip)} / ${kib(limits.initialGzip)}`);
console.log(
  `Largest JS chunk (gzip): ${largestChunk.name} ${kib(largestChunk.gzip)} / ${kib(limits.largestChunkGzip)}`,
);
console.log(`All JS/CSS (gzip): ${kib(totalAssetsGzip)} / ${kib(limits.totalAssetsGzip)}`);

if (initialGzip > limits.initialGzip) {
  fail(`initial route is ${kib(initialGzip)}, over ${kib(limits.initialGzip)}`);
}
if (largestChunk.gzip > limits.largestChunkGzip) {
  fail(`${basename(largestChunk.name)} is ${kib(largestChunk.gzip)}, over ${kib(limits.largestChunkGzip)}`);
}
if (totalAssetsGzip > limits.totalAssetsGzip) {
  fail(`all JS/CSS total ${kib(totalAssetsGzip)}, over ${kib(limits.totalAssetsGzip)}`);
}
