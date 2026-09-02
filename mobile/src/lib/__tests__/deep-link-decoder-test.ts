/** The deep-link decoder must stay bounded.
 *
 *  `expo-router` decodes every deep link through `query-string`, which uses
 *  `decode-uri-component`. The reachable version answers malformed
 *  percent-encoding by recursively splitting the token list, which is quadratic
 *  and runs on the JS thread — a long malformed link freezes the interface.
 *
 *  `metro.config.js` aliases the package to `patches/decode-uri-component.js`.
 *  These tests are what says the alias still does its job, because a bundler
 *  config that silently stops applying leaves no other trace. */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bounded = require('../../../patches/decode-uri-component.js') as (input: string) => string;

describe('the bounded deep-link decoder', () => {
  it('decodes ordinary links exactly as the platform does', () => {
    // Every real link takes this path: `decodeURIComponent` succeeds on the
    // first call and the expensive branch is never reached.
    for (const input of [
      'hello%20world',
      '%C3%A9p%C3%AEsode',
      '%F0%9F%8E%AC',
      'a%2Bb%3Dc',
      'plain',
      '',
    ]) {
      expect(bounded(input)).toBe(decodeURIComponent(input));
    }
  });

  it('still repairs short malformed input, as before', () => {
    // Behaviour for anything a person might genuinely mistype is unchanged, so
    // the guard cannot break a link that used to work.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const original = require('decode-uri-component') as (input: string) => string;
    for (const input of ['%zz', '%C2', '%C2%C2%C2', '%E0%A4%A']) {
      expect(bounded(input)).toBe(original(input));
    }
  });

  it('refuses to spend quadratic time on a long malformed link', () => {
    // 2.4 KB of lone continuation bytes. Against the unbounded version this
    // measured over thirty seconds; the assertion is deliberately loose so it
    // fails on the defect and not on a slow machine.
    const attack = '%C2'.repeat(800);
    const started = Date.now();
    const result = bounded(attack);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    // Undecodable input comes back as it went in, rather than half-decoded.
    expect(result).toBe(attack);
  });
});
