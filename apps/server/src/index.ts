import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { MIN_AUTH_SECRET_LENGTH, loadConfig } from './config';
import { NEO_ENV_VARS, scrubSecrets } from './live/env';
import { LiveProvider } from './live/provider';
import { serverLoggerOptions } from './log';
import { createOperations } from './ops';
import { createServices } from './services';

// Credentials live in .env (repo root, optionally apps/server/.env). Loaded before the config is
// read; variables already set in the environment win, and the values are never logged.
const here = path.dirname(fileURLToPath(import.meta.url));
const envFiles: string[] = [];
for (const file of [path.resolve(here, '../../../.env'), path.resolve(here, '../.env')]) {
  if (!fs.existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
    envFiles.push(file);
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
// Model F: login monitor, 24×7 watchdog, weekly audit. Credential values are only used to redact them.
const secrets = config.neo ? NEO_ENV_VARS.map((name) => process.env[name]).filter((v): v is string => !!v) : [];
const supervised = process.env.Q26_SUPERVISED === '1';
let restarting = false;
const ops = createOperations({
  provider,
  db: services.db,
  dataDir: config.persist ? config.dataDir : null,
  config: { host: config.host, authSecretSet: !config.authSecretIssue, persist: config.persist },
  secrets,
  scrub: (t) => scrubSecrets(t, secrets),
  supervised,
  // Exit code 75: the supervisor (scripts/supervise.mjs) starts the server again.
  requestRestart: (why) => {
    if (restarting) return;
    restarting = true;
    log.error(`watchdog: restarting the server (${why})`);
    void shutdown(75);
  },
  log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
});

const app = await buildApp(services, { logger: serverLoggerOptions(), ops });
log = { debug: (m) => app.log.debug(m), info: (m) => app.log.info(m), warn: (m) => app.log.warn(m), error: (m) => app.log.error(m) };
services.start();

// start() returns at once; it never blocks listen.
void provider.start();
ops.start();
void provider.whenStarted().then(() => app.log.info(provider.healthLine()));

let stopping = false;
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  ops.stop();
  // Provider first: services.stop() then clears the user contracts without triggering a universe update.
  await provider.stop().catch((e) => app.log.warn(`live data provider stop failed: ${e instanceof Error ? e.message : String(e)}`));
  services.stop();
  await app.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: config.host });
const clock = provider.clock.info();
app.log.info(`Q26 Options on :${config.port} — open http://localhost:${config.port} — live data only, paper trading only; IST ${clock.date} ${clock.time} (market ${clock.status})`);
app.log.info(
  config.neo
    ? `Kotak credentials: found (${envFiles.length ? envFiles.map((f) => path.relative(process.cwd(), f) || f).join(', ') : 'environment'}); logging in…`
    : `${config.neoError ?? 'Kotak credentials missing'} — live quotes are off until they are set`,
);
if (services.db.recoveredFrom) {
  app.log.error(`db.json could not be read and was moved to ${path.basename(services.db.recoveredFrom)}: users, paper trades and alerts start empty. Restore it from a backup (see docs/q26-audit/ROLLBACK_AND_RECOVERY.md)`);
}
if (config.authSecretIssue === 'weak') {
  app.log.warn(`AUTH_SECRET is a placeholder or shorter than ${MIN_AUTH_SECRET_LENGTH} characters: not used (tokens signed with it could be forged). A random secret is used for this run, so sign-ins end at restart; set a long random AUTH_SECRET in .env`);
}
app.log.info(`login monitor every ${ops.login.intervalMs / 1000} s, watchdog every ${ops.watchdog.intervalMs / 1000} s${supervised ? ' (supervised)' : ''}, weekly audit Saturdays 10:00 IST`);
