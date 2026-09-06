// `existsSync` decides whether the Firebase config was found, so the checks
// below have to drive it. Without this the result would depend on whether the
// machine running the suite happens to keep a local copy of the file, which is
// true on a developer's checkout and false in CI.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(),
}));

const fs = require('fs') as { existsSync: jest.Mock };

const resolveAppConfig = jest.requireActual('../../../app.config') as (input: {
  config: { updates?: { url?: string }; android?: Record<string, unknown> };
}) => {
  updates: { url?: string; enabled: boolean };
  android: { googleServicesFile?: string };
};

const config = {
  updates: { url: 'https://u.expo.dev/project' },
};

beforeEach(() => {
  fs.existsSync.mockReset();
  fs.existsSync.mockReturnValue(false);
});

afterEach(() => {
  delete process.env.EXPO_UPDATES_ENABLED;
  delete process.env.EXPO_UPDATES_CODE_SIGNING_CERTIFICATE;
  delete process.env.EAS_BUILD_PROFILE;
  delete process.env.EAS_BUILD;
  delete process.env.GOOGLE_SERVICES_JSON;
});

describe('mobile update policy', () => {
  // Preview used to enable OTA, and preview points at the production API: an
  // internal APK handed to a tester was a second, unsigned way to deliver code
  // that then ran with that tester's real session. Asking for it is no longer
  // enough on its own.
  it('refuses unsigned OTA on internal preview builds', () => {
    process.env.EAS_BUILD_PROFILE = 'preview';
    process.env.EXPO_UPDATES_ENABLED = 'true';
    expect(resolveAppConfig({ config }).updates).toEqual({
      url: 'https://u.expo.dev/project',
      enabled: false,
    });
  });

  it('disables unsigned OTA updates in store builds', () => {
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.EXPO_UPDATES_ENABLED = 'true';
    expect(resolveAppConfig({ config }).updates.enabled).toBe(false);
  });

  // The gate is the signing certificate, not the flag, so that a build profile
  // cannot open a code-delivery path by setting one environment variable.
  it('allows OTA once updates are code signed, store builds excepted', () => {
    process.env.EXPO_UPDATES_ENABLED = 'true';
    process.env.EXPO_UPDATES_CODE_SIGNING_CERTIFICATE = 'certificates/updates.pem';
    process.env.EAS_BUILD_PROFILE = 'preview';
    expect(resolveAppConfig({ config }).updates.enabled).toBe(true);

    process.env.EAS_BUILD_PROFILE = 'production';
    expect(resolveAppConfig({ config }).updates.enabled).toBe(false);
  });

  it('stays off when nothing asked for it', () => {
    expect(resolveAppConfig({ config }).updates.enabled).toBe(false);
  });
});

describe('Firebase configuration', () => {
  const SECRET_PATH = '/home/expo/workingdir/eas-environment-secrets/google-services.json';

  it('points Android at the file EAS exposes as a path', () => {
    process.env.GOOGLE_SERVICES_JSON = SECRET_PATH;
    fs.existsSync.mockImplementation((path: string) => path === SECRET_PATH);

    expect(resolveAppConfig({ config }).android.googleServicesFile).toBe(SECRET_PATH);
  });

  // Version codes 8 through 12 were all built and installed without it, and the
  // only symptom was push registration hanging on the device. The build has to
  // be the thing that fails.
  it.each(['production', 'preview'])(
    'refuses to produce an installable %s build without it',
    (profile) => {
      process.env.EAS_BUILD = 'true';
      process.env.EAS_BUILD_PROFILE = profile;

      expect(() => resolveAppConfig({ config })).toThrow(/google-services\.json is missing/);
    },
  );

  it('ignores a stale path that no longer exists on disk', () => {
    process.env.EAS_BUILD = 'true';
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.GOOGLE_SERVICES_JSON = '/tmp/deleted-by-a-previous-step.json';

    expect(() => resolveAppConfig({ config })).toThrow(/google-services\.json is missing/);
  });

  // CI runs expo-doctor and exports the bundle, neither of which touches
  // Firebase, and a development client is not an artifact anyone ships.
  it.each([
    ['a local command', undefined, undefined],
    ['a development client build', 'true', 'development'],
  ])('lets %s run without it', (_label, easBuild, profile) => {
    if (easBuild) process.env.EAS_BUILD = easBuild;
    if (profile) process.env.EAS_BUILD_PROFILE = profile;

    const resolved = resolveAppConfig({ config });
    expect(resolved.android.googleServicesFile).toBeUndefined();
  });
});
