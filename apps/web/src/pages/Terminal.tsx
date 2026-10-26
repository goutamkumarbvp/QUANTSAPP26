import { useMemo, useState } from 'react';
import type { Candle, PcrResponse } from '@q26/core';
import { Chart, axis, baseOption, gapLine, timeAxis, useChartColors } from '../components/Chart';
import { SymbolSelect } from '../components/pickers';
import { Card, Coverage, cx, PageHeader, Segmented } from '../components/ui';
import { errorText, qs } from '../lib/api';
import { useExpiries, useLive, useMeta } from '../lib/hooks';
import { formatCompact, formatIndian, isNum } from '../lib/format';
import { useApp } from '../lib/store';

/**
 * Market Terminal: four blocks of one underlying on one screen — the price chart (candles with EMA 20 /
 * EMA 50), total call vs put OI through the day with each interval's OI build-up, PCR of OI and of the
 * change in OI, and the near-month future's volume against call / put OI. Every series is live or
 * recorded data of this app; a block without data stays blank with the reason.
 */

const MIN = 60_000;
/** Quick picks (shown when listed): the indices, then the MCX commodities. */
const QUICK = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'BANKEX', 'GOLD', 'CRUDEOIL', 'SILVER', 'NATURALGAS'];
const TF = [1, 5, 15, 30, 60] as const;

/** Exponential moving average of closes (null until `n` closes are seen). */
export function ema(closes: readonly number[], n: number): (number | null)[] {
  const k = 2 / (n + 1);
  const out: (number | null)[] = [];
  let prev: number | null = null;
  let sum = 0;
  closes.forEach((x, i) => {
    if (i < n - 1) {
      sum += x;
      out.push(null);
      return;
    }
    if (prev === null) {
      prev = (sum + x) / n;
    } else prev = x * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

const why = (e: unknown) => (e ? errorText(e) : undefined);

export default function Terminal() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const meta = useMeta();
  const listed = new Set((meta.data?.symbols ?? []).map((s) => s.symbol));
  const quick = QUICK.filter((s) => listed.has(s));
  const exchangeOf = (s: string) => meta.data?.symbols.find((x) => x.symbol === s)?.exchange ?? '';
  const [tf, setTf] = useState<(typeof TF)[number]>(5);
  const c = useChartColors();

  // Same keys as the Price, PCR and Order-flow pages: one request is shared between tabs.
  const candles = useLive<Candle[]>(['terminal-candles', symbol, tf], `/candles/${symbol}${qs({ interval: String(tf), days: 1 })}`, 10000);
  const pcr = useLive<PcrResponse>(['pcr', symbol, undefined, 5, ''], `/oi/pcr/${symbol}${qs({ expiry: undefined, interval: 5, date: '', days: 60 })}`, 10000);
  const exp = useExpiries(symbol);
  const fut = exp.data?.futures[0];
  const futCandles = useLive<Candle[]>(['terminal-fut-candles', symbol, fut], `/candles/${symbol}${qs({ type: 'FUT', expiry: fut, interval: '5', days: 1 })}`, 10000, !!fut);

  /* ---------------------------- Price chart ---------------------------- */
  const priceOpt = useMemo(() => {
    const d = (candles.data ?? []).filter((k) => isNum(k.open) && isNum(k.high) && isNum(k.low));
    const closes = d.map((k) => k.close);
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    return {
      ...baseOption(c),
      legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, data: ['Price', 'EMA 20', 'EMA 50'] },
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, position: 'right', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'Price', type: 'candlestick', barMaxWidth: 8, itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down }, data: d.map((k) => [k.ts, k.open, k.close, k.low, k.high]) },
        { name: 'EMA 20', type: 'line', symbol: 'none', lineStyle: { width: 1.2, color: '#3b82f6' }, itemStyle: { color: '#3b82f6' }, data: d.map((k, i) => [k.ts, e20[i]]) },
        { name: 'EMA 50', type: 'line', symbol: 'none', lineStyle: { width: 1.2, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' }, data: d.map((k, i) => [k.ts, e50[i]]) },
      ],
    };
  }, [candles.data, c]);
  const last = candles.data?.at(-1);
  const lastE = useMemo(() => {
    const closes = (candles.data ?? []).map((k) => k.close);
    return { e20: ema(closes, 20).at(-1) ?? null, e50: ema(closes, 50).at(-1) ?? null };
  }, [candles.data]);

  /* ---------------------- Total OI with build-up ---------------------- */
  const pts = pcr.data?.intraday ?? [];
  const oiPts = pts.filter((p) => isNum(p.ceOi) && isNum(p.peOi));
  const oiOpt = useMemo(() => {
    // Build-up of an interval = the change of total OI since the previous recorded point.
    const build = oiPts.map((p, i) => ({ ts: p.ts, ce: i ? (p.ceOi as number) - (oiPts[i - 1].ceOi as number) : null, pe: i ? (p.peOi as number) - (oiPts[i - 1].peOi as number) : null }));
    return {
      ...baseOption(c),
      legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, data: ['CE OI', 'PE OI', 'CE build-up', 'PE build-up'] },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v, 1) } },
        { type: 'value', scale: true, position: 'right', ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v, 1) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'CE build-up', type: 'bar', yAxisIndex: 1, barMaxWidth: 4, itemStyle: { color: c.down, opacity: 0.55 }, data: build.map((b) => [b.ts, b.ce]) },
        { name: 'PE build-up', type: 'bar', yAxisIndex: 1, barMaxWidth: 4, itemStyle: { color: c.up, opacity: 0.55 }, data: build.map((b) => [b.ts, b.pe]) },
        { name: 'CE OI', type: 'line', symbol: 'none', lineStyle: { width: 2, color: c.down }, itemStyle: { color: c.down }, data: gapLine(oiPts, 5 * MIN, (p) => p.ceOi) },
        { name: 'PE OI', type: 'line', symbol: 'none', lineStyle: { width: 2, color: c.up }, itemStyle: { color: c.up }, data: gapLine(oiPts, 5 * MIN, (p) => p.peOi) },
      ],
    };
  }, [oiPts, c]);
  const lastOi = oiPts.at(-1);

  /* ------------------------- PCR (OI & COI) -------------------------- */
  const pcrOpt = useMemo(
    () => ({
      ...baseOption(c),
      legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, data: ['PCR OI', 'PCR COI'] },
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, position: 'right', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => v.toFixed(2) } },
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'PCR OI', type: 'line', symbol: 'none', lineStyle: { width: 2, color: '#3b82f6' }, itemStyle: { color: '#3b82f6' }, data: gapLine(pts, 5 * MIN, (p) => p.pcr), markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: c.muted, type: 'dashed' }, data: [{ yAxis: 1 }] } },
        { name: 'PCR COI', type: 'line', symbol: 'none', lineStyle: { width: 2, color: '#f59e0b' }, itemStyle: { color: '#f59e0b' }, data: gapLine(pts, 5 * MIN, (p) => p.changePcr) },
      ],
    }),
    [pts, c],
  );
  const lastPcr = [...pts].reverse().find((p) => isNum(p.pcr));
  const lastCoi = [...pts].reverse().find((p) => isNum(p.changePcr));

  /* ------------------------- Volume vs OI ---------------------------- */
  const volOpt = useMemo(() => {
    const v = (futCandles.data ?? []).filter((k) => isNum(k.volume));
    return {
      ...baseOption(c),
      legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, data: ['FUT volume', 'CE OI', 'PE OI'] },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', min: 0, ...axis(c), axisLabel: { color: c.muted, formatter: (x: number) => formatCompact(x, 1) } },
        { type: 'value', scale: true, position: 'right', ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (x: number) => formatCompact(x, 1) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'FUT volume', type: 'bar', barMaxWidth: 5, itemStyle: { color: '#3b82f6', opacity: 0.75 }, data: v.map((k) => [k.ts, k.volume]) },
        { name: 'CE OI', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1.5, color: c.down }, itemStyle: { color: c.down }, data: gapLine(oiPts, 5 * MIN, (p) => p.ceOi) },
        { name: 'PE OI', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1.5, color: c.up }, itemStyle: { color: c.up }, data: gapLine(oiPts, 5 * MIN, (p) => p.peOi) },
      ],
    };
  }, [futCandles.data, oiPts, c]);
  const futVol = (futCandles.data ?? []).reduce((a, k) => a + (isNum(k.volume) ? k.volume : 0), 0);

  const oiWhy = pcr.data?.gaps?.intraday ?? why(pcr.error) ?? 'No recorded option-chain minutes for this session';
  const H = 300;
  return (
    <div className="space-y-3">
      <PageHeader title="Market Terminal" subtitle="Price with EMA 20/50, total CE vs PE OI with build-up, PCR of OI and of the change in OI, and volume vs OI — one underlying on one screen">
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </PageHeader>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((s) => (
          <button key={s} onClick={() => setSymbol(s)} className={cx('rounded-md border px-3 py-1 text-xs font-semibold', s === symbol ? 'border-accent bg-accent text-white' : 'border-line bg-panel2 text-muted hover:text-ink')}>
            {exchangeOf(s)}: {s === 'CRUDEOIL' ? 'CRUDE' : s === 'NATURALGAS' ? 'NATURAL GAS' : s}
          </button>
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card
          title={`Price Chart (${symbol})`}
          actions={<Segmented size="xs" value={tf} onChange={setTf} options={TF.map((v) => ({ value: v, label: v === 60 ? '1H' : `${v}m` }))} />}
        >
          {last && (
            <div className="mb-1 flex flex-wrap gap-x-3 text-2xs tabular-nums text-muted">
              <span>O {formatIndian(last.open)}</span>
              <span>H {formatIndian(last.high)}</span>
              <span>L {formatIndian(last.low)}</span>
              <span>C {formatIndian(last.close)}</span>
              <span className="text-[#3b82f6]">EMA 20 {isNum(lastE.e20) ? formatIndian(lastE.e20) : '—'}</span>
              <span className="text-[#f59e0b]">EMA 50 {isNum(lastE.e50) ? formatIndian(lastE.e50) : '—'}</span>
            </div>
          )}
          <Chart option={priceOpt} height={H} blank={candles.data?.length ? undefined : why(candles.error) ?? 'No intraday candles yet'} />
          <Coverage text="Candles of this session from recorded live ticks (Kotak 1-minute history where the app did not record); EMA from these closes only (blank until 20 / 50 candles)." />
        </Card>

        <Card title="Total OI (CE vs PE) with build-up">
          {lastOi && (
            <div className="mb-1 flex flex-wrap gap-x-4 text-2xs tabular-nums">
              <span className="text-down">CE OI {formatCompact(lastOi.ceOi, 2)}</span>
              <span className="text-up">PE OI {formatCompact(lastOi.peOi, 2)}</span>
              <span className="text-muted">{(lastOi.peOi as number) >= (lastOi.ceOi as number) ? 'More puts written (support)' : 'More calls written (resistance)'}</span>
            </div>
          )}
          <Chart option={oiOpt} height={H} blank={oiPts.length ? undefined : oiWhy} />
          <Coverage text={`Lines: total OI of the recorded strikes${pcr.data?.expiry ? ` (${pcr.data.expiry})` : ''}. Bars (right axis): OI added (+) or cut (−) in each 5-minute interval.`} />
        </Card>

        <Card title="PCR (OI & COI)">
          {(lastPcr || lastCoi) && (
            <div className="mb-1 flex flex-wrap gap-x-4 text-2xs tabular-nums">
              <span className="text-[#3b82f6]">PCR OI {isNum(lastPcr?.pcr) ? lastPcr!.pcr!.toFixed(2) : '—'}</span>
              <span className="text-[#f59e0b]">PCR COI {isNum(lastCoi?.changePcr) ? lastCoi!.changePcr!.toFixed(2) : '—'}</span>
            </div>
          )}
          <Chart option={pcrOpt} height={H} blank={pts.some((p) => isNum(p.pcr)) ? undefined : oiWhy} />
          <Coverage text="PCR OI = total put OI ÷ total call OI. PCR COI = put OI added today ÷ call OI added today (blank while the call OI change is too small to divide by). Above 1 = more put writing." />
        </Card>

        <Card title="Volume vs OI Analysis">
          <div className="mb-1 flex flex-wrap gap-x-4 text-2xs tabular-nums text-muted">
            <span className="text-[#3b82f6]">{fut ? `FUT ${fut} volume today ${formatCompact(futVol, 2)}` : 'No future listed'}</span>
          </div>
          <Chart option={volOpt} height={H} blank={(futCandles.data?.length ?? 0) || oiPts.length ? undefined : why(futCandles.error) ?? oiWhy} />
          <Coverage text="Bars: traded volume of the near-month future per 5 minutes (an index itself has no volume). Lines (right axis): total call and put OI. Rising volume with rising OI = fresh positions; with falling OI = unwinding." />
        </Card>
      </div>
    </div>
  );
}
