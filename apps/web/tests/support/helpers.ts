import fs from 'node:fs';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

/**
 * Collects what must never happen on a page: uncaught errors, console errors and API failures. A 503
 * NO_LIVE_DATA answer is the server saying "nothing live" (the page shows a blank state with the
 * reason), so it is allowed, as is the browser's console line for it. So is GET /api/ops answering 404
 * "Operations … are not running on this server" (the FIXTURE server runs no login monitor / watchdog /
 * audit; the dashboard shows that state). Any other API status ≥ 400 is an error. Call `check()` at the
 * end of a test to await the response bodies.
 */
export function watchErrors(page: Page): { errors: string[]; noLiveData: string[]; opsNotRunning: string[]; check: () => Promise<string[]> } {
  const errors: string[] = [];
  const noLiveData: string[] = [];
  const opsNotRunning: string[] = [];
  const pending: Promise<void>[] = [];
  const isOpsStatus = (url: string) => new URL(url).pathname === '/api/ops';
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon|WebSocket|ERR_ABORTED/i.test(text)) return;
    if (/Failed to load resource: the server responded with a status of 503/.test(text)) return; // checked below by body
    if (/Failed to load resource: the server responded with a status of 404/.test(text) && isOpsStatus(m.location().url)) return; // checked below by body
    errors.push(`console: ${text}`);
  });
  page.on('response', (r) => {
    if (!r.url().includes('/api/') || r.status() < 400) return;
    pending.push(
      (async () => {
        let body: { code?: string; error?: string } | null = null;
        try {
          body = (await r.json()) as { code?: string; error?: string };
        } catch {
          /* not JSON */
        }
        if (r.status() === 503 && body?.code === 'NO_LIVE_DATA' && body.error) noLiveData.push(`${new URL(r.url()).pathname}: ${body.error}`);
        else if (r.status() === 404 && isOpsStatus(r.url()) && /not running/.test(body?.error ?? '')) opsNotRunning.push(body!.error!);
        else errors.push(`HTTP ${r.status()} ${r.url()}${body?.error ? ` — ${body.error}` : ''}`);
      })(),
    );
  });
  return {
    errors,
    noLiveData,
    opsNotRunning,
    check: async () => {
      await Promise.allSettled(pending);
      return errors;
    },
  };
}

/** Text that must never be on screen: broken numbers, or wording of a simulated / demo market. */
export const FORBIDDEN_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|Infinity|simulat|\bdemo\b/i;

/** Visible text of the page (the main area and the header), for FORBIDDEN_TEXT checks. */
export async function pageText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

/**
 * Saves a full-page screenshot to E2E_SHOTS_DIR (desktop projects only) for the review of the run;
 * a no-op when the variable is not set.
 */
export async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir || !info.project.name.endsWith('desktop')) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${info.project.name.replace('-desktop', '')}-${name}.png`), fullPage: true });
}
