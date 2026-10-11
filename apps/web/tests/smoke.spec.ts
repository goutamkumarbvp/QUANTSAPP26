import { expect, test, type Page } from '@playwright/test';

const ROUTES: [string, RegExp][] = [
  ['/', /Market Overview/],
  ['/tools', /All Tools/],
  ['/option-chain', /Option Chain/],
  ['/watchlist', /Watchlist/],
  ['/synopsis', /Synopsis/],
  ['/fii-dii', /FII \/ DII Activity/],
  ['/participants', /Participant-wise OI/],
  ['/oi/strikes', /Open Interest Analysis/],
  ['/oi/multi-strike', /Multi-Strike OI/],
  ['/oi/trend', /OI Trend/],
  ['/oi/pcr', /Put-Call Ratio/],
  ['/oi/max-pain', /Max Pain/],
  ['/oi/futures', /Futures OI/],
  ['/oi/breadth', /Build-up Breadth/],
  ['/vol/iv-chart', /IV Chart/],
  ['/vol/ivp', /IV Rank/],
  ['/vol/skew', /Volatility Skew/],
  ['/vol/surface', /Volatility Surface/],
  ['/vol/cone', /Volatility Cone/],
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
  ['/order-book', /Order Book Analytics/],
  ['/calculators', /Calculators/],
  ['/learn', /Options Classroom/],
  ['/learn/greeks', /The Greeks/],
  ['/settings', /Settings/],
];

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|WebSocket|ERR_ABORTED/i.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return errors;
}

for (const [path, title] of ROUTES) {
  test(`renders ${path}`, async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title, { timeout: 20_000 });
    await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 20_000 });
    await page.waitForTimeout(600);
    // No horizontal page scroll (tables scroll inside their own containers).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'page should not scroll horizontally').toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

test('option chain → builder → paper execute → positions', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/templates');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Strategy Wizard/);
  await page.getByRole('tab', { name: '↔ Neutral' }).click();
  const card = page.locator('section', { has: page.getByRole('heading', { name: 'Iron Condor', exact: true }) });
  await card.getByRole('button', { name: 'Open in builder' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Strategy Builder');
  await expect(page.getByText('Max profit')).toBeVisible();
  await expect(page.getByText('Probability of profit')).toBeVisible();
  await page.getByRole('button', { name: '⚡ Execute (paper)' }).click();
  await expect(page.getByText(/4\/4 legs executed/)).toBeVisible({ timeout: 15_000 });
  await page.goto('/positions');
  await expect(page.getByRole('tab', { name: /Positions \(4\)/ })).toBeVisible({ timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('optimizer returns ranked strategies', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/optimizer');
  await page.getByRole('button', { name: /Find best strategies/ }).click();
  await expect(page.getByText(/Scanned [\d,]+ combinations/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Open in builder/ })).toBeVisible();
  expect(errors).toEqual([]);
});
