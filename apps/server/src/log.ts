/**
 * Terminal output of the server: one readable line per event — IST time, level, message — instead of
 * pino's JSON lines. LOG_FORMAT=json keeps pino's JSON (for log collectors); LOG_LEVEL sets the
 * threshold (trace, debug, info, warn, error, fatal; default info). Request lines are written at
 * debug only (see buildApp), so a running terminal shows what happened, not every poll of the web app.
 */
import { IST_OFFSET_MS } from '@q26/core';

const LEVELS: Readonly<Record<number, string>> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
const LEVEL_NAMES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevelName = (typeof LEVEL_NAMES)[number];

/** HH:MM:SS of an epoch-ms time in IST (the exchange clock), independent of the machine's time zone. */
export function istClock(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(11, 19);
}

/** "HH:MM:SS IST" (same day) or "DD Mon HH:MM IST" (another day), relative to `now`. */
export function istWhen(ms: number, now: number = Date.now()): string {
  const d = new Date(ms + IST_OFFSET_MS).toISOString();
  const today = new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);
  if (d.slice(0, 10) === today) return `${d.slice(11, 19)} IST`;
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(d.slice(5, 7)) - 1];
  return `${d.slice(8, 10)} ${month} ${d.slice(11, 16)} IST`;
}

const COLOR: Readonly<Record<string, string>> = { TRACE: '\x1b[2m', DEBUG: '\x1b[2m', WARN: '\x1b[33m', ERROR: '\x1b[31m', FATAL: '\x1b[31m' };

/** One pino JSON line → "HH:MM:SS LEVEL message" (errors keep their stack). Anything else passes through. */
export function formatLogLine(line: string, opts: { color?: boolean } = {}): string {
  let j: { level?: number; time?: number; msg?: unknown; err?: { message?: string; stack?: string } };
  try {
    j = JSON.parse(line);
  } catch {
    return line;
  }
  if (!j || typeof j !== 'object') return line;
  const level = LEVELS[j.level ?? 30] ?? String(j.level);
  let msg = typeof j.msg === 'string' ? j.msg : '';
  const err = j.err;
  if (err && typeof err === 'object') {
    const em = err.message ?? '';
    msg = msg && msg !== em ? `${msg}: ${em}` : em || msg;
    if ((j.level ?? 30) >= 50 && err.stack) {
      const rest = err.stack.split('\n').slice(1, 8).map((l) => `    ${l.trim()}`);
      if (rest.length) msg += `\n${rest.join('\n')}`;
    }
  }
  const time = typeof j.time === 'number' ? istClock(j.time) : '--:--:--';
  const text = `${time} ${level.padEnd(5)} ${msg}`;
  const c = opts.color ? COLOR[level] : undefined;
  return c ? `${c}${text}\x1b[0m` : text;
}

export interface LogOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

/** Fastify `logger` options from the environment: readable lines on `out` (default), or pino JSON. */
export function serverLoggerOptions(
  env: Record<string, string | undefined> = process.env,
  out: LogOutput = process.stdout,
): { level: LogLevelName; stream?: { write(chunk: string): void } } {
  const raw = (env.LOG_LEVEL ?? '').trim().toLowerCase();
  const level = (LEVEL_NAMES as readonly string[]).includes(raw) ? (raw as LogLevelName) : 'info';
  if ((env.LOG_FORMAT ?? '').trim().toLowerCase() === 'json') return { level };
  const color = !!out.isTTY && !env.NO_COLOR;
  return {
    level,
    stream: {
      write(chunk: string) {
        for (const l of chunk.split('\n')) if (l.trim()) out.write(`${formatLogLine(l, { color })}\n`);
      },
    },
  };
}
