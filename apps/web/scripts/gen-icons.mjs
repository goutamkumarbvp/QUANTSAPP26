// Renders public/icon.svg to the PNG sizes the web manifest / app stores need.
// Usage: node scripts/gen-icons.mjs   (set CHROMIUM_PATH to use a specific browser binary)
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const svg = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
const targets = [
  { file: 'icon-192.png', size: 192, pad: 0 },
  { file: 'icon-512.png', size: 512, pad: 0 },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.12 },
];
for (const t of targets) {
  await page.setViewportSize({ width: t.size, height: t.size });
  const inner = Math.round(t.size * (1 - 2 * t.pad));
  await page.setContent(`<html><body style="margin:0;background:${t.pad ? '#0b1220' : 'transparent'};display:flex;align-items:center;justify-content:center;width:${t.size}px;height:${t.size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path: new URL(`../public/${t.file}`, import.meta.url).pathname, omitBackground: !t.pad });
  console.log('wrote', t.file);
}
await browser.close();
