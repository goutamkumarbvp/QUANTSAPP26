import { describe, expect, it } from 'vitest';
import {
  SFEED_DEFAULT_URL,
  buildAuthFrame,
  buildMarketStatusFrame,
  buildSnapshotFrame,
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  decodeBatch,
  decodePacket,
  feedTimeMs,
  inputToken,
  parseControlFrame,
  parseDividers,
  readHeader,
  resolveFeedUrl,
  splitBatch,
  toWebSocketUrl,
} from '../../src/live/kotak/sfeed/protocol';
import {
  ACK_DOC,
  ACK_SDK,
  AUTH_1117,
  AUTH_1119,
  AUTH_1120,
  AUTH_FALLBACK,
  MP_L4_FIELDS,
  VEC_BATCH,
  VEC_BATCH_TAIL,
  VEC_INDEX,
  VEC_MINI,
  VEC_MP_L4,
  VEC_STATUS,
  concat,
  encodeCas,
  encodeHeaderOnly,
  encodeIndex,
  encodeMarketPicture,
} from './fixtures/sfeed';

const DIV = parseDividers(AUTH_1119.exchanges);

describe('SFeed binary vectors (research §9)', () => {
  it('(a) decodes the official Mini touch-line worked example', () => {
    expect(readHeader(VEC_MINI)).toEqual({ length: 54, code: 7208, exchangeId: 1, level: 1, auction: 0, seq: 7, bitmaskLength: 0 });
    expect(decodePacket(VEC_MINI, DIV)).toEqual({
      kind: 'mini',
      exchangeId: 1,
      exchange: 'nse_cm',
      seq: 7,
      token: '11536',
      lttRaw: 1756636800,
      ltt: 1756636800_000,
      ltp: 1234.56,
      ltq: 50,
      // 122000 / 100: scaled, as SDK 3.0.7 and the doc's own arithmetic require (research §5.6).
      close: 1220,
      changePct: 1.19,
      change: 14.56,
      lotSize: 1,
      precision: 2,
      multiplier: 1,
    });
    expect(new Date(1756636800_000).toISOString()).toBe('2025-08-31T10:40:00.000Z');
  });

  it('(b) decodes the index packet', () => {
    expect(VEC_INDEX.byteLength).toBe(87);
    expect(decodePacket(VEC_INDEX, DIV)).toEqual({
      kind: 'index',
      exchangeId: 1,
      exchange: 'nse_cm',
      seq: 0,
      token: '26000',
      name: 'NIFTY 50',
      ltp: 20050,
      open: 20000,
      high: 20100,
      low: 19800,
      close: 19900,
      change: 150,
      changePct: 1.5,
      yearHigh: 21000,
      yearLow: 15000,
      lttRaw: 1234567890,
      ltt: 1234567890_000,
      precision: 2,
      multiplier: 100,
    });
  });

  it('(c) decodes the level-4 market picture incl. depth rows', () => {
    expect(VEC_MP_L4.byteLength).toBe(176);
    expect(decodePacket(VEC_MP_L4, DIV)).toEqual({
      kind: 'marketPicture',
      exchangeId: 2,
      exchange: 'nse_fo',
      seq: 0,
      level: 4,
      token: '44498',
      totalBuyQty: 1000,
      totalSellQty: 2000,
      volume: 50000,
      lttRaw: 1234567890,
      ltt: 1234567890_000,
      lutRaw: 1234567891,
      lut: 1234567891_000,
      open: 1500,
      close: 1490,
      high: 1510,
      low: 1480,
      ltp: 1500.5,
      ltq: 10,
      atp: 1500.25,
      buyDepthCount: 1,
      sellDepthCount: 1,
      changePct: 1.23,
      oi: 500,
      turnover: 12345.67,
      change: 1.05,
      upperCircuit: 1650,
      lowerCircuit: 1350,
      yearHigh: 2000,
      yearLow: 1000,
      lotSize: 75,
      precision: 2,
      multiplier: 1,
      auction: false,
      bids: [{ qty: 100, price: 1500, orders: 5 }],
      asks: [{ qty: 101, price: 1501, orders: 6 }],
    });
  });

  it('(d) splits a batch into packets and ignores a truncated tail', () => {
    expect(VEC_BATCH.byteLength).toBe(263);
    const parts = splitBatch(VEC_BATCH);
    expect(parts.map((p) => p.byteLength)).toEqual([87, 176]);
    expect(Buffer.from(parts[1]).equals(Buffer.from(VEC_MP_L4))).toBe(true);
    expect(splitBatch(VEC_BATCH_TAIL)).toHaveLength(2);
    expect(decodeBatch(VEC_BATCH_TAIL, DIV).map((p) => p.kind)).toEqual(['index', 'marketPicture']);
  });

  it('(e) decodes market status 105', () => {
    expect(decodePacket(VEC_STATUS, DIV)).toEqual({ kind: 'marketStatus', exchangeId: 1, exchange: 'nse_cm', seq: 0, statusCode: 1, name: 'OpenMessage', raw: 'OPEN' });
  });

  it('the test encoder reproduces vector (c) byte for byte', () => {
    expect(Buffer.from(encodeMarketPicture(MP_L4_FIELDS)).equals(Buffer.from(VEC_MP_L4))).toBe(true);
  });
});

describe('SFeed scaling and routing rules', () => {
  it('scales prices by the per-exchange divider from the auth response', () => {
    const custom = new Map([[2, 10_000]]);
    const p = decodePacket(VEC_MP_L4, custom);
    expect(p?.kind === 'marketPicture' && [p.ltp, p.turnover, p.bids[0].price, p.change, p.changePct]).toEqual([15.005, 123.4567, 15, 0.0105, 1.23]);
    // An exchange missing from the auth response defaults to 100 (official §3).
    const none = decodePacket(VEC_MP_L4, new Map());
    expect(none?.kind === 'marketPicture' && none.ltp).toBe(1500.5);
    // cde_fo (id 3) divider 10,000,000 from the production 1119 body.
    const cde = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, exch: 3, ltp: 834_567_890 }), DIV);
    expect(cde?.kind === 'marketPicture' && [cde.exchange, cde.ltp]).toEqual(['cde_fo', 83.456789]);
  });

  it('forces 1 bid + 1 ask at level 4 whatever the counts say', () => {
    const p = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, buyCount: 5, sellCount: 5 }), DIV);
    expect(p?.kind === 'marketPicture' && [p.bids.length, p.asks.length, p.buyDepthCount]).toEqual([1, 1, 5]);
  });

  it('reads N depth rows at level 8, bids first then asks', () => {
    const rows: [number, number, number][] = [];
    for (let i = 0; i < 5; i++) rows.push([100 + i, 150000 - 5 * i, i + 1]);
    for (let i = 0; i < 5; i++) rows.push([200 + i, 150010 + 5 * i, i + 11]);
    const p = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, level: 8, buyCount: 5, sellCount: 5, rows }), DIV);
    if (p?.kind !== 'marketPicture') throw new Error('expected market picture');
    expect(p.level).toBe(8);
    expect(p.bids).toEqual([
      { qty: 100, price: 1500, orders: 1 },
      { qty: 101, price: 1499.95, orders: 2 },
      { qty: 102, price: 1499.9, orders: 3 },
      { qty: 103, price: 1499.85, orders: 4 },
      { qty: 104, price: 1499.8, orders: 5 },
    ]);
    expect(p.asks).toEqual([
      { qty: 200, price: 1500.1, orders: 11 },
      { qty: 201, price: 1500.15, orders: 12 },
      { qty: 202, price: 1500.2, orders: 13 },
      { qty: 203, price: 1500.25, orders: 14 },
      { qty: 204, price: 1500.3, orders: 15 },
    ]);
  });

  it('stops reading rows at message_length and survives absurd counts', () => {
    const rows: [number, number, number][] = [[1, 100, 1], [2, 200, 2], [3, 300, 3], [4, 400, 4]];
    const short = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, level: 8, buyCount: 2, sellCount: 2, rows, length: 144 + 16 * 3 }), DIV);
    expect(short?.kind === 'marketPicture' && [short.bids.length, short.asks.length]).toEqual([2, 1]);
    const huge = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, level: 16, buyCount: 0xffffffff, sellCount: 0xffffffff, rows }), DIV);
    expect(huge?.kind === 'marketPicture' && [huge.level, huge.bids.length, huge.asks.length]).toEqual([16, 4, 0]);
    const level2 = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, level: 2, buyCount: 1, sellCount: 0, rows: [[7, 100, 1]] }), DIV);
    expect(level2?.kind === 'marketPicture' && [level2.bids.length, level2.asks.length]).toEqual([1, 0]);
  });

  it('treats the negative "never updated" LUT sentinel and zero times as absent', () => {
    const p = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, lut: -2209008600, ltt: 0 }), DIV);
    expect(p?.kind === 'marketPicture' && [p.lutRaw, p.lut, p.lttRaw, p.ltt]).toEqual([-2209008600, null, 0, null]);
    expect(feedTimeMs(1756636800)).toBe(1756636800_000);
    expect(feedTimeMs(0)).toBeNull();
    expect(feedTimeMs(-5)).toBeNull();
    // A millisecond value would land in the year ~57000: not epoch seconds, so absent.
    expect(feedTimeMs(1756636800_000)).toBeNull();
  });

  it('decodes CAS reference packets and drops the all-zero ones', () => {
    expect(decodePacket(encodeCas({ exch: 1, token: 2885, ref: 245050, imb: 1200, imbMkt: -300 }), DIV)).toEqual({
      kind: 'cas',
      exchangeId: 1,
      exchange: 'nse_cm',
      seq: 0,
      token: '2885',
      refPrice: 2450.5,
      imbalanceQty: 1200,
      imbalanceQtyAtMkt: -300,
    });
    expect(decodePacket(encodeCas({ exch: 1, token: 2885, ref: 0, imb: 0, imbMkt: 0 }), DIV)).toBeNull();
    expect(decodePacket(encodeCas({ exch: 1, token: 2885, ref: 1, imb: 1, imbMkt: 1, size: 32 }), DIV)).toBeNull();
  });

  it('maps legacy 6511/6521 to open/close and keeps unknown status codes', () => {
    expect(decodePacket(encodeHeaderOnly(6511), DIV)).toMatchObject({ kind: 'marketStatus', statusCode: 1, name: 'OpenMessage' });
    expect(decodePacket(encodeHeaderOnly(6521, 0, 9, 2), DIV)).toMatchObject({ kind: 'marketStatus', exchange: 'nse_fo', statusCode: 2, name: 'CloseMessage' });
    const odd = Uint8Array.from(VEC_STATUS);
    new DataView(odd.buffer).setUint16(9, 42, true);
    odd.fill(0, 11);
    expect(decodePacket(odd, DIV)).toMatchObject({ kind: 'marketStatus', statusCode: 42, name: null, raw: '' });
  });

  it('skips unknown codes and levels without disturbing the rest of the batch', () => {
    expect(decodePacket(encodeHeaderOnly(9999, 4, 200), DIV)).toBeNull();
    expect(decodePacket(encodeHeaderOnly(7208, 3, 200), DIV)).toBeNull();
    // An unknown exchange id still decodes; the name is the id.
    const unknownExch = decodePacket(encodeMarketPicture({ ...MP_L4_FIELDS, exch: 42 }), DIV);
    expect(unknownExch?.exchange).toBe('42');
    const batch = concat(encodeHeaderOnly(9999, 4, 40), VEC_MINI, encodeHeaderOnly(7208, 99, 12), VEC_STATUS);
    expect(decodeBatch(batch, DIV).map((p) => p.kind)).toEqual(['mini', 'marketStatus']);
  });
});

describe('SFeed malformed input never throws', () => {
  it('handles every truncation of every vector', () => {
    for (const vec of [VEC_MINI, VEC_INDEX, VEC_MP_L4, VEC_STATUS, VEC_BATCH]) {
      for (let n = 0; n <= vec.byteLength; n++) {
        const cut = vec.subarray(0, n);
        expect(() => decodePacket(cut, DIV)).not.toThrow();
        expect(() => decodeBatch(cut, DIV)).not.toThrow();
      }
    }
    expect(decodePacket(VEC_INDEX.subarray(0, 86), DIV)).toBeNull();
    expect(decodePacket(VEC_MINI.subarray(0, 53), DIV)).toBeNull();
    expect(decodePacket(VEC_MP_L4.subarray(0, 143), DIV)).toBeNull();
    expect(decodePacket(VEC_STATUS.subarray(0, 10), DIV)).toBeNull();
    expect(decodePacket(new Uint8Array(0), DIV)).toBeNull();
  });

  it('stops de-framing at zero or garbage lengths', () => {
    expect(splitBatch(new Uint8Array([0, 0, 1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
    expect(splitBatch(new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0]))).toEqual([]);
    expect(splitBatch(new Uint8Array([1]))).toEqual([]);
    expect(splitBatch(concat(VEC_MINI, new Uint8Array([5, 0, 1, 1, 1])))).toHaveLength(1);
  });

  it('survives random bytes (seeded fuzz)', () => {
    let seed = 0x2545f491;
    const rnd = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rnd() * 400);
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = Math.floor(rnd() * 256);
      if (len >= 4 && rnd() < 0.5) {
        // Plausible headers make the decoder go deeper.
        const v = new DataView(b.buffer);
        v.setUint16(0, Math.min(len, Math.floor(rnd() * 300)), true);
        v.setUint16(2, [7207, 7208, 105, 104, 6511][Math.floor(rnd() * 5)], true);
        if (len >= 6) b[5] = [1, 2, 4, 8, 16][Math.floor(rnd() * 5)];
      }
      expect(() => decodeBatch(b, DIV)).not.toThrow();
      expect(() => decodePacket(b, DIV)).not.toThrow();
    }
  });

  it('subarrays with a non-zero byteOffset decode correctly', () => {
    const padded = concat(new Uint8Array([0xff, 0xee, 0xdd]), VEC_MINI);
    expect(decodePacket(padded.subarray(3), DIV)).toEqual(decodePacket(VEC_MINI, DIV));
  });
});

describe('SFeed control frames', () => {
  it('builds the auth frame exactly as SDK 3.0.7 sends it', () => {
    expect(buildAuthFrame({ ucc: 'ABC12', sid: 'daca59eb-caeb-4f9a-ac44-31d427e65b00', connReqTime: 1760250000000 })).toBe(
      '{"user":"ABC12","auth":"daca59eb-caeb-4f9a-ac44-31d427e65b00","format":"native_batch","source":"NEOTRADEAPI","platform":"Web","version":"1.2.3","sdk_version":2,"sdk_date":"2026-08-07T09:41:17.667Z","conn_req_time":1760250000000,"sessionValidation":false}',
    );
  });

  it('builds subscribe/unsubscribe/snapshot frames as in research §4.1', () => {
    const fo = [
      { segment: 'nse_fo', token: '44498' },
      { segment: 'nse_fo', token: '44500' },
    ];
    expect(buildSubscribeFrame('scrips', fo)).toBe('{"event":"subscribeScrips","inputtoken":"nse_fo|44498,nse_fo|44500","ack_symbol":true}');
    expect(buildUnsubscribeFrame('scrips', fo)).toBe('{"event":"unsubscribeScrips","inputtoken":"nse_fo|44498,nse_fo|44500"}');
    expect(buildSnapshotFrame('scrips', [{ segment: 'nse_cm', token: '11536' }])).toBe('{"event":"snapshotScrips","inputtoken":"nse_cm|11536","ack_symbol":true}');
    expect(buildMarketStatusFrame(true)).toBe('{"event":"subscribeExchange"}');
    expect(buildMarketStatusFrame(false)).toBe('{"event":"unsubscribeExchange"}');
  });

  it('uses the event of each intent, with index names as tokens', () => {
    const idx = [
      { segment: 'nse_cm', token: 'Nifty 50' },
      { segment: 'bse_cm', token: 'SENSEX' },
    ];
    expect(buildSubscribeFrame('index', idx)).toBe('{"event":"subscribeIndices","inputtoken":"nse_cm|Nifty 50,bse_cm|SENSEX","ack_symbol":true}');
    expect(buildUnsubscribeFrame('index', idx)).toBe('{"event":"unsubscribeIndices","inputtoken":"nse_cm|Nifty 50,bse_cm|SENSEX"}');
    expect(buildSnapshotFrame('index', [{ segment: 'nse_cm', token: '26000' }])).toBe('{"event":"snapshotIndices","inputtoken":"nse_cm|26000","ack_symbol":true}');
    expect(JSON.parse(buildSubscribeFrame('depth', [{ segment: 'nse_fo', token: '49081' }]))).toEqual({ event: 'subscribeDepth', inputtoken: 'nse_fo|49081', ack_symbol: true });
    expect(JSON.parse(buildUnsubscribeFrame('depth', [{ segment: 'nse_fo', token: '49081' }]))).toEqual({ event: 'unsubscribeDepth', inputtoken: 'nse_fo|49081' });
    expect(JSON.parse(buildSnapshotFrame('depth', [{ segment: 'nse_fo', token: '49081' }])).event).toBe('snapshotDepth');
    expect(JSON.parse(buildSubscribeFrame('lite', [{ segment: 'nse_cm', token: '11536' }])).event).toBe('subscribeScripsLite');
    expect(JSON.parse(buildUnsubscribeFrame('lite', [{ segment: 'nse_cm', token: '11536' }])).event).toBe('unsubscribeScripsLite');
    expect(JSON.parse(buildSnapshotFrame('lite', [{ segment: 'nse_cm', token: '11536' }])).event).toBe('snapshotScripsLite');
  });

  it('rejects tokens that would corrupt the comma/pipe list', () => {
    expect(inputToken({ segment: 'nse_cm', token: 'Nifty 50' })).toBe('nse_cm|Nifty 50');
    for (const bad of [
      { segment: 'nse_cm', token: '1,2' },
      { segment: 'nse_cm', token: 'a|b' },
      { segment: 'nse_cm', token: '' },
      { segment: 'nse_cm', token: ' 1' },
      { segment: 'xyz', token: '1' },
      { segment: 'none', token: '1' },
    ]) {
      expect(() => inputToken(bad)).toThrow();
    }
    expect(() => buildSubscribeFrame('scrips', [])).toThrow();
  });

  it('parses the production 1119 auth body into dividers keyed by exchange id', () => {
    const c = parseControlFrame(JSON.stringify(AUTH_1119));
    expect(c).toMatchObject({ kind: 'auth', code: 1119, id: 'SFD_CPROD_701', fallback: false });
    expect(c.kind === 'auth' && [...c.dividers]).toEqual([
      [1, 100],
      [2, 100],
      [3, 10_000_000],
      [7, 10_000_000],
    ]);
  });

  it('parses the documented 1117 body (ids from the name enum)', () => {
    const c = parseControlFrame(JSON.stringify(AUTH_1117));
    expect(c).toMatchObject({ kind: 'auth', code: 1117, format: 'native_batch', fallback: false });
    expect(c.kind === 'auth' && Object.fromEntries(c.dividers)).toEqual({ 1: 100, 2: 100, 3: 10_000_000 });
  });

  it('defaults missing/invalid dividers to 100 and skips non-object entries', () => {
    expect(Object.fromEntries(parseDividers({ nse_cm: { value: 1 }, bse_fo: { divider: 0 }, bogus: 'x', unknown_seg: { divider: 5 }, mcx_fo: { value: '9', divider: '100' } }))).toEqual({ 1: 100, 6: 100, 9: 100 });
    expect(parseDividers(null).size).toBe(0);
  });

  it('parses 1120, native_fallback, both 1109 shapes, errors and junk', () => {
    expect(parseControlFrame(JSON.stringify(AUTH_1120))).toEqual({ kind: 'authFailed', code: 1120, message: 'Auth failed ...' });
    expect(parseControlFrame(JSON.stringify(AUTH_FALLBACK))).toMatchObject({ kind: 'auth', fallback: true, format: 'native_fallback' });
    expect(parseControlFrame(JSON.stringify(ACK_SDK))).toEqual({
      kind: 'ack',
      code: 1109,
      ok: true,
      errorCode: undefined,
      description: 'Subscribed',
      symbols: { 'nse_cm|2885': 'RELIANCE-EQ', 'nse_cm|22': 'ACC-EQ' },
      casStatus: {},
    });
    expect(parseControlFrame(JSON.stringify(ACK_DOC))).toEqual({
      kind: 'ack',
      code: 1109,
      ok: true,
      errorCode: 0,
      description: 'SUBSCRIBED',
      symbols: { 'nse_cm|1333': 'HDFCBANK-EQ' },
      casStatus: { 'nse_cm|1333': 1 },
    });
    expect(parseControlFrame(JSON.stringify({ message_code: 1109, error_code: 7, description: 'LIMIT' }))).toMatchObject({ kind: 'ack', ok: false, errorCode: 7, symbols: {} });
    expect(parseControlFrame(JSON.stringify({ message_code: 1109, trading_symbols: { 'nse_cm|99': 12345 } }))).toMatchObject({ symbols: {} });
    expect(parseControlFrame(JSON.stringify({ message_code: 4001, error_code: 3, message: 'bad request' }))).toEqual({ kind: 'error', code: 4001, message: 'bad request' });
    expect(parseControlFrame(JSON.stringify({ stat: 'Not_Ok', emsg: 'Invalid' }))).toEqual({ kind: 'error', code: undefined, message: 'Invalid' });
    expect(parseControlFrame('{"message_code":9999,"foo":"bar"}')).toEqual({ kind: 'other', code: 9999, data: { message_code: 9999, foo: 'bar' } });
    expect(parseControlFrame('not-json{')).toEqual({ kind: 'invalid', reason: 'not JSON' });
    expect(parseControlFrame('["a","list"]')).toEqual({ kind: 'invalid', reason: 'not a JSON object' });
    expect(parseControlFrame('null')).toEqual({ kind: 'invalid', reason: 'not a JSON object' });
  });
});

describe('resolveFeedUrl', () => {
  it('prefers the config service, then feedUrl, then the default', () => {
    expect(resolveFeedUrl({ configEndpoint: 'https://e22-feed.kotaksecurities.com/apifeed', feedUrl: 'https://x.kotaksecurities.com/apifeed' })).toEqual({
      url: 'wss://e22-feed.kotaksecurities.com/apifeed',
      source: 'config',
    });
    expect(resolveFeedUrl({ configEndpoint: '  ', feedUrl: 'https://x.kotaksecurities.com/apifeed' })).toEqual({ url: 'wss://x.kotaksecurities.com/apifeed', source: 'feedUrl' });
    expect(resolveFeedUrl({})).toEqual({ url: SFEED_DEFAULT_URL, source: 'default' });
    expect(SFEED_DEFAULT_URL).toBe('wss://sfeed.kotaksecurities.com/apifeed');
  });

  it('converts schemes, prefixes bare hosts and refuses the retired HSM host', () => {
    expect(toWebSocketUrl('HTTPS://sfeed.kotaksecurities.com/apifeed')).toBe('wss://sfeed.kotaksecurities.com/apifeed');
    expect(toWebSocketUrl('http://localhost:9000/feed')).toBe('ws://localhost:9000/feed');
    expect(toWebSocketUrl('wss://cdtstream.kotaksecurities.com/mfeed')).toBe('wss://cdtstream.kotaksecurities.com/mfeed');
    expect(toWebSocketUrl('cdtstream.kotaksecurities.com/mfeed')).toBe('wss://cdtstream.kotaksecurities.com/mfeed');
    expect(toWebSocketUrl('wss://mlhsm.kotaksecurities.com')).toBeNull();
    expect(toWebSocketUrl('ftp://x.y')).toBeNull();
    expect(toWebSocketUrl('https://')).toBeNull();
    expect(toWebSocketUrl(undefined)).toBeNull();
    expect(resolveFeedUrl({ configEndpoint: 'mlhsm.kotaksecurities.com', feedUrl: null })).toEqual({ url: SFEED_DEFAULT_URL, source: 'default' });
  });
});

describe('index vector helper', () => {
  it('encodeIndex keeps the layout of vector (b)', () => {
    const p = decodePacket(encodeIndex({ token: 26009, name: 'NIFTY BANK', value: 5_100_000 }), DIV);
    expect(p).toMatchObject({ kind: 'index', token: '26009', name: 'NIFTY BANK', ltp: 51000, close: 19900 });
  });
});
