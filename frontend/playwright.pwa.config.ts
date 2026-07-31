import { defineConfig, devices } from '@playwright/test';

const ephemeralOutput = process.env.PLAYWRIGHT_EPHEMERAL_OUTPUT === 'true';
const buildDir = ephemeralOutput ? '/tmp/cinetrack-pwa-dist' : 'dist';

export default defineConfig({
  testDir: './e2e-pwa',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  outputDir: ephemeralOutput ? '/tmp/cinetrack-playwright-results' : 'test-results',
  reporter: process.env.CI
    ? [
        ['github'],
        [
          'html',
          {
            open: 'never',
            outputFolder: ephemeralOutput
              ? '/tmp/cinetrack-playwright-report'
              : 'playwright-report',
          },
        ],
      ]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    serviceWorkers: 'allow',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'pwa-mobile',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: `npm run build -- --outDir ${buildDir} --emptyOutDir && npm run preview -- --outDir ${buildDir} --host 127.0.0.1 --port 4173`,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
