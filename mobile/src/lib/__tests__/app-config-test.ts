const resolveAppConfig = jest.requireActual('../../../app.config') as (input: {
  config: { updates?: { url?: string } };
}) => { updates: { url?: string; enabled: boolean } };

describe('mobile update policy', () => {
  const config = {
    updates: { url: 'https://u.expo.dev/project' },
  };

  afterEach(() => {
    delete process.env.EXPO_UPDATES_ENABLED;
    delete process.env.EAS_BUILD_PROFILE;
  });

  it('keeps OTA available for internal preview builds', () => {
    process.env.EXPO_UPDATES_ENABLED = 'true';
    expect(resolveAppConfig({ config }).updates).toEqual({
      url: 'https://u.expo.dev/project',
      enabled: true,
    });
  });

  it('disables unsigned OTA updates in store builds', () => {
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.EXPO_UPDATES_ENABLED = 'true';
    expect(resolveAppConfig({ config }).updates.enabled).toBe(false);
  });
});
