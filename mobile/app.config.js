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

/**
 * True for the builds people actually install: store releases and the internal
 * APKs handed to testers. Development client builds and every local command are
 * excluded, so nothing outside EAS needs the file to be present.
 */
function isInstallableBuild() {
  return (
    process.env.EAS_BUILD === 'true' &&
    (process.env.EAS_BUILD_PROFILE === 'production' ||
      process.env.EAS_BUILD_PROFILE === 'preview')
  );
}

module.exports = ({ config }) => {
  const services = googleServicesFile();

  // Version codes 8 through 12 all shipped without this file. Nothing failed:
  // the build went green, the artifact installed, and push registration only
  // died on the device, days later, with no trace back to the cause. Refusing
  // to produce the artifact is the whole point — an installable build that
  // cannot register for push is not worth the twenty minutes it takes to make.
  if (!services && isInstallableBuild()) {
    throw new Error(
      'google-services.json is missing, so this build could not register for push ' +
        'notifications. Upload it as the GOOGLE_SERVICES_JSON file variable in the ' +
        `EAS "${process.env.EAS_BUILD_PROFILE}" environment ` +
        '(eas env:set --name GOOGLE_SERVICES_JSON --type file), or keep a copy in mobile/.',
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
