// eslint-disable-next-line @typescript-eslint/no-require-imports
const decodeUriComponent = require('../../../vendor/decode-uri-component') as (
  input: string,
) => string;

/** The vendored CommonJS build of decode-uri-component 0.5.0.
 *
 *  `expo-router` reaches this through `query-string@7.1.3`, which requires it
 *  with `require()`. Every published version up to 0.4.2 carries
 *  CVE-2026-45822, and the fixed 0.5.0 is ESM-only, so it cannot be required —
 *  forcing it resolves and then throws `decodeComponent is not a function` on
 *  every query string the router parses. Hence the copy in `vendor/`.
 *
 *  Two things have to stay true for that copy to be worth having, and neither
 *  is obvious from reading it. */
describe('vendored decode-uri-component', () => {
  /** What the CVE is.
   *
   *  0.2.2 decoded malformed input by recursing over splits of the token list,
   *  which costs far more than linear time. Measured against it on this
   *  project: 1 200 characters took 7.5 seconds, and it kept climbing. The
   *  router parses deep links, so a hostile link would spin the app on the
   *  device that opened it.
   *
   *  The threshold is deliberately loose. This is not a benchmark — it is the
   *  difference between one scan and an algorithm that degrades, and the old
   *  code missed it by three orders of magnitude. */
  it('decodes malformed input in linear time', () => {
    const hostile = '%C2'.repeat(2000);
    const started = Date.now();
    decodeUriComponent(hostile);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  /** The vendored file must behave exactly like the release it came from.
   *
   *  These outputs were produced by the real decode-uri-component 0.5.0. A
   *  transcription slip, or a well-meaning edit, would change what a deep link
   *  decodes to — a routing bug nobody would trace back to here. */
  it.each([
    ["", ""],
    ["plain text", "plain text"],
    ["a%2Fb", "a/b"],
    ["%20", " "],
    ["%C3%A9", "\u00e9"],
    ["%E2%9C%93", "\u2713"],
    ["Love%2C%20Death%20%26%20Robots", "Love, Death & Robots"],
    ["a+b", "a+b"],
    ["%", "%"],
    ["%A", "%A"],
    ["%ZZ", "%ZZ"],
    ["%%%", "%%%"],
    ["%C2", "\ufffd"],
    ["%C2%C2", "\ufffd\ufffd"],
    ["%FE%FF", "\ufffd\ufffd"],
    ["%FF%FE", "\ufffd\ufffd"],
    ["%C3", "%C3"],
    ["%E0%A4", "%E0%A4"],
    ["%F0%9F%92", "%F0%9F%92"],
    ["%F0%9F%92%A9", "\ud83d\udca9"],
    ["mix%20of%ZZvalid%20and%C2invalid", "mix of%ZZvalid and\ufffdinvalid"],
    ["%E0%A4%A", "%E0%A4%A"],
    ["trailing%", "trailing%"],
    ["%2F%2F%2F", "///"],
    ["vazute://list/%7Bid%7D?q=%C3%A9", "vazute://list/{id}?q=\u00e9"],
    ["%c3%a9", "\u00e9"],
    ["%C3%A9%C2%A0", "\u00e9\u00a0"],
    ["a%20b%%20c", "a b% c"],
    ["%80", "%80"],
    ["%BF", "%BF"],
    ["%C1%81", "%C1%81"],
  ])('decodes %p the way upstream 0.5.0 does', (input, expected) => {
    expect(decodeUriComponent(input)).toBe(expected);
  });

  it('still refuses a non-string, as its callers expect', () => {
    expect(() => decodeUriComponent(undefined as unknown as string)).toThrow(TypeError);
  });
});
