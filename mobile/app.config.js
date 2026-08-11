module.exports = ({ config }) => ({
  ...config,
  updates: {
    ...config.updates,
    enabled:
      process.env.EAS_BUILD_PROFILE !== 'production' &&
      process.env.EXPO_UPDATES_ENABLED !== 'false',
  },
});
