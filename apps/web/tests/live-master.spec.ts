/**
 * LIVE-EMPTY with a cached instrument master: the production bundle, offline and without Kotak
 * credentials, started from a same-day cached scrip master (TEST rows, see playwright.config.ts).
 * Contracts are known but nothing is priced: the order ticket refuses to send with the reason, and a
 * paper market order that reaches the server is rejected with "No live bid/ask" — never filled at a
 * made-up price — and the order list shows that reason.
 */
import { expect, test } from '@playwright/test';
import { FORBIDDEN_TEXT, pageText, watchErrors } from './support/helpers';

test('paper market order without a live book: the ticket is blocked and the server rejects it with "No live bid/ask"', async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto('/positions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Positions & Orders/, { timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Feed status: OFFLINE' })).toBeVisible();

  // The ticket (a future: no chain is needed to pick it) opens but will not send: there is no live price.
  await page.getByRole('tab', { name: 'Future' }).click();
  await expect(page.getByRole('combobox', { name: 'Expiry' })).toBeEnabled({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  const ticket = page.getByRole('dialog');
  await expect(ticket).toContainText('Paper order');
  const send = ticket.getByRole('button', { name: /^Buy \d+ lots?$/ });
  await expect(send).toBeDisabled();
  await expect(ticket.getByRole('status')).toHaveText(/market is closed|No live price/);
  await page.keyboard.press('Escape');

  // The same market order sent anyway (as a stale client would): rejected by the server, with the reason.
  const order = await page.evaluate(async () => {
    const token = localStorage.getItem('q26-token');
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const exp = (await (await fetch('/api/expiries/NIFTY')).json()) as { options: string[] };
    const res = await fetch('/api/broker/orders', { method: 'POST', headers, body: JSON.stringify({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: exp.options[0], side: 'BUY', lots: 1, orderType: 'MARKET' }) });
    return { status: res.status, body: (await res.json()) as { status: string; message?: string; filledQty: number } };
  });
  expect(order.status).toBe(200);
  expect(order.body).toMatchObject({ status: 'REJECTED', filledQty: 0 });
  expect(order.body.message).toMatch(/^No live bid\/ask for NIFTY .* 25000 CE/);

  await page.reload();
  await page.getByRole('tab', { name: /Orders \(1\)/ }).click({ timeout: 20_000 });
  await expect(page.getByText(/No live bid\/ask for NIFTY .*25000 CE/).first()).toBeVisible();
  await expect(page.getByText(/rejected/i).first()).toBeVisible();
  expect((await pageText(page)).match(FORBIDDEN_TEXT)?.[0] ?? null).toBeNull();
  expect(await watch.check()).toEqual([]);
});

test('option chain with a master but no feed: the reason, not an empty table', async ({ page }) => {
  const watch = watchErrors(page);
  await page.goto('/option-chain');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Option Chain/, { timeout: 20_000 });
  await expect(page.getByText('Loading…')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('main [role="status"]').first()).toContainText(/Kotak credentials missing|No live/);
  expect((await pageText(page)).match(FORBIDDEN_TEXT)?.[0] ?? null).toBeNull();
  expect(await watch.check()).toEqual([]);
});
