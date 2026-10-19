/**
 * FIXTURE mode: the TEST-ONLY server apps/server/test/support/e2e-server.ts (FakeProvider + sample
 * book; every figure is test data, clock fixed at 2026-10-12 11:00 IST, market open). Checks that real
 * values render where the app has them: the chain with IV solved from premiums, a scanner row, the
 * opening range, order flow labelled as an estimate, IV, and a paper market order filling at the ask.
 */
import { expect, test, type Page } from '@playwright/test';
import { FORBIDDEN_TEXT, pageText, shot, watchErrors } from './support/helpers';

async function open(page: Page, path: string, title: RegExp): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title, { timeout: 20_000 });
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 20_000 });
}

async function clean(page: Page, watch: ReturnType<typeof watchErrors>): Promise<void> {
  expect((await pageText(page)).match(FORBIDDEN_TEXT)?.[0] ?? null, 'no NaN/undefined/Infinity/simulated text').toBeNull();
  expect(await watch.check()).toEqual([]);
}

test('home: index cards, derivatives snapshot with ORB and order flow (estimate), feed LIVE', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/', /Market Overview/);
  await expect(page.getByRole('button', { name: 'Feed status: LIVE' })).toBeVisible();
  await expect(page.getByText('25,000.00').first()).toBeVisible();
  const nifty = page.getByRole('row', { name: /^NIFTY 13-Oct-26/ });
  await expect(nifty).toContainText('25,013 / 24,987');
  await expect(nifty).toContainText('Trending ↑');
  await expect(nifty).toContainText('65% buy');
  await expect(page.getByText(/estimated from live ticks \(quote rule\)/).first()).toBeVisible();
  // A card without data keeps its reason (no recorded BANKNIFTY minutes in the fixture).
  await expect(page.getByText(/No recorded BANKNIFTY minutes/).first()).toBeVisible();
  await shot(page, info, 'home');
  await clean(page, watch);
});

test('option chain: live premiums with IV solved from them, valued at the chain time', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/option-chain', /Option Chain/);
  const atm = page.getByRole('row', { name: /25,000/ }).filter({ hasText: '81.90' }).first();
  await expect(atm).toBeVisible({ timeout: 20_000 });
  await expect(atm).toContainText('14.00'); // IV of the ATM call, solved from its premium (sample book vol 14 %)
  await expect(atm).toContainText('81.85 / 81.95'); // live bid / ask
  await expect(page.getByText(/valued at 11:00:00/).first()).toBeVisible();
  await expect(page.getByText(/put-call parity/).first()).toBeVisible();
  await shot(page, info, 'option-chain');
  await clean(page, watch);
});

test('scanners: a build-up row with its coverage note', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/scanners', /F&O Scanners/);
  const row = page.getByRole('row', { name: /RELIANCE/ }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('1,403.20');
  await expect(page.getByText(/3 of 3 near-month futures/).first()).toBeVisible();
  await shot(page, info, 'scanners');
  await clean(page, watch);
});

test('opening range breakout: complete range from recorded minutes and the first break', async ({ page }) => {
  const watch = watchErrors(page);
  await open(page, '/orb', /Opening Range Breakout/);
  await expect(page.getByText('Range complete · 15 of 15 minutes traded')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('25,013').first()).toBeVisible();
  await expect(page.getByText('24,987').first()).toBeVisible();
  await expect(page.getByText(/Up 10:16/).first()).toBeVisible();
  await clean(page, watch);
});

test('order flow: labelled an estimate from live ticks; feed-gap volume and partial minutes are shown apart', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/order-flow', /Order Flow \(1-minute\)/);
  await expect(page.getByText(/is estimated from live ticks \(quote rule\)/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Buyers dominant').first()).toBeVisible();
  await expect(page.getByText(/Feed gap \+1\.2K \(not in the split\)/)).toBeVisible();
  await expect(page.getByText(/partial \(lower bound\)/).first()).toBeVisible();
  await shot(page, info, 'order-flow');
  await clean(page, watch);
});

test('IV chart: ATM IV solved from live premiums; IV rank blank with its reason', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/vol/iv-chart', /IV Chart/);
  await expect(page.getByText('14.00%').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('solved from live premiums').first()).toBeVisible();
  await expect(page.getByText(/IV rank\/percentile need 252 sessions/).first()).toBeVisible();
  await shot(page, info, 'iv-chart');
  await clean(page, watch);
});

test('paper market order fills at the live ask and shows in positions', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/positions', /Positions & Orders/);
  await expect(page.getByText('LTP 81.90')).toBeVisible({ timeout: 20_000 }); // NIFTY 13-Oct 25000 CE (ATM)
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  const ticket = page.getByRole('dialog');
  await expect(ticket).toContainText('Paper order');
  await expect(ticket.getByLabel('Live quote')).toContainText('Ask 81.95');
  await ticket.getByRole('button', { name: 'Buy 1 lot' }).click();
  await expect(ticket).toContainText('Executed 75 @ ₹81.95', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tab', { name: 'Positions (1)' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: /Orders \(1\)/ }).click();
  await expect(page.getByRole('row', { name: /25000 CE/ }).first()).toContainText('81.95');
  await page.getByRole('tab', { name: 'Positions (1)' }).click();
  await shot(page, info, 'positions');
  await clean(page, watch);
});

test('strategy wizard → builder (live premiums) → paper execute → positions', async ({ page }) => {
  const watch = watchErrors(page);
  await open(page, '/templates', /Strategy Wizard/);
  await page.getByRole('tab', { name: '↔ Neutral' }).click();
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Iron Condor', exact: true }) });
  await card.getByRole('button', { name: 'Open in builder' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Strategy Builder');
  await expect(page.getByText('Max profit').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Probability of profit').first()).toBeVisible();
  await page.getByRole('button', { name: '⚡ Execute (paper)' }).click();
  await expect(page.getByText(/4\/4 legs executed/)).toBeVisible({ timeout: 15_000 });
  await page.goto('/positions');
  await expect(page.getByRole('tab', { name: /Positions \(\d+\)/ })).toBeVisible({ timeout: 15_000 });
  await clean(page, watch);
});

test('optimizer ranks strategies on live premiums', async ({ page }) => {
  const watch = watchErrors(page);
  await open(page, '/optimizer', /Strategy Optimizer/);
  await page.getByRole('button', { name: /Find best strategies/ }).click();
  await expect(page.getByText(/Scanned [\d,]+ combinations/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Open in builder/ }).first()).toBeVisible();
  await clean(page, watch);
});

test('algo: one-day backtest replays only a recorded session', async ({ page }) => {
  const watch = watchErrors(page);
  await open(page, '/algo', /Algo Strategies/);
  await page.getByRole('tab', { name: 'Backtest · one day' }).click();
  // Today has no recorded chain: the reason, not a made-up replay.
  await expect(page.locator('main [role="status"]').filter({ hasText: 'No recorded NIFTY option chain for 2026-10-12' })).toBeVisible({ timeout: 20_000 });
  // The previous session was recorded (fixture): it replays.
  await page.getByRole('textbox', { name: 'Session date' }).fill('2026-10-09');
  await expect(page.getByText('Trade log')).toBeVisible({ timeout: 20_000 });
  await clean(page, watch);
});
