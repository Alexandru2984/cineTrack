const fs = require('fs');
const path = require('path');

/**
 * Locate the Firebase config Android push needs.
 *
 * The file is deliberately not committed: this repository is public. EAS holds
 * it as a file environment variable and exposes its path at build time, while a
 * local checkout keeps its own copy next to this config.
 *
 * Returning undefined rather than a missing path matters. CI runs `expo-doctor`
 * and exports the JS bundle without ever needing Firebase, and pointing the
 * config at a file that is not there would fail those runs for no reason.
 */
function googleServicesFile() {
  const fromEnvironment = process.env.GOOGLE_SERVICES_JSON;
  if (fromEnvironment && fs.existsSync(fromEnvironment)) return fromEnvironment;

  const local = path.join(__dirname, 'google-services.json');
  return fs.existsSync(local) ? local : undefined;
}

module.exports = ({ config }) => {
  const services = googleServicesFile();

  // A production build without it still succeeds, and push then fails only on
  // the device, long after anyone is watching the build log. Say so here.
  if (!services && process.env.EAS_BUILD_PROFILE === 'production') {
    console.warn(
      'google-services.json is missing: this build cannot register for push notifications.',
    );
  }

  return {
    ...config,
    android: {
      ...config.android,
      ...(services ? { googleServicesFile: services } : {}),
    },
    updates: {
      ...config.updates,
      enabled:
        process.env.EAS_BUILD_PROFILE !== 'production' &&
        process.env.EXPO_UPDATES_ENABLED !== 'false',
    },
  };
};
