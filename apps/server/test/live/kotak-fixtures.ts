/**
 * Documented Kotak Neo sample payloads (official Kotak-Neo/Kotak-Neo docs @65a67e5 and the SDK docs,
 * as quoted in docs/live-data/research/kotak-rest-auth.md) plus scrip-master CSV builders using the
 * exact 78-column header (trailing spaces and 'dStrikePrice;' included).
 */
import type { NeoEnv } from '../../src/live/env';

/** Dummy credentials (the TOTP secret is the RFC 6238 test key). */
export const CREDS: NeoEnv = {
  consumerKey: 'c0ffee00-1111-2222-3333-444455556666',
  mobileNumber: '+919876543210',
  ucc: 'ABC12',
  mpin: '654321',
  totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
};

/** An unsigned JWT-shaped token carrying `payload` (only the payload is ever decoded). */
export function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.c2lnbmF0dXJl`;
}

/* ---------------------------------------------------------------------------------------- */
/* Login (authentication.md; kotak-rest-auth.md §1.2/§1.3)                                     */
/* ---------------------------------------------------------------------------------------- */

export function loginOk(token = fakeJwt({ sub: 'view-user', kType: 'View' }), sid = 'view-sid-1111-2222-3333-444444444444') {
  return {
    data: {
      token,
      sid,
      rid: 'rid-0000-1111-2222-333333333333',
      isUserPwdExpired: false,
      ucc: 'XXXXX',
      greetingName: 'USER_NAME',
      isTrialAccount: false,
      dataCenter: 'E43',
      derivativesRiskDisclosure: '...',
      mfAccess: 1,
      dataCenterMap: null,
      dormancyStatus: 'A',
      asbaStatus: '',
      clientType: 'RI',
      isNRI: false,
      kId: '<PAN>',
      kType: 'View',
      status: 'success',
      incRange: 0,
      incUpdFlag: '',
      clientGroup: '',
      kraStatus: '',
      rcFlag: 0,
    },
  };
}

export function validateOk(opts: { token?: string; sid?: string; baseUrl?: string | null; feedUrl?: string } = {}) {
  const data: Record<string, unknown> = {
    token: opts.token ?? fakeJwt({ sub: 'trade-user', kType: 'Trade' }),
    sid: opts.sid ?? 'trade-sid-aaaa-bbbb-cccc-dddddddddddd',
    rid: 'rid-0000-1111-2222-333333333333',
    hsServerId: '',
    isUserPwdExpired: false,
    ucc: 'XXXXX',
    greetingName: 'USER_NAME',
    isTrialAccount: false,
    dataCenter: 'E43',
    searchAPIKey: '',
    mfAccess: 1,
    dataCenterMap: null,
    dormancyStatus: 'A',
    asbaStatus: '',
    clientType: 'RI',
    isNRI: false,
    kId: '<PAN>',
    kType: 'Trade',
    status: 'success',
    incRange: 0,
    incUpdFlag: '',
    clientGroup: '',
    kraStatus: '',
    rcFlag: 0,
  };
  // troubleshooting.md Q7: a baseUrl may carry a path prefix.
  if (opts.baseUrl !== null) data.baseUrl = opts.baseUrl ?? 'https://neo-gw.kotaksecurities.com/xyz';
  if (opts.feedUrl) data.feedUrl = opts.feedUrl;
  return { data };
}

export const LOGIN_ERROR = { status: 'error', message: 'Invalid credentials or TOTP.', errorCode: '401' };
export const VALIDATE_ERROR = { status: 'error', message: 'Invalid MPIN.', errorCode: '401' };
export const LOGIN_MISSING_FIELD = { error: [{ code: '400', message: "Missing required field 'MobileNumber'" }] };
/** portfolio-and-funds-apis/*.md */
export const INVALID_SESSION = { stat: 'Not_Ok', emsg: 'Invalid session', stCode: 1003 };
/** quotes.md / option-chain.md / expiries.md error example */
export const INVALID_INSTRUMENT = { stat: 'Not_Ok', emsg: 'Invalid instrument/code', stCode: 1009 };
/** Community issue #35 rate-limit body */
export const RATE_LIMITED = { code: 429, error: 'Rate limit exceeded', message: 'too many request received' };

/* ---------------------------------------------------------------------------------------- */
/* Quotes (SDK quotes doc sample; official quotes.md index sample)                            */
/* ---------------------------------------------------------------------------------------- */

export const QUOTE_EQUITY = {
  exchange_token: '1333',
  display_symbol: 'HDFCBANK-EQ',
  exchange: 'nse_cm',
  lstup_time: '1782374657',
  ltp: '801.6000',
  last_traded_quantity: '550',
  total_buy: '907335',
  total_sell: '2883870',
  last_volume: '30043533',
  avg_cost: '799.8900',
  open_int: '0',
  change: '8.4000',
  per_change: '1.0600',
  low_price_range: '713.9000',
  high_price_range: '872.5000',
  year_high: '2037.7',
  year_low: '726.65',
  ohlc: { open: '798.5000', high: '804.4500', low: '796.0000', close: '793.2000' },
  // First level of each side is the documented one; the doc elides levels 2–5 ("... 5 levels").
  depth: {
    buy: [
      { price: '801.6000', quantity: '1733', orders: '4' },
      { price: '801.5500', quantity: '1200', orders: '3' },
      { price: '801.5000', quantity: '900', orders: '2' },
      { price: '801.4500', quantity: '450', orders: '1' },
      { price: '0', quantity: '0', orders: '0' },
    ],
    sell: [
      { price: '801.6500', quantity: '550', orders: '1' },
      { price: '801.7000', quantity: '800', orders: '2' },
      { price: '801.7500', quantity: '1000', orders: '3' },
      { price: '801.8000', quantity: '1500', orders: '5' },
      { price: '801.8500', quantity: '2000', orders: '6' },
    ],
  },
};

export const QUOTE_INDEX_SENSEX = {
  exchange_token: 'SENSEX',
  display_symbol: 'SENSEX-IN',
  exchange: 'bse_cm',
  lstup_time: '1757915078',
  ltp: '81809.3400',
  last_traded_quantity: '0',
  total_buy: '0',
  total_sell: '0',
  last_volume: '0',
  change: '-95.3600',
  per_change: '-0.1200',
  year_high: '0',
  year_low: '0',
  ohlc: { open: '81925.5100', high: '81998.5100', low: '81779.8200', close: '81904.7000' },
  depth: {
    buy: Array.from({ length: 5 }, () => ({ price: '0', quantity: '0', orders: '0' })),
    sell: Array.from({ length: 5 }, () => ({ price: '0', quantity: '0', orders: '0' })),
  },
};

/** A NIFTY option quote shaped like the documented equity sample (F&O carries open_int). */
export const QUOTE_OPTION = {
  ...QUOTE_EQUITY,
  exchange_token: '71472',
  display_symbol: 'NIFTY26JUN22250CE',
  exchange: 'nse_fo',
  open_int: '10715645',
};

/* ---------------------------------------------------------------------------------------- */
/* Option chain / futures chain / expiries / historical (official market-data-apis/*.md)      */
/* ---------------------------------------------------------------------------------------- */

export const OPTION_CHAIN = {
  data: {
    common_data: { mktLot: '65', multiplier: '1', unlSymbol: 'NIFTY', exSeg: 'nse_fo', expiryDt: '2026-06-23' },
    call: [
      {
        instrument: { neoSymbol: 'nse_fo|71472', symbol: 'NIFTY26JUN22250CE', optionType: 'CE', strikePrice: '22250', moneyness: 'ATM' },
        quote: { ltp: '166.7500', open: '89.8000', high: '214.0000', low: '77.1000', prevClose: '99.7000', close: null, volume: 225431505 },
        openInterest: { current: 10715645, previous: 13647630, change: -2931985, changePct: -21.48 },
      },
    ],
    // The doc shows `put: []`; one put leg in the same shape exercises the put side.
    put: [
      {
        instrument: { neoSymbol: 'nse_fo|71473', symbol: 'NIFTY26JUN22250PE', optionType: 'PE', strikePrice: '22250', moneyness: 'ATM' },
        quote: { ltp: '0', open: '0', high: '0', low: '0', prevClose: '120.0500', close: null, volume: 0 },
        openInterest: { current: 0, previous: 150, change: -150, changePct: -100 },
      },
    ],
  },
};

export const FUTURES_CHAIN = {
  data: {
    common_data: { mktLot: '65', multiplier: '1', unlSymbol: 'NIFTY', exSeg: 'nse_fo', expiryDt: null },
    call: [],
    put: [],
    fut: [
      {
        inst: { neoSymbol: 'nse_fo|53001', symbol: 'NIFTY26JULFUT', expiryDt: '31-JUL-2026' },
        quote: { ltp: '24485.20', o: '24455.00', h: '24512.00', l: '24428.00', c: '24485.20', pc: '24322.10', vol: '9852340' },
        oi: { cur: '13930930', prev: '13801200', chg: '129730', chgPct: '0.94' },
      },
    ],
  },
};

export const EXPIRIES = { exchange: 'nse_fo', underlying: 'RELIANCE', expiries: ['2026-06-25', '2026-06-30', '2026-07-31'] };

export const HISTORICAL = {
  status: 'success',
  interval: '1min',
  data: {
    candles: [
      ['2026-08-20T09:15:00+0530', 12009.9, 12019.35, 12001.25, 12001.5, 163275, 13667775],
      ['2026-08-20T09:16:00+0530', 12001, 12003, 11998.25, 12001, 105750, 13667775],
    ],
  },
};

export const HISTORICAL_ERROR = { status: 'ERROR', fault: { code: 400, message: 'Invalid interval value' } };

export function filePaths(day = '2026-10-12') {
  const b = `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/${day}`;
  return {
    data: {
      filesPaths: [
        `${b}/transformed/cde_fo.csv`,
        `${b}/transformed/mcx_fo.csv`,
        `${b}/transformed/nse_fo.csv`,
        `${b}/transformed/bse_fo.csv`,
        `${b}/transformed/nse_com.csv`,
        `${b}/transformed-v1/bse_cm-v1.csv`,
        `${b}/transformed-v1/nse_cm-v1.csv`,
      ],
      baseFolder: 'https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod',
    },
  };
}

/* ---------------------------------------------------------------------------------------- */
/* Scrip master CSV                                                                            */
/* ---------------------------------------------------------------------------------------- */

/** Verbatim header of the official sample files (78 columns). */
export const SCRIP_HEADER =
  'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,pISIN,pAssetCode,pSubGroup,pCombinedSymbol,pDesc,pAmcCode,pContractId,dTickSize ,lLotSize,lExpiryDate ,lMultiplier ,lPrecision,dStrikePrice;,pExchange,pInstName,pExpiryDate,pIssueDate,pMaturityDate,pListingDate,pNoDelStartDate,pNoDelEndDate,pBookClsStartDate,pBookClsEndDate,pRecordDate,pCreditRating,pReAdminDate,pExpulsionDate,pLocalUpdateTime,pDeliveryUnits,pPriceUnits,pLastTradingDate,pTenderPeridEndDate,pTenderPeridStartDate,pSellVarMargin,pBuyVarMargin,pInstrumentInfo,pRemarksText,pSegment,pNav,pNavDate,pMfAmt,pSipSecurity,pFaceValue,pTrdUnits,pExerciseStartDate,pExerciseEndDate,pElmMargin,pVarMargin,pTotProposedLimitValue,pScripBasePrice,pSettlementType,pCurrectionTime,iPermittedToTrade,iBoardLotQty ,iMaxOrderSize ,iLotSize,dOpenInterest ,dHighPriceRange ,dLowPriceRange ,dPriceNum   ,dGenDen,dGenNum,dPriceQuatation ,dIssuerate ,dPriceDen,dWarningQty ,dIssueCapital ,dExposureMargin ,dMinRedemptionQty ,lFreezeQty';

const HEADER_NAMES = SCRIP_HEADER.split(',').map((h) => h.trim());

/** One CSV line with the given (trimmed-name) fields; values are emitted raw. */
export function scripRow(fields: Record<string, string | number>): string {
  return HEADER_NAMES.map((h) => (fields[h] === undefined ? '' : String(fields[h]))).join(',');
}

export const scripCsv = (rows: string[]) => [SCRIP_HEADER, ...rows].join('\n') + '\n';

/** nse_fo lExpiryDate: seconds since the NSE epoch (official: add 315511200 to get Unix). */
export const nseExpiry = (date: string) => Date.parse(`${date}T09:00:00Z`) / 1000 - 315_511_200;
/** bse_fo lExpiryDate: plain Unix seconds (15:30 IST). */
export const bseExpiry = (date: string) => Date.parse(`${date}T10:00:00Z`) / 1000;

export function foRow(o: {
  seg?: 'nse_fo' | 'bse_fo' | 'mcx_fo';
  token: string | number;
  inst: string;
  name: string;
  trd: string;
  opt: 'CE' | 'PE' | 'XX';
  expiry: number;
  strike: string | number;
  lot: number;
  tick?: number;
  freeze?: number;
}): string {
  const seg = o.seg ?? 'nse_fo';
  return scripRow({
    pSymbol: o.token,
    pGroup: 'XX',
    pExchSeg: seg,
    pInstType: o.inst,
    pSymbolName: o.name,
    pTrdSymbol: o.trd,
    pOptionType: o.opt,
    pScripRefKey: o.trd,
    dTickSize: o.tick ?? 5,
    lLotSize: o.lot,
    lExpiryDate: o.expiry,
    lMultiplier: -1,
    lPrecision: 2,
    'dStrikePrice;': o.strike,
    pExchange: seg === 'nse_fo' ? 'NSE' : seg === 'mcx_fo' ? 'MCX' : 'BSE',
    pInstName: o.inst,
    pExpiryDate: o.expiry,
    pCreditRating: '"            "',
    pSegment: 'FO',
    iMaxOrderSize: o.freeze ?? 1801,
    iLotSize: o.lot,
    lFreezeQty: o.freeze ?? 1801,
  });
}

export function cmRow(o: { seg?: 'nse_cm' | 'bse_cm'; token: string | number; group: string; name: string; trd: string; desc?: string; tick?: number; freeze?: number }): string {
  const seg = o.seg ?? 'nse_cm';
  return scripRow({
    pSymbol: o.token,
    pGroup: o.group,
    pExchSeg: seg,
    pSymbolName: o.name,
    pTrdSymbol: o.trd,
    pScripRefKey: o.name,
    pDesc: o.desc ?? '',
    dTickSize: o.tick ?? 5,
    lLotSize: 1,
    lExpiryDate: -1,
    lMultiplier: -1,
    lPrecision: 2,
    'dStrikePrice;': -1,
    pExchange: seg === 'nse_cm' ? 'NSE' : 'BSE',
    pSegment: 'CASH',
    iLotSize: 1,
    iMaxOrderSize: o.freeze ?? 0,
    lFreezeQty: o.freeze ?? 0,
  });
}

/** Verbatim rows of the official 2023 sample (kotak-neo-api-v2/neo_api_client/api/*.csv). */
export const LEGACY_FO_ROWS = [
  '37000,XX,nse_fo,OPTIDX,FINNIFTY,FINNIFTY2350917550PE,PE,FINNIFTY2350917550PE,,26037,,,,,,5,40,1368109800,-1,2,1.755e+06,NSE,OPTIDX,1368109800,1365120000,1368109800,1365120000,0,0,0,0,0,"            ",0,0,1366304166,,,,,,,,,,FO,,,,,,,1368057600,1368109800,,,,4585,Cash,,0,1,1801,40,0,12925,5,1,1,1,0,0,1,0,1e+12,2,0,1801',
  '37001,XX,nse_fo,OPTIDX,FINNIFTY,FINNIFTY2350917600CE,CE,FINNIFTY2350917600CE,,26037,,,,,,5,40,1368109800,-1,2,1.76e+06,NSE,OPTIDX,1368109800,1365120000,1368109800,1365120000,0,0,0,0,0,"            ",0,0,1366304166,,,,,,,,,,FO,,,,,,,1368057600,1368109800,,,,128725,Cash,,0,1,1801,40,0,209350,48100,1,1,1,0,0,1,0,1e+12,2,0,1801',
  '37002,XX,nse_fo,OPTIDX,FINNIFTY,FINNIFTY2350917600PE,PE,FINNIFTY2350917600PE,,26037,,,,,,5,40,1368109800,-1,2,1.76e+06,NSE,OPTIDX,1368109800,1365120000,1368109800,1365120000,0,0,0,0,0,"            ",0,0,1366304166,,,,,,,,,,FO,,,,,,,1368057600,1368109800,,,,5120,Cash,,0,1,1801,40,0,14270,5,1,1,1,0,0,1,0,1e+12,2,0,1801',
  '35019 35003,XX,nse_fo,FUTIDX,NIFTY,NIFTY27APR2329JUN23FUT,XX,,,,,,,,SP,5,50,1367073000,-1,2,-1,,FUTIDX,1367073000,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,1771235,,,0,1,0,50,0,35425,-35425,1,1,1,0,0,1,0,-1,0,0,1801',
];

export const LEGACY_CM_ROWS = [
  '26000,,nse_cm,,NIFTY,NIFTY,,NIFTY,,,,,NIFTY,,,-1,1,-1,-1,2,-1,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,0,1,0,1,0,0,0,1,1,1,0,0,1,0,-1,0,0,0',
  '26037,,nse_cm,,FINNIFTY,FINNIFTY,,FINNIFTY,,,,,FINNIFTY,,,-1,1,-1,-1,2,-1,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,0,1,0,1,0,0,0,1,1,1,0,0,1,0,-1,0,0,0',
  '2885,EQ,nse_cm,,RELIANCE,RELIANCE-EQ,,RELIANCE,INE002A01018,,,,RELIANCE INDUSTRIES LTD,,,5,1,-1,-1,2,-1,NSE,,,467424000,,502070400,0,0,0,0,1345334400,2119.95-2591.05,0,0,1365879312,,,,,,,,,,CASH,,,,,1000,,,,0,20,,,T+1,315513000,0,1,40592,1,0,259105,211995,1,1,1,0,0,1,0,6.76549e+09,0,0,40592',
];

/* ---------------------------------------------------------------------------------------- */
/* Fake fetch                                                                                  */
/* ---------------------------------------------------------------------------------------- */

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  hasHeaders: boolean;
}

export type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };

/** fetch stand-in: records every call and answers from `handler` (never touches the network). */
export function fakeFetch(handler: (call: FetchCall, n: number) => Reply | Promise<Reply>) {
  const calls: FetchCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    const h = new Headers(init?.headers);
    const headers: Record<string, string> = {};
    h.forEach((v, k) => (headers[k] = v));
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      hasHeaders: init?.headers !== undefined,
    };
    calls.push(call);
    const r = await handler(call, calls.length - 1);
    const payload = r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body));
    return new Response(payload, { status: r.status ?? 200, headers: r.headers });
  };
  return { fn, calls };
}

/** A clock that only moves when `sleep` is awaited, so TOTP-window waits never depend on wall time. */
export function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}
