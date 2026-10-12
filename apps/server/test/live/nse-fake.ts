/** Test doubles for the NSE/BSE HTTP layer: a scripted fetch and a manual clock. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NseHttp, type FetchLike } from '../../src/live/nse/http';

export const fixture = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nse', name), 'utf8');

export interface Call {
  url: string;
  headers: Record<string, string>;
}

type Reply = Response | Error | (() => Response | Error);

/** Each URL answers from its queue (the last reply repeats); unknown URLs throw. */
export function fakeFetch(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const served = new Map<string, number>();
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected request ${url}`);
    const list = Array.isArray(route) ? route : [route];
    const n = served.get(url) ?? 0;
    served.set(url, n + 1);
    let reply = list[Math.min(n, list.length - 1)];
    if (typeof reply === 'function') reply = reply();
    if (reply instanceof Error) throw reply;
    return reply.clone();
  };
  return { fetch, calls };
}

export function manualClock(start = Date.UTC(2026, 9, 12, 13, 0)) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

export function testHttp(routes: Record<string, Reply | Reply[]>, opts: { retries?: number } = {}) {
  const f = fakeFetch(routes);
  const clock = manualClock();
  const logs: string[] = [];
  const http = new NseHttp({
    fetch: f.fetch,
    now: clock.now,
    sleep: clock.sleep,
    logger: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    retries: opts.retries,
  });
  return { http, calls: f.calls, clock, logs };
}

export const text = (body: string | Uint8Array, status = 200, headers: [string, string][] = []): Response =>
  new Response(body, { status, headers });
export const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: [['content-type', 'application/json']] });
export const html = (status = 200, cookies: string[] = []): Response =>
  new Response('<!DOCTYPE html><html><body>page</body></html>', { status, headers: [['content-type', 'text/html'], ...cookies.map((c): [string, string] => ['set-cookie', c])] });
