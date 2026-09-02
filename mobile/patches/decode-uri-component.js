// A bounded `decode-uri-component`, aliased in by `metro.config.js`.
//
// `expo-router` parses every deep link through `query-string`, which decodes
// each component with this package. Version 0.2.2 — the only one reachable
// here — answers malformed percent-encoding by splitting the token list in two
// and retrying, recursively, inside a loop over every token. That is quadratic,
// and on the JS thread it freezes the interface outright. Measured on the
// installed copy:
//
//     150 characters      83 ms
//     600 characters    1437 ms
//    1200 characters    6779 ms
//    2400 characters   > 30000 ms
//
// So a 2.4 KB link, sent to somebody, hangs their app for over half a minute.
//
// There is no upgrade: the patched release is ESM-only and `query-string`
// requires this as CommonJS. Dependabot tried twice and both runs failed. When
// Expo SDK 58 lands, `expo-router` drops `query-string` and this file goes.
//
// The guard is deliberately narrow. Every legitimate input decodes on the first
// `decodeURIComponent` call and never reaches the expensive branch — verified
// against accented titles, emoji, encoded queries and empty strings — so the
// only inputs affected are ones that are *both* malformed and long, which is
// the attack and never a real link.
const decodeUriComponent = require('decode-uri-component/index.js');

// Where the original is still cheap. At this length its worst case is about a
// quarter of a second, and no genuine deep link in this app comes close: the
// longest real path is a username or a TMDB id.
const MAX_RECOVERABLE_LENGTH = 256;

module.exports = function decode(input) {
  try {
    // The path every real link takes, unchanged.
    return decodeURIComponent(input);
  } catch (error) {
    // Malformed. Short enough to hand to the original, so behaviour for
    // anything a person might genuinely mistype stays exactly as it was.
    if (typeof input === 'string' && input.length > MAX_RECOVERABLE_LENGTH) {
      return input;
    }
    return decodeUriComponent(input);
  }
};
