/**
 * Phase C review, lens "no synthetic value anywhere": regressions for values that were presented as
 * data although no live/official/recorded source backs them. Runs on the TEST-ONLY FakeProvider +
 * loadSampleBook; every input below (quotes, recorded minutes, official rows) is test data built here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs } from '@q26/core';
import type { MinuteRecord } from '../src/live/types';
import { Analytics } from '../src/services/analytics';
import { buildOptionChain, futKey, futuresQuotesAt, optKey, spotKey, underlyingQuoteAt } from '../src/services/live';
import { Pricer } from '../src/services/pricer';
import { PaperBroker } from '../src/services/trading';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const MIN = 60_000;
const at = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

function setup() {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p);
  return { p, book };
}

/** Traded minute records from `from` (inclusive) to `to` (exclusive), flat at `price` (test data). */
function minutes(p: FakeProvider, date: string, from: string, to: string, price: number, extra: Partial<MinuteRecord> = {}): MinuteRecord[] {
  const out: MinuteRecord[] = [];
  for (let t = at(date, from); t < at(date, to); t += MIN) out.push({ ts: t, open: price, high: price + 1, low: price - 1, close: price, traded: true, ...extra });
  return out;
}

describe('as-of (?at=) quotes never present a partial or older recording as the session / the requested time', () => {
  it('underlying: open/high/low only when the recording covers the open; ts is the time of the recorded price', () => {
    const { p, book } = setup();
    const d = book.recordedDate;
    // RELIANCE was recorded from 11:00 to 11:59 only.
    p.intraday.addMinutes(spotKey('RELIANCE'), minutes(p, d, '11:00', '12:00', 1400));
    // (Asked at 12:01, right after the recording ended: at 14:00 nothing was recorded, see the as-of tests below.)
    const q = underlyingQuoteAt(p, 'RELIANCE', at(d, '12:01'));
    expect(q.ltp).toBe(1400);
    // The 11:00 minute is not the session's open, and 11:00–11:59 is not the day's range.
    expect([q.open, q.high, q.low]).toEqual([null, null, null]);
    // The price is the 11:59 minute's close, stamped with that minute (never with the time asked).
    expect(q.ts).toBe(at(d, '11:59'));
    // Two hours later the recorder was not running: no quote, not the 11:59 price presented as 14:00's.
    expect(() => underlyingQuoteAt(p, 'RELIANCE', at(d, '14:00'))).toThrow(/Nothing recorded for RELIANCE at 14:00 on .*last recorded minute 11:59.*not running/);

    // BANKNIFTY: recorded from 09:15, but its first trade minute is 10:00 (quote-only minutes before):
    // the 10:00 minute is not the session's open either.
    p.intraday.addMinutes(spotKey('BANKNIFTY'), minutes(p, d, '09:15', '10:00', 56000, { traded: false }));
    p.intraday.addMinutes(spotKey('BANKNIFTY'), minutes(p, d, '10:00', '12:00', 56100));
    const bn = underlyingQuoteAt(p, 'BANKNIFTY', at(d, '12:00'));
    expect(bn.ltp).toBe(56100);
    expect([bn.open, bn.high, bn.low]).toEqual([null, null, null]);

    // NIFTY is recorded from 09:15: the recorded open/high/low are the session's.
    const t = at(d, '12:00');
    const n = underlyingQuoteAt(p, 'NIFTY', t);
    const recs = p.intraday.bars(spotKey('NIFTY'), d).filter((r) => r.ts + MIN <= t);
    expect(n.open).toBe(recs[0].open);
    expect(n.high).toBe(Math.max(...recs.map((r) => r.high)));
    expect(n.low).toBe(Math.min(...recs.map((r) => r.low)));
    expect(n.ts).toBe(recs.at(-1)!.ts);
  });

  it('futures: the session volume is not the sum of a recording that started after the open', () => {
    const { p, book } = setup();
    const d = book.recordedDate;
    const m1 = book.expiries.RELIANCE[0];
    p.intraday.addMinutes(futKey('RELIANCE', m1), minutes(p, d, '11:00', '12:00', 1405, { volume: 1_000, oi: 900_000 }));
    const [row] = futuresQuotesAt(p, 'RELIANCE', at(d, '12:00'));
    expect(row.ltp).toBe(1405);
    expect(row.oi).toBe(900_000);
    expect(row.volume).toBeNull(); // 60,000 recorded since 11:00 is not the session's volume
    expect(row.ts).toBe(at(d, '11:59'));
    // Recorded from 09:15: the recorded volume is the session's.
    const [nifty] = futuresQuotesAt(p, 'NIFTY', at(d, '10:00'));
    expect(nifty.volume).toBe(3000 * 45);
  });

  it('chain: a recorded bid/ask is used (display, mid IV) only when it was recorded in the minute just completed', async () => {
    const { p, book } = setup();
    const d = book.recordedDate;
    const e = book.expiries.BANKNIFTY[0];
    p.intraday.addMinutes(spotKey('BANKNIFTY'), minutes(p, d, '09:15', '15:30', 56000));
    // CE 56000: last recorded at 10:00 (book of 10:00). PE 56000: recorded in the 11:59 minute.
    p.intraday.addMinutes(optKey('BANKNIFTY', e, 'CE', 56000), [{ ts: at(d, '10:00'), open: 800, high: 800, low: 800, close: 800, traded: true, volume: 35, oi: 50_000, bid: 799, ask: 801 }]);
    p.intraday.addMinutes(optKey('BANKNIFTY', e, 'PE', 56000), [{ ts: at(d, '11:59'), open: 790, high: 790, low: 790, close: 790, traded: true, volume: 35, oi: 60_000, bid: 789, ask: 791 }]);
    const c = await buildOptionChain(p, 'BANKNIFTY', e, { at: at(d, '12:00') });
    const row = c.rows.find((r) => r.strike === 56000)!;
    expect(row.ce.ltp).toBe(800); // the last traded price as of 12:00 (traded at 10:00)
    expect(row.ce.ts).toBe(at(d, '10:00'));
    expect([row.ce.bid, row.ce.ask]).toEqual([null, null]); // a 10:00 book is not the 12:00 book
    expect(row.ce.ivSource).not.toBe('mid');
    expect([row.pe.bid, row.pe.ask]).toEqual([789, 791]);
    expect(row.pe.ivSource).toBe('mid');
  });
});

describe('as-of (?at=): a time at which the recorder was not running is not answered with the last recorded values', () => {
  /** BANKNIFTY recorded 09:15–10:00 only (spot, the 56000 CE/PE of its first expiry, the future, the chain minutes). */
  function bankNiftyUntil10(p: FakeProvider, book: ReturnType<typeof loadSampleBook>, spotUntil = '10:00') {
    const d = book.recordedDate;
    const e = book.expiries.BANKNIFTY[0];
    p.intraday.addMinutes(spotKey('BANKNIFTY'), minutes(p, d, '09:15', spotUntil, 56000));
    p.intraday.addMinutes(futKey('BANKNIFTY', e), minutes(p, d, '09:15', '10:00', 56050, { volume: 100, oi: 400_000 }));
    for (const type of ['CE', 'PE'] as const) p.intraday.addMinutes(optKey('BANKNIFTY', e, type, 56000), minutes(p, d, '09:15', '10:00', 800, { oi: 50_000, volume: 10 }));
    p.intraday.addChainMinutes(
      'BANKNIFTY',
      e,
      minutes(p, d, '09:15', '10:00', 0).map((r) => ({ ts: r.ts, spot: 56000, ceOi: 50_000, peOi: 50_000, ceVolume: 10, peVolume: 10, pcr: 1, maxPain: 56000, atmStrike: 56000, atmIv: 0.16 })),
    );
    return { d, e };
  }

  it('chain: the spot (and the aggregates) of a time after the recording ended is a 503 naming the last recorded minute; the recorded spot time is in the chain', async () => {
    const { p, book } = setup();
    const { d, e } = bankNiftyUntil10(p, book);
    // At 10:00 the 09:59 minute has just completed; one minute later it is still the minute before.
    for (const hhmm of ['10:00', '10:01']) {
      const c = await buildOptionChain(p, 'BANKNIFTY', e, { at: at(d, hhmm) });
      expect(c.spot).toBe(56000);
      expect(c.spotTs).toBe(at(d, '09:59')); // the recorded minute the spot comes from
      expect(c.ts).toBe(at(d, hhmm));
    }
    // From 10:02 the recorder was not running: not the 09:59 spot, PCR and ATM IV presented as 10:02's / 14:00's / the close's.
    for (const hhmm of ['10:02', '14:00', '16:00']) {
      await expect(buildOptionChain(p, 'BANKNIFTY', e, { at: at(d, hhmm) }), hhmm).rejects.toMatchObject({
        name: 'NoLiveData',
        message: expect.stringMatching(new RegExp(`^Nothing recorded for BANKNIFTY at ${hhmm === '16:00' ? '15:30' : hhmm} on ${d} \\(last recorded minute 09:59\\)`)),
      });
    }
    // Control: NIFTY was recorded to the close; after it the answer is the 15:29 minute's (15:30 is the end of the session).
    const n = await buildOptionChain(p, 'NIFTY', book.expiries.NIFTY[0], { at: at(d, '16:00') });
    expect(n.spotTs).toBe(at(d, '15:29'));
  });

  it('chain: without a recorded spot the newest recorded leg decides', async () => {
    const { p, book } = setup();
    const d = book.recordedDate;
    const e = book.expiries.BANKNIFTY[0];
    for (const type of ['CE', 'PE'] as const) p.intraday.addMinutes(optKey('BANKNIFTY', e, type, 56000), minutes(p, d, '09:15', '10:00', 800, { oi: 50_000, volume: 10 }));
    const c = await buildOptionChain(p, 'BANKNIFTY', e, { at: at(d, '10:00') });
    expect(c.spot).toBeNull();
    expect(c.spotTs).toBeNull();
    await expect(buildOptionChain(p, 'BANKNIFTY', e, { at: at(d, '14:00') })).rejects.toMatchObject({ message: expect.stringMatching(/Nothing recorded for BANKNIFTY .* options at 14:00 .*last recorded minute 09:59/) });
  });

  it('underlying quote: a spot not recorded just before `at` is a 503; a future or ATM IV not recorded then is blank', () => {
    const { p, book } = setup();
    const { d } = bankNiftyUntil10(p, book, '12:00'); // spot to 12:00, the rest to 10:00
    const near = underlyingQuoteAt(p, 'BANKNIFTY', at(d, '10:00'));
    expect([near.future, near.atmIv, near.ts]).toEqual([56050, 16, at(d, '09:59')]);
    const later = underlyingQuoteAt(p, 'BANKNIFTY', at(d, '12:00'));
    expect(later.ltp).toBe(56000);
    expect(later.ts).toBe(at(d, '11:59'));
    expect(later.future).toBeNull(); // the 09:59 future price is not the future at 12:00
    expect(later.futureExpiry).toBe(book.expiries.BANKNIFTY[0]);
    expect(later.atmIv).toBeNull();
    expect(() => underlyingQuoteAt(p, 'BANKNIFTY', at(d, '14:00'))).toThrow(/Nothing recorded for BANKNIFTY at 14:00 .*last recorded minute 11:59/);
  });

  it('futures: a spot not recorded just before `at` is a 503; a future recorded earlier keeps its own minute and has no basis', () => {
    const { p, book } = setup();
    const { d } = bankNiftyUntil10(p, book, '12:00');
    const [row] = futuresQuotesAt(p, 'BANKNIFTY', at(d, '10:00'));
    expect([row.ltp, row.basis, row.ts]).toEqual([56050, 50, at(d, '09:59')]);
    // At 12:00 the spot is current, the future's last record is 09:59: its price is stamped 09:59 and no basis against 12:00's spot.
    const [later] = futuresQuotesAt(p, 'BANKNIFTY', at(d, '12:00'));
    expect([later.ltp, later.ts, later.basis]).toEqual([56050, at(d, '09:59'), null]);
    expect(() => futuresQuotesAt(p, 'BANKNIFTY', at(d, '14:00'))).toThrow(/Nothing recorded for BANKNIFTY at 14:00 .*last recorded minute 11:59/);
    // No spot recorded at all: the newest future decides.
    const q = setup();
    q.p.intraday.addMinutes(futKey('RELIANCE', q.book.expiries.RELIANCE[0]), minutes(q.p, q.book.recordedDate, '09:15', '10:00', 1405, { volume: 10 }));
    expect(() => futuresQuotesAt(q.p, 'RELIANCE', at(q.book.recordedDate, '14:00'))).toThrow(/Nothing recorded for RELIANCE futures at 14:00 .*last recorded minute 09:59/);
    expect(futuresQuotesAt(q.p, 'RELIANCE', at(q.book.recordedDate, '10:00'))[0].ltp).toBe(1405);
  });
});

describe('recorded OI trend', () => {
  it('OI change sums every recorded strike as of each point, not only the strikes that ticked inside the window', () => {
    const p = new FakeProvider();
    providers.push(p);
    const book = loadSampleBook(p);
    const an = new Analytics(p, new Pricer(p));
    const d = book.recordedDate;
    const prev = p.calendar.prev(d);
    const w1 = book.expiries.NIFTY[0];
    // 25550 CE (outside the sample's recorded band) ticked once, at 09:20, with OI 4,000.
    p.intraday.addMinutes(optKey('NIFTY', w1, 'CE', 25550), [{ ts: at(d, '09:20'), open: 5, high: 5, low: 5, close: 5, traded: true, volume: 75, oi: 4_000 }]);
    // Official previous-close OI: 25000 CE 5,000 below the recorded 100,000; 25550 CE 1,000.
    p.history.writeFo(prev, {
      options: [
        { symbol: 'NIFTY', date: prev, expiry: w1, strike: 25000, type: 'CE', close: 120, oi: 95_000, volume: 10 },
        { symbol: 'NIFTY', date: prev, expiry: w1, strike: 25550, type: 'CE', close: 4, oi: 1_000, volume: 10 },
      ],
    });
    const r = an.oiTrend('NIFTY', w1, d, 15);
    // From 09:30 on, both strikes' OI is known: 5,000 + 3,000 at every point (nothing changed later).
    expect(r.points.length).toBeGreaterThan(5);
    expect(new Set(r.points.map((x) => x.ceChange))).toEqual(new Set([8_000]));
  });
});

describe('build-up breadth', () => {
  it('no counts (not a row of zeros) while no stock future has a live build-up', () => {
    const { p, book } = setup();
    const an = new Analytics(p, new Pricer(p));
    let b = an.breadth();
    expect([b.classified, b.total]).toEqual([0, 1]);
    expect(b.overall).toBeNull();
    expect(b.sectors).toHaveLength(1);
    expect(b.sectors[0].counts).toBeNull();
    expect(b.sectors[0].symbols.map((x) => x.symbol)).toEqual(['RELIANCE']);
    expect(b.gaps?.overall).toMatch(/1 of 1 stock futures have no live price\/OI change/);

    const m1 = book.expiries.RELIANCE[0];
    p.setQuote(futKey('RELIANCE', m1), { ltp: book.futures[`RELIANCE|${m1}`], prevClose: 1380, prevOi: 1_000_000 });
    p.advance(5_000); // the futures snapshot is cached for 5 s
    b = an.breadth();
    expect(b.classified).toBe(1);
    expect(b.overall).toMatchObject({ 'Long Build-up': 1, 'Short Build-up': 0 });
    expect(b.sectors[0].counts).toMatchObject({ 'Long Build-up': 1 });
  });
});

describe('paper broker', () => {
  it('an insufficient-funds rejection never shows ₹0 as the available funds when they are unknown', () => {
    const { p, book } = setup();
    const db = new Db(null);
    const broker = new PaperBroker(p, db, new Pricer(p), () => p.now(), () => undefined, () => undefined);
    const w1 = book.expiries.NIFTY[0];
    const key = optKey('NIFTY', w1, 'CE', 25300);
    const q = p.live.quote(key)!;
    // A live two-sided book, but no trade in this session yet (session volume 0): no live LTP.
    p.setQuote(key, { ltp: q.ltp, bid: q.bid, ask: q.ask, volume: 0, oi: q.oi });
    const order = { symbol: 'NIFTY', type: 'CE' as const, strike: 25300, expiry: w1, side: 'SELL' as const, lots: 1, orderType: 'MARKET' as const, product: 'NRML' as const };
    expect(broker.place('u1', order).status).toBe('COMPLETE');
    // The short leg has no live price: its loss cannot be blocked, so the available funds are unknown.
    expect(broker.funds('u1').available).toBeNull();
    (db.data.users as Record<string, unknown>).u1 = { openingBalance: 50_000 };
    const o2 = broker.place('u1', { ...order, lots: 2 });
    expect(o2.status).toBe('REJECTED');
    expect(o2.message).toMatch(/^Insufficient funds/);
    expect(o2.message).not.toMatch(/available ₹0\b/);
    expect(o2.message).toMatch(/available funds unknown/);
  });
});
