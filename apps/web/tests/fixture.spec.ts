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
  // The fixture server runs no operations (GET /api/ops is a 404): a neutral note, not an error.
  await expect(page.getByText('Operations are not running on this server')).toBeVisible();
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
  await expect(page.getByText(/17 of 17 near-month futures/).first()).toBeVisible(); // NIFTY, BANKNIFTY, SENSEX, RELIANCE, the 9 test heavyweights + MCX CRUDEOIL, GOLD, SILVER, NATURALGAS
  await shot(page, info, 'scanners');
  // Unusual option activity is a view of the same tab; its old address redirects there
  await page.goto('/unusual');
  await expect(page).toHaveURL(/\/scanners\?view=unusual/);
  await expect(page.getByRole('heading', { name: 'Unusual Option Activity' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/participants');
  await expect(page).toHaveURL(/\/institutions\?view=participants/);
  await expect(page.getByRole('heading', { name: 'Participant-wise OI' })).toBeVisible({ timeout: 20_000 });
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
  await open(page, '/order-book', /Order Flow & Book/);
  await expect(page.getByText(/is estimated from live ticks \(quote rule\)/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Buyers dominant').first()).toBeVisible();
  await expect(page.getByText(/feed gap: 1\.2K not counted/).first()).toBeVisible();
  await expect(page.getByText(/partial \(lower bound\)/).first()).toBeVisible();
  await shot(page, info, 'order-flow');
  await clean(page, watch);
});

test('order book: Order & Trade chart — 1-min candles with buyer vs seller initiated quantity and a direction read', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/order-book', /Order Flow & Book/);
  const card = page.locator('section', { hasText: 'Order & Trade chart' });
  await expect(card.getByText(/Order & Trade chart — NIFTY/)).toBeVisible({ timeout: 20_000 });
  await expect(card.getByText(/^Read · last \d+ min$/)).toBeVisible();
  await expect(card.getByText(/Buyers in control|Sellers in control|Buying absorbed|Selling absorbed|Balanced/).first()).toBeVisible();
  await expect(card.getByText(/Spike = at least 3× the median/)).toBeVisible();
  await expect(card.locator('canvas').first()).toBeVisible();
  // Buyer and seller initiated quantity are superimposed on ONE scale (no separate panes).
  await expect(card.getByRole('tab', { name: 'Two panes' })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await shot(page, info, 'order-trade-chart');
  await clean(page, watch);
});

test('MCX commodities are ordinary symbols: home card, ticker, picker group and the option chain priced on the future (test contracts)', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/', /Market Overview/);
  await expect(page.getByText('Commodities · MCX')).toBeVisible();
  await expect(page.getByRole('button', { name: /CRUDEOIL/ }).first()).toBeVisible();
  // The old MCX tab address opens the Option Chain on a commodity.
  await open(page, '/mcx-chain', /Option Chain/);
  await expect(page.getByRole('button', { name: 'Select symbol' })).toHaveText(/CRUDEOIL/);
  await page.getByRole('button', { name: 'Select symbol' }).click();
  await expect(page.getByText('Commodities (MCX)')).toBeVisible();
  await expect(page.getByText('Indices (NSE · BSE)')).toBeVisible();
  await page.getByPlaceholder(/Search NIFTY, GOLD/).fill('CRUDE');
  await page.getByRole('listbox').getByRole('button', { name: /^CRUDEOIL/ }).click();
  const atm = page.getByRole('row', { name: /5,500/ }).first();
  await expect(atm).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('5,480.00').first()).toBeVisible(); // the near-month future = the commodity price
  await expect(atm).toContainText('38.0'); // IV solved by Black-76 on the future the expiry settles into (test vol 38 %)
  await shot(page, info, 'mcx-option-chain');
  await clean(page, watch);
});

test('Market Terminal: price with EMA, total CE vs PE OI with build-up, PCR (OI & COI) and volume vs OI blocks (test data)', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/terminal', /Market Terminal/);
  for (const t of ['Price Chart (NIFTY)', 'Total OI (CE vs PE) with build-up', 'PCR (OI & COI)', 'Volume vs OI Analysis']) await expect(page.getByText(t, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'MCX: CRUDE' })).toBeVisible();
  await expect(page.getByText(/^PCR OI \d/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^CE OI \d/).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await shot(page, info, 'market-terminal');
  await clean(page, watch);
});

test('PCR: change-in-OI PCR for today (put OI added ÷ call OI added) from the open', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/oi/pcr', /PCR & OI Trend/);
  // Today's test chain is recorded for the monthly expiry (the weekly stays unrecorded today).
  await page.getByRole('combobox', { name: 'Expiry' }).selectOption('2026-10-27');
  await expect(page.getByText(/Change-in-OI PCR — today only/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Put OI added today')).toBeVisible();
  await page.waitForTimeout(1500); // the line charts animate in
  await shot(page, info, 'pcr-change');
  await clean(page, watch);
});

test('NIFTY Top 10 desk: ten heavyweights with futures, options, flow and a bias with reasons (test stocks)', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/nifty-top10', /NIFTY Top 10 — F&O Desk/);
  const table = page.locator('table').first();
  await expect(table.locator('tbody tr')).toHaveCount(10, { timeout: 20_000 });
  for (const s of ['HDFCBANK', 'RELIANCE', 'ICICIBANK', 'INFY', 'TCS', 'SBIN']) await expect(table.getByText(s, { exact: true })).toBeVisible();
  await expect(page.getByText('Advancing / declining')).toBeVisible();
  await expect(page.getByText(/Bullish|Bearish|Neutral/).first()).toBeVisible();
  // A stock's readings: four votes, each with its reason.
  await table.getByText('HDFCBANK', { exact: true }).click();
  await expect(page.getByText('Bias readings')).toBeVisible();
  await expect(page.getByText(/^Future: /).first()).toBeVisible();
  await expect(page.getByText(/^Flow: /).first()).toBeVisible();
  await expect(page.getByText(/^Options: change PCR /).first()).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, info, 'nifty-top10');
  await clean(page, watch);
});

test('expected range: ±1σ / ±2σ of NIFTY and the MCX commodities from live ATM IV (test data)', async ({ page }, info) => {
  const watch = watchErrors(page);
  await open(page, '/expected-range', /Expected Range/);
  await expect(page.getByText('±1σ range (≈ 68 %)').first()).toBeVisible({ timeout: 20_000 });
  for (const s of ['NIFTY', 'SENSEX', 'GOLD', 'SILVER', 'NATURALGAS', 'CRUDEOIL']) await expect(page.getByLabel(`${s} expected range`)).toBeVisible();
  await expect(page.getByText(/^India VIX 12\.50 · today/).first()).toBeVisible();
  await expect(page.getByText('live premiums').first()).toBeVisible();
  await expect(page.getByText('Straddle-implied (option-chain method)').first()).toBeVisible();
  await shot(page, info, 'expected-range');
  await page.getByRole('button', { name: 'Details' }).first().click();
  await expect(page.getByText('Rest of today (±1 SD)')).toBeVisible();
  await expect(page.getByText('Close inside ±1 SD')).toBeVisible();
  await expect(page.getByText('Intraday forecast · NIFTY')).toBeVisible();
  await expect(page.getByText('Next 1 hour')).toBeVisible();
  await expect(page.getByText('India VIX method · NIFTY')).toBeVisible();
  await clean(page, watch);
});

test('menu: few sidebar entries; an entry opens its first page and its sub-tabs switch between the related pages', async ({ page }) => {
  const watch = watchErrors(page);
  await open(page, '/', /Market Overview/);
  const side = page.getByRole('navigation', { name: 'Main' });
  await expect(side.getByRole('link')).toHaveCount(13);
  await side.getByRole('link', { name: /F&O Market/ }).click();
  await expect(page).toHaveURL(/\/fno-market\?view=heatmap/);
  const tabs = page.getByRole('navigation', { name: 'F&O Market pages' });
  await expect(tabs.getByRole('link')).toHaveCount(6);
  await tabs.getByRole('link', { name: 'Unusual options' }).click();
  await expect(page).toHaveURL(/\/scanners\?view=unusual/);
  await expect(page.getByRole('heading', { name: 'Unusual Option Activity' })).toBeVisible({ timeout: 20_000 });
  await expect(tabs.getByRole('link', { name: 'Unusual options' })).toHaveAttribute('aria-current', 'page');
  await side.getByRole('link', { name: /Market Terminal/ }).click();
  await page.getByRole('navigation', { name: 'Market Terminal pages' }).getByRole('link', { name: 'Order Flow & Book' }).click();
  await expect(page).toHaveURL(/\/order-book$/);
  await expect(side.getByRole('link', { name: /Market Terminal/ })).toHaveAttribute('aria-current', 'page');
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
  // A session with nothing recorded (before the recording started): the reason, not a made-up replay.
  await page.getByRole('textbox', { name: 'Session date' }).fill('2026-10-08');
  await expect(page.locator('main [role="status"]').filter({ hasText: /2026-10-08/ }).filter({ hasText: /recorded|recording/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Trade log')).toHaveCount(0);
  // The previous session was recorded (fixture): it replays.
  await page.getByRole('textbox', { name: 'Session date' }).fill('2026-10-09');
  await expect(page.getByText('Trade log')).toBeVisible({ timeout: 20_000 });
  await clean(page, watch);
});
