// The app's tsconfig has no Node types, so the two modules are typed here to
// what this test uses rather than pulling @types/node into the app.
type Entry = { name: string; isDirectory(): boolean };
const fs = jest.requireActual('fs') as {
  readdirSync(dir: string, options: { withFileTypes: true }): Entry[];
  readFileSync(file: string, encoding: 'utf8'): string;
};
const path = jest.requireActual('path') as {
  join(...parts: string[]): string;
  relative(from: string, to: string): string;
};
declare const __dirname: string;

// `/` names two routes, `app/index.tsx` and `app/(tabs)/index.tsx`, and from
// inside the tabs Expo Router picks the tab. A signed-out guard there that
// redirected to `/` redirected into itself and froze the app on sign-out. The
// guards now go through `SignedOutRedirect`, which names its destinations; this
// keeps a new screen from bringing the bare root redirect back.
const APP_DIR = path.join(__dirname, '..', '..', 'app');

function screenFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return screenFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('signed-out routing', () => {
  it('finds the screens it is meant to check', () => {
    expect(screenFiles(APP_DIR).length).toBeGreaterThan(20);
  });

  it('never redirects to the ambiguous root route', () => {
    const offenders = screenFiles(APP_DIR).filter((file) =>
      /<Redirect\s+href=\{?\s*["']\/["']/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => path.relative(APP_DIR, file))).toEqual([]);
  });

  it('guards the tabs through SignedOutRedirect', () => {
    const layout = fs.readFileSync(path.join(APP_DIR, '(tabs)', '_layout.tsx'), 'utf8');
    expect(layout).toContain('<SignedOutRedirect status={status} />');
  });
});
