#!/usr/bin/env node
/**
 * 24×7 supervisor for the Q26 server (Model F #2, outer half): starts apps/server/dist/server.mjs,
 * starts it again after a crash or a watchdog restart request (exit code 75), and restarts it when
 * GET /api/health stops answering (a hang). The in-process watchdog (apps/server/src/ops/watchdog.ts)
 * handles everything that can be repaired without a restart.
 *
 *   npm run build && npm run start:supervised
 *
 * Restart back-off: 1 s doubling to 60 s (watchdog restarts too), reset after 10 min of healthy
 * running. 3 watchdog restarts within an hour are a loop: the next server is started with
 * Q26_RESTART_LOOP=1, so its watchdog reports the problem instead of restarting again. Health: every
 * 30 s after a 90 s start-up grace; 3 failures in a row → SIGTERM, SIGKILL after 15 s. Ctrl+C /
 * SIGTERM stop the server and the supervisor. Output: the server's own lines, plus "supervisor:" lines.
 * The health address is resolved like the server's own: .env (repository root, then apps/server/.env;
 * variables already set win), PORT (default 8787) and HOST (0.0.0.0 / localhost → 127.0.0.1, :: → ::1).
 * Overrides: Q26_SERVER (path to the server bundle), Q26_HEALTH_URL.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The same .env files the server loads (apps/server/src/index.ts): the child inherits them too.
for (const file of [path.join(root, '.env'), path.join(root, 'apps/server/.env')]) {
  if (!fs.existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (e) {
    process.stdout.write(`supervisor: could not read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
const serverPath = process.env.Q26_SERVER ?? path.join(root, 'apps/server/dist/server.mjs');
const healthUrl = process.env.Q26_HEALTH_URL ?? `http://${healthHost(process.env.HOST)}:${serverPort(process.env.PORT)}/api/health`;

/** PORT as the server reads it (config.ts num()): unset, empty or not a number → 8787. */
function serverPort(raw) {
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 8787;
}
/** Where the server listening on HOST answers locally. */
function healthHost(raw) {
  const h = (raw ?? '').trim();
  if (h === '' || h === '0.0.0.0' || h === 'localhost') return '127.0.0.1';
  if (h === '::' || h === '::1') return '[::1]';
  return h.includes(':') ? `[${h}]` : h;
}

const HEALTH_EVERY_MS = 30_000;
const HEALTH_TIMEOUT_MS = 10_000;
const STARTUP_GRACE_MS = 90_000;
const HEALTH_FAILS = 3;
const KILL_AFTER_MS = 15_000;
const STABLE_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const LOOP_WINDOW_MS = 60 * 60_000;
const LOOP_MAX = 3;

let child = null;
let stopping = false;
let backoff = 1000;
let startedAt = 0;
let healthFails = 0;
let healthTimer = null;
let restarts = 0;
/** Times of the watchdog restart requests (exit 75) within the last hour. */
let watchdogRestarts = [];

function ist(ms = Date.now()) {
  return new Date(ms + 330 * 60_000).toISOString().slice(11, 19);
}
function say(msg) {
  process.stdout.write(`${ist()} SUPER supervisor: ${msg}\n`);
}

function start() {
  if (stopping) return;
  startedAt = Date.now();
  healthFails = 0;
  watchdogRestarts = watchdogRestarts.filter((t) => Date.now() - t < LOOP_WINDOW_MS);
  const loop = watchdogRestarts.length >= LOOP_MAX;
  child = spawn(process.execPath, [serverPath], { stdio: 'inherit', env: { ...process.env, Q26_SUPERVISED: '1', ...(loop ? { Q26_RESTART_LOOP: '1' } : {}) } });
  say(`server started (pid ${child.pid}${restarts ? `, restart #${restarts}` : ''})`);
  child.on('exit', (code, signal) => {
    clearInterval(healthTimer);
    healthTimer = null;
    child = null;
    if (stopping) {
      say('server stopped; supervisor exiting');
      process.exit(0);
    }
    const ran = Date.now() - startedAt;
    if (ran >= STABLE_MS) backoff = 1000;
    const why = code === 75 ? 'watchdog requested a restart' : signal ? `killed by ${signal}` : `exited with code ${code}`;
    restarts++;
    if (code === 75) {
      watchdogRestarts.push(Date.now());
      if (watchdogRestarts.filter((t) => Date.now() - t < LOOP_WINDOW_MS).length === LOOP_MAX) {
        say(`${LOOP_MAX} watchdog restarts within an hour: restart loop — the next server will not request restarts; a person must investigate`);
      }
    }
    say(`server ${why} after ${Math.round(ran / 1000)} s; starting again in ${Math.round(backoff / 1000)} s`);
    setTimeout(start, backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  });
  healthTimer = setInterval(checkHealth, HEALTH_EVERY_MS);
}

async function checkHealth() {
  if (!child || Date.now() - startedAt < STARTUP_GRACE_MS) return;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    healthFails = 0;
  } catch (e) {
    healthFails++;
    say(`health check failed (${e instanceof Error ? e.message : String(e)}), ${healthFails}/${HEALTH_FAILS}`);
    if (healthFails >= HEALTH_FAILS && child) {
      say('server not answering: restarting it');
      const c = child;
      c.kill('SIGTERM');
      setTimeout(() => {
        if (child === c) c.kill('SIGKILL');
      }, KILL_AFTER_MS).unref();
    }
  }
}

function stop(sig) {
  if (stopping) return;
  stopping = true;
  say(`${sig}: stopping the server`);
  if (!child) process.exit(0);
  child.kill('SIGTERM');
  setTimeout(() => {
    child?.kill('SIGKILL');
    process.exit(0);
  }, KILL_AFTER_MS).unref();
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

say(`supervising ${path.relative(process.cwd(), serverPath) || serverPath}; health ${healthUrl}`);
start();
