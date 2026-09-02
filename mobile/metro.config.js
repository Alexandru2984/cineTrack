// Route `decode-uri-component` through the bounded copy in `patches/`.
//
// See that file for why. In short: `expo-router` decodes every deep link with
// it, the reachable version is quadratic on malformed input, and there is no
// upgrade because the fixed release is ESM-only.
//
// Only the bare specifier is redirected. `patches/decode-uri-component.js`
// requires `decode-uri-component/index.js`, which still resolves to the real
// package — without that distinction the alias would resolve to itself.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const bounded = path.resolve(__dirname, 'patches/decode-uri-component.js');
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'decode-uri-component') {
    return { type: 'sourceFile', filePath: bounded };
  }
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
