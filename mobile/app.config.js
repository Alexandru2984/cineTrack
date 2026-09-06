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

/**
 * Whether over-the-air updates may be enabled for this build.
 *
 * They may not, and the condition is written so that turning them on requires
 * wiring code signing rather than flipping an environment variable.
 *
 * The preview profile used to enable them, and preview points at the production
 * API: an internal APK given to a tester was a second, unsigned way to deliver
 * code that then ran with that tester's real session. Expo verifies the update
 * came from the configured server, not that the publisher intended it, so a
 * compromised EAS account or channel would have been enough. Store builds never
 * had this — they force OTA off — which left the least-protected distribution
 * path attached to real accounts.
 *
 * Re-enabling means configuring `updates.codeSigningCertificate` and the key
 * that goes with it, and restricting who can publish to the channel. Until that
 * exists, `EXPO_UPDATES_ENABLED=true` is not enough on its own, which is the
 * point: an env var in a build profile should not be able to open a code
 * delivery path.
 */
function otaIsAllowed() {
  if (process.env.EXPO_UPDATES_ENABLED !== 'true') return false;
  // Store builds are never eligible, whatever else is configured.
  if (process.env.EAS_BUILD_PROFILE === 'production') return false;
  return Boolean(process.env.EXPO_UPDATES_CODE_SIGNING_CERTIFICATE);
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
      enabled: otaIsAllowed(),
    },
  };
};
