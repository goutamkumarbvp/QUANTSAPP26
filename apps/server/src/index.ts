import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './config';
import { LiveProvider } from './live/provider';
import { createServices } from './services';

// Credentials live in .env (repo root, optionally apps/server/.env). Loaded before the config is
// read; variables already set in the environment win, and the values are never logged.
const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.resolve(here, '../../../.env'), path.resolve(here, '../.env')]) {
  if (!fs.existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (e) {
    // The error names the file and the failure (e.g. EACCES), never a value from it.
    console.warn(`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const config = loadConfig();

// Live market data (Kotak Neo + NSE/BSE EOD): the only market-data source of the app.
let log: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void } = console;
const provider = new LiveProvider(
  {
    dataDir: config.dataDir,
    riskFreeRate: config.riskFreeRate,
    holidays: config.holidays,
    neo: config.neo,
    neoError: config.neoError,
    eodBackfillDays: config.eodBackfillDays,
    sfeedTokenBudget: config.sfeedTokenBudget,
  },
  {
    logger: {
      debug: (m) => log.debug(m),
      info: (m) => log.info(m),
      warn: (m) => log.warn(m),
      error: (m) => log.error(m),
    },
  },
);

const services = createServices(config, {
  provider,
  onError: (where, e) => log.warn(`${where} failed: ${e instanceof Error ? e.message : String(e)}`),
});
const app = await buildApp(services, { logger: true });
log = { debug: (m) => app.log.debug(m), info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) };
services.start();

// start() returns at once; it never blocks listen.
void provider.start();
void provider.whenStarted().then(() => app.log.info(provider.healthLine()));

const shutdown = async () => {
  // Provider first: services.stop() then clears the user contracts without triggering a universe update.
  await provider.stop().catch((e) => app.log.warn(`live data provider stop failed: ${e instanceof Error ? e.message : String(e)}`));
  services.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
const clock = provider.clock.info();
app.log.info(`Q26 Options API on :${config.port} — live data only, IST ${clock.date} ${clock.time} (market ${clock.status})`);
// Health summary (no secrets): broker login, feed, instrument master, EOD files, recorded sessions.
app.log.info(provider.healthLine());
