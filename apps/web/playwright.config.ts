import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 8790);
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } },
  ],
  webServer: {
    command: 'node ../server/dist/server.mjs',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(port), HOST: '127.0.0.1', PERSIST: 'false', SIM_START: '2026-10-09T11:30', AUTH_SECRET: 'e2e' },
  },
});
