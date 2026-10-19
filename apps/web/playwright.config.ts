import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, defineConfig, devices } from '@playwright/test';

/**
 * Two e2e modes, each on its own server:
 *  - LIVE-EMPTY (projects live-*): the production bundle (`node ../server/dist/server.mjs`) with no
 *    Kotak credentials, an empty data dir and no network — every page must show its blank states
 *    with the reasons (the app runs on live data only). A second LIVE-EMPTY server (project
 *    live-master-desktop) also starts offline and without credentials, but from a same-day cached
 *    instrument master (test rows written by apps/server/test/support/e2e-refdata.ts): contracts are
 *    known, nothing is priced, so a paper market order is rejected with "No live bid/ask".
 *  - FIXTURE (project fixture-desktop): the TEST-ONLY entry apps/server/test/support/e2e-server.ts
 *    (FakeProvider + sample book, test data) — real values must render.
 * Run `npm run build` first: both servers serve apps/web/dist.
 */
const livePort = Number(process.env.E2E_PORT ?? 8790);
const fixturePort = Number(process.env.E2E_FIXTURE_PORT ?? 8791);
const masterPort = Number(process.env.E2E_MASTER_PORT ?? 8792);

/**
 * Chromium: CHROMIUM_PATH if set; else Playwright's own browser when it is installed; else the newest
 * Chromium under PLAYWRIGHT_BROWSERS_PATH (a preinstalled browser of another Playwright revision).
 */
function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  try {
    if (fs.existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* fall through to the scan */
  }
  const dirs = fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(root, d, sub);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined;
}
const executablePath = chromiumPath();

/** Fresh data dirs per run: a developer's recorded sessions / EOD files must not leak into LIVE-EMPTY. */
// (Kept in the env: the config is evaluated again in each test worker, which inherits it.)
const emptyDataDir = (process.env.E2E_LIVE_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'q26-e2e-live-empty-')));
const masterDataDir = (process.env.E2E_MASTER_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'q26-e2e-live-master-')));

/** Production server env: offline, no credentials (NEO_* set empty so a developer's .env is not used:
 *  variables already in the environment win over .env), no EOD backfill. */
const liveEnv = (port: number, dataDir: string): Record<string, string> => ({
  PORT: String(port),
  HOST: '127.0.0.1',
  PERSIST: 'false',
  AUTH_SECRET: 'e2e',
  DATA_DIR: dataDir,
  EOD_BACKFILL_DAYS: '0',
  NEO_CONSUMER_KEY: '',
  NEO_MOBILE_NUMBER: '',
  NEO_UCC: '',
  NEO_MPIN: '',
  NEO_TOTP_SECRET: '',
});
const PROD_SERVER = 'node --import ./tests/support/no-network.mjs ../server/dist/server.mjs';

const live = { baseURL: `http://127.0.0.1:${livePort}` };
const fixture = { baseURL: `http://127.0.0.1:${fixturePort}` };
const master = { baseURL: `http://127.0.0.1:${masterPort}` };

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './tests/support/teardown.ts',
  use: {
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'live-desktop',
      testMatch: /live-empty\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...live, viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
    },
    { name: 'live-mobile', testMatch: /live-empty\.spec\.ts/, use: { ...devices['Pixel 7'], ...live, launchOptions: { executablePath } } },
    {
      name: 'live-master-desktop',
      testMatch: /live-master\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...master, viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
    },
    {
      name: 'fixture-desktop',
      testMatch: /fixture\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], ...fixture, viewport: { width: 1440, height: 900 }, launchOptions: { executablePath } },
    },
  ],
  webServer: [
    {
      // The real production bundle, offline and without credentials.
      command: PROD_SERVER,
      url: `http://127.0.0.1:${livePort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: liveEnv(livePort, emptyDataDir),
    },
    {
      // The same, after a TEST-ONLY step caches today's instrument master (test rows) in its data dir.
      command: `npx tsx ../server/test/support/e2e-refdata.ts "${masterDataDir}" && ${PROD_SERVER}`,
      url: `http://127.0.0.1:${masterPort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: liveEnv(masterPort, masterDataDir),
    },
    {
      // TEST-ONLY fixture server (FakeProvider + sample book); never part of `npm start`.
      command: 'npx tsx ../server/test/support/e2e-server.ts',
      url: `http://127.0.0.1:${fixturePort}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { E2E_FIXTURE_PORT: String(fixturePort), HOST: '127.0.0.1', AUTH_SECRET: 'e2e-fixture' },
    },
  ],
});
