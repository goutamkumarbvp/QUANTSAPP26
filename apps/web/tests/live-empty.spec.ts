/**
 * LIVE-EMPTY mode: the production server bundle with no Kotak credentials, an empty data dir and no
 * network (playwright.config.ts). The app runs on live data only, so every page must render its
 * title and blank states with the reason — never a number standing in for missing data, never
 * NaN/undefined/Infinity, never simulated wording — and the feed chip must say OFFLINE and why.
 */
import { expect, test } from '@playwright/test';
import { FORBIDDEN_TEXT, pageText, shot, watchErrors } from './support/helpers';

const ROUTES: [string, RegExp][] = [
  ['/', /Market Overview/],
  ['/tools', /All Tools/],
  ['/option-chain', /Option Chain/],
  ['/nifty-top10', /NIFTY Top 10 — F&O Desk/],
  ['/watchlist', /Watchlist/],
  ['/fno-market', /Synopsis/],
  // Merged tabs: the old addresses redirect to the tab that now holds their data.
  ['/synopsis', /Synopsis/],
  ['/fii-dii', /FII \/ DII Activity/],
  ['/participants', /Participant-wise OI/],
  ['/oi/strikes', /Open Interest Analysis/],
  ['/oi/multi-strike', /Multi-Strike OI/],
  ['/oi/trend', /PCR & OI Trend/],
  ['/oi/pcr', /PCR & OI Trend/],
  ['/oi/max-pain', /Max Pain/],
  ['/oi/futures', /Futures OI/],
  ['/oi/breadth', /Build-up Breadth/],
  ['/expected-range', /Expected Range/],
  ['/builder', /Strategy Builder/],
  ['/templates', /Strategy Wizard/],
  ['/optimizer', /Strategy Optimizer/],
  ['/straddle', /Straddle Chart/],
  ['/strategy-chart', /Strategy Chart/],
  ['/recap', /Trade Recap/],
  ['/positions', /Positions & Orders/],
  ['/strategies', /Strategy Manager/],
  ['/alerts', /Alerts/],
  ['/scanners', /F&O Scanners/],
  ['/unusual', /Unusual Option Activity/],
  ['/order-book', /Order Flow & Book/],
  ['/orb', /Opening Range Breakout/],
  ['/order-flow', /Order Flow & Book/],
  ['/learn/opening-range-order-flow', /Opening range breakout/],
  ['/algo', /Algo Strategies/],
  ['/learn/algo-premium-ladder', /premium ladder short strangle/],
  ['/calculators', /Calculators/],
  ['/learn', /Options Classroom/],
  ['/learn/greeks', /The Greeks/],
  ['/settings', /Settings/],
];

/**
 * Pages with no market data on first load — tools index, lessons, calculators, settings, and pages that
 * start from the user's own input or lists (optimizer form, builder legs, saved strategies, alerts,
 * algo library): no blank state is expected there before the user acts.
 */
const NO_DATA_ON_LOAD = new Set([
  '/tools', '/learn', '/learn/greeks', '/learn/opening-range-order-flow', '/learn/algo-premium-ladder', '/calculators', '/settings', '/templates',
  '/optimizer', '/strategy-chart', '/strategies', '/alerts', '/algo',
]);

/** Desktop screenshots of key pages for the run's review (E2E_SHOTS_DIR). */
const SHOTS: Record<string, string> = { '/': 'home', '/option-chain': 'option-chain', '/positions': 'positions', '/scanners': 'scanners', '/vol/iv-chart': 'iv-chart', '/order-book': 'order-book', '/fno-market': 'fno-market' };

const CREDENTIALS_MISSING = /Kotak credentials missing/;

for (const [path, title] of ROUTES) {
  test(`renders ${path} with blank states and reasons`, async ({ page }, info) => {
    const watch = watchErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title, { timeout: 20_000 });
    await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(600);
    // No horizontal page scroll (tables scroll inside their own containers).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
    // Nothing live: the feed is OFFLINE and the reason is on the page (banner under the header).
    await expect(page.getByRole('button', { name: 'Feed status: OFFLINE' })).toBeVisible();
    await expect(page.getByText(CREDENTIALS_MISSING).first()).toBeVisible();
    if (!NO_DATA_ON_LOAD.has(path)) {
      // A data page shows a blank state (with the server's reason) or blank values, never a stand-in number.
      const blanks = page.locator('main [role="status"], main [aria-label^="Not available"]');
      expect(await blanks.count(), 'a data page shows blank states').toBeGreaterThan(0);
    }
    const text = await pageText(page);
    expect(text.match(FORBIDDEN_TEXT)?.[0] ?? null, 'no NaN/undefined/Infinity/simulated text').toBeNull();
    if (SHOTS[path]) await shot(page, info, SHOTS[path]);
    expect(await watch.check()).toEqual([]);
  });
}

test('feed chip: OFFLINE with the reason, and the details name the missing credentials', async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto('/');
  const chip = page.getByRole('button', { name: 'Feed status: OFFLINE' });
  await expect(chip).toBeVisible({ timeout: 20_000 });
  await expect(chip).toHaveAttribute('title', /OFFLINE — .*Kotak credentials missing in \.env: NEO_CONSUMER_KEY/);
  await chip.click();
  const details = page.getByRole('dialog', { name: 'Live feed status' });
  await expect(details).toBeVisible();
  await expect(details).toContainText(CREDENTIALS_MISSING);
  expect(await watch.check()).toEqual([]);
});

test('home: no index value, no chain figure, only reasons', async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Market Overview/);
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 20_000 });
  // Nothing on the page may look like a market price: no "25,000"-style figure, no ₹ amount.
  const main = (await page.locator('main').innerText()).replace(/\b20\d\d\b/g, '');
  expect(main.match(/₹\s?\d|\d{1,3}(,\d{2,3})+(\.\d+)?/)?.[0] ?? null).toBeNull();
  expect(await watch.check()).toEqual([]);
});

test('home: the Operations panel shows no broker, no data, paper trading only, and its three buttons', async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Market Overview/, { timeout: 20_000 });
  const ops = page.locator('section', { has: page.getByRole('heading', { level: 2, name: 'Operations', exact: true }) });
  await expect(ops).toBeVisible({ timeout: 20_000 });
  for (const chip of ['DISCONNECTED', 'DATA UNAVAILABLE', 'PAPER TRADING', 'NOT READY']) await expect(ops.getByText(chip, { exact: true })).toBeVisible();
  // Empty NEO_*: the login monitor says so.
  await expect(ops.getByRole('region', { name: 'Login Monitor' }).getByText('NO_CREDENTIALS', { exact: true })).toBeVisible();
  for (const name of ['Re-login now', 'Run health check', 'Run audit now']) {
    const button = ops.getByRole('button', { name, exact: true });
    await expect(button).toBeVisible();
    // The e2e session is a guest: the server answers operator.canOperate=false, and its reason is the
    // visible text under the button (the button's description).
    await expect(button).toBeDisabled();
    const reason = ops.locator(`[id="${await button.getAttribute('aria-describedby')}"]`);
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/registered account|operator/i);
  }
  expect(await watch.check()).toEqual([]);
});

/*
 * The old paper-trading, optimizer and algo journeys need live prices; they run in fixture.spec.ts
 * (FIXTURE server). Here, with no master, the ticket cannot be opened: see live-master.spec.ts for
 * the "No live bid/ask" rejection with a cached instrument master and no feed.
 */
