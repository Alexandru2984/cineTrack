# decode-uri-component (vendored)

Upstream 0.5.0, rewritten as CommonJS. Nothing else about it is ours.

## Why this exists

`expo-router` pulls `query-string@7.1.3`, which requires
`decode-uri-component@^0.2.0` and loads it with `require()`. Versions up to
0.4.2 carry CVE-2026-45822: malformed percent-encoded input makes the decoder
recurse over every split of the token list, so cost grows super-linearly with
the length of the input. Measured against 0.2.2 on this project: 1 200
characters took 7.5 seconds, and it keeps climbing. The router parses deep
links, so the input is attacker-supplied — a hostile link would spin the app on
the device that opened it.

The fix landed in 0.5.0, which is ESM-only. `query-string` is CommonJS, so
forcing 0.5.0 through `overrides` resolves but does not work: `require()` of an
ESM module returns the namespace object, and `query-string` calls it as a
function. Verified — `TypeError: decodeComponent is not a function`, on every
query string the router parses.

So the upstream algorithm is vendored here in CommonJS and wired in through
`overrides`. The exponential `decodeComponents` recursion is replaced by
0.5.0's single left-to-right scan; the rest of the module is unchanged apart
from `const`/`let` and the export.

## What keeps it honest

`src/lib/__tests__/decode-uri-component-test.ts` checks two things on every run:
that a payload which used to take seconds now returns in milliseconds, and that
this file agrees with the real upstream 0.5.0 output across a corpus of inputs
— valid sequences, lone `%`, truncated multi-byte sequences, continuation
bytes, the BOM cases and plain text.

## When to delete it

When `expo-router` ships a `query-string` that does not depend on a vulnerable
`decode-uri-component`, or one that can load the ESM build. Drop the
`overrides` entry, remove this directory, and check `npm ls
decode-uri-component` resolves to 0.5.0 or later from the registry.
