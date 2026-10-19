import fs from 'node:fs';

/** Removes the per-run data dirs of the LIVE-EMPTY servers (created in playwright.config.ts). */
export default function teardown(): void {
  for (const dir of [process.env.E2E_LIVE_DATA_DIR, process.env.E2E_MASTER_DATA_DIR]) {
    if (dir && /q26-e2e-live-/.test(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}
