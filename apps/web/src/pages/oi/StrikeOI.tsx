import { useMemo, useState } from 'react';
import { MARKET_OPEN_MIN, istParts, istTs, type StrikeOiResponse, type StrikeOiRow } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { ExpirySelect, SymbolSelect } from '../../components/pickers';
import { AsOf, Card, Chg, Coverage, Gaps, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { formatCompact, formatDate, formatDateTime, formatFixed, formatIndian, formatSessionTime, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { qs } from '../../lib/api';
import { useApp, useTicks } from '../../lib/store';

type Since = 'prev' | 'open' | '60' | '30' | '15';

/** Sum of the values that exist (and how many do); null when none does — a missing OI is never counted as 0. */
function sumOf(values: (number | null)[]): { total: number; n: number } | null {
  const v = values.filter(isNum);
  return v.length ? { total: v.reduce((a, b) => a + b, 0), n: v.length } : null;
}

/** The row with the largest real `pick` value, or null when none has one. */
function maxRow(rows: StrikeOiRow[], pick: (r: StrikeOiRow) => number | null): { strike: number; value: number } | null {
  let best: { strike: number; value: number } | null = null;
  for (const r of rows) {
    const v = pick(r);
    if (v !== null && (best === null || v > best.value)) best = { strike: r.strike, value: v };
  }
  return best;
}

export default function StrikeOI() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const clock = useTicks((s) => s.clock);
  const [expiry, setExpiry] = useState<string>();
  const [mode, setMode] = useState<'oi' | 'chg' | 'both'>('both');
  const [since, setSince] = useState<Since>('prev');
  const [around, setAround] = useState(15);
  // Rolling windows re-anchor once a minute; 'open' is fixed for the session.
  const minute = clock ? Math.floor(clock.ts / 60_000) : 0;
  const date = clock?.date;
  const from = useMemo(() => {
    if (!date || since === 'prev') return undefined;
    if (since === 'open') return istTs(date, MARKET_OPEN_MIN);
    return minute * 60_000 - Number(since) * 60_000;
  }, [since, date, since === 'prev' || since === 'open' ? 0 : minute]);
  const q = useLive<StrikeOiResponse>(['strike-oi', symbol, expiry, from], `/oi/strikes/${symbol}${qs({ expiry, from })}`, 5000);
  const c = useChartColors();

  const view = useMemo(() => {
    const d = q.data;
    if (!d || !d.rows.length) return null;
    // The window is centred on the spot; without one on max pain; without either on the middle strike.
    const ref = d.spot ?? d.maxPain;
    const idx = ref === null ? Math.floor(d.rows.length / 2) : d.rows.reduce((bi, r, i) => (Math.abs(r.strike - ref) < Math.abs(d.rows[bi].strike - ref) ? i : bi), 0);
    const rows = d.rows.slice(Math.max(0, idx - around), idx + around + 1);
    const cats = rows.map((r) => String(r.strike));
    const spot = d.spot;
    const spotIdx = spot === null ? -1 : rows.findIndex((r, i) => i < rows.length - 1 && r.strike <= spot && rows[i + 1].strike > spot);
    const series: Record<string, unknown>[] = [];
    if (mode !== 'chg') {
      series.push({ name: 'Call OI', type: 'bar', data: rows.map((r) => r.ceOi), itemStyle: { color: c.down }, barGap: '10%' });
      series.push({ name: 'Put OI', type: 'bar', data: rows.map((r) => r.peOi), itemStyle: { color: c.up } });
    }
    if (mode !== 'oi') {
      series.push({ name: 'Call OI Chg', type: 'bar', data: rows.map((r) => r.ceChange), itemStyle: { color: c.down, opacity: mode === 'both' ? 0.45 : 1 } });
      series.push({ name: 'Put OI Chg', type: 'bar', data: rows.map((r) => r.peChange), itemStyle: { color: c.up, opacity: mode === 'both' ? 0.45 : 1 } });
    }
    // The spot marker is drawn only where the spot really lies inside the shown strikes.
    if (spot !== null && spotIdx >= 0) {
      series[0].markLine = {
        symbol: 'none',
        label: { formatter: `Spot ${formatIndian(spot)}`, color: c.accent, fontSize: 10 },
        lineStyle: { color: c.accent, width: 1.5 },
        data: [{ xAxis: spotIdx + (spot - rows[spotIdx].strike) / (rows[spotIdx + 1].strike - rows[spotIdx].strike) }],
      };
    }
    const option = {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' }, valueFormatter: (v: number | null) => formatCompact(v) },
      xAxis: { type: 'category', data: cats, ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      dataZoom: [{ type: 'inside' }],
      series,
    };
    const changesShown = rows.some((r) => r.ceChange !== null || r.peChange !== null);
    const blank = mode === 'chg' && !changesShown ? d.gaps?.change ?? 'OI change needs the previous close OI (official F&O file) or a recorded chain at that time' : undefined;
    const ce = sumOf(rows.map((r) => r.ceOi));
    const pe = sumOf(rows.map((r) => r.peOi));
    // PCR of the shown strikes: only strikes that have OI on both sides (as the chain PCR does).
    const both = rows.filter((r) => r.ceOi !== null && r.peOi !== null);
    const bothCe = both.reduce((a, r) => a + (r.ceOi as number), 0);
    const bothPe = both.reduce((a, r) => a + (r.peOi as number), 0);
    const pcr = bothCe > 0 ? bothPe / bothCe : null;
    return {
      option,
      blank,
      ce,
      pe,
      ceChg: sumOf(rows.map((r) => r.ceChange)),
      peChg: sumOf(rows.map((r) => r.peChange)),
      pcr,
      maxCe: maxRow(rows, (r) => r.ceOi),
      maxPe: maxRow(rows, (r) => r.peOi),
      maxCeChg: maxRow(rows, (r) => r.ceChange),
      maxPeChg: maxRow(rows, (r) => r.peChange),
      shown: rows.length,
      spotCentred: d.spot !== null,
      d,
    };
  }, [q.data, mode, around, c]);

  const noChange = (v: StrikeOiResponse | undefined) => v?.gaps?.change ?? 'OI change needs the previous close OI (official F&O file) or a recorded chain at that time';

  return (
    <div className="space-y-3">
      <PageHeader title="Open Interest Analysis" subtitle="Strike-wise call & put OI and change in OI — read support/resistance and fresh writing">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      <Loadable q={q} hint="Rolling windows (since open, 60m, 30m, 15m) need the chain recorded at that time; nothing is back-filled.">
        {() =>
          view && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat
                  label="Total Call OI"
                  value={view.ce ? formatCompact(view.ce.total) : null}
                  reason="No strike in the window has call OI"
                  sub={<span>Chg <Chg value={view.ceChg ? view.ceChg.total / 1e5 : null} decimals={2} reason={noChange(view.d)} /> L{view.ceChg && view.ce && view.ceChg.n < view.ce.n ? ` · ${view.ceChg.n} of ${view.ce.n} strikes` : ''}</span>}
                />
                <Stat
                  label="Total Put OI"
                  value={view.pe ? formatCompact(view.pe.total) : null}
                  reason="No strike in the window has put OI"
                  sub={<span>Chg <Chg value={view.peChg ? view.peChg.total / 1e5 : null} decimals={2} reason={noChange(view.d)} /> L{view.peChg && view.pe && view.peChg.n < view.pe.n ? ` · ${view.peChg.n} of ${view.pe.n} strikes` : ''}</span>}
                />
                <Stat
                  label="PCR (shown strikes)"
                  value={view.pcr === null ? null : formatFixed(view.pcr, 2)}
                  reason="Needs strikes with OI on both sides"
                  tone={view.pcr === null ? undefined : view.pcr >= 1 ? 'up' : 'down'}
                  hint="Put OI ÷ call OI over the shown strikes that have OI on both sides"
                  sub={<span>Max pain <span className="tabular-nums">{formatIndian(view.d.maxPain, 0)}</span></span>}
                />
                <Stat
                  label="Change measured from"
                  value={view.d.from === 'prev-close' ? 'Previous close' : formatSessionTime(view.d.fromTs)}
                  sub={view.d.from === 'prev-close' ? formatDateTime(view.d.fromTs) : formatDate(istParts(view.d.fromTs).date)}
                />
                <Stat label="Resistance (max CE OI)" value={view.maxCe ? formatIndian(view.maxCe.strike, 0) : null} reason="No call OI in the window" tone="down" sub={view.maxCe ? formatCompact(view.maxCe.value) : undefined} />
                <Stat label="Support (max PE OI)" value={view.maxPe ? formatIndian(view.maxPe.strike, 0) : null} reason="No put OI in the window" tone="up" sub={view.maxPe ? formatCompact(view.maxPe.value) : undefined} />
                <Stat
                  label="Max call writing"
                  value={view.maxCeChg && view.maxCeChg.value > 0 ? formatIndian(view.maxCeChg.strike, 0) : null}
                  reason={view.maxCeChg ? 'No strike in the window added call OI' : noChange(view.d)}
                  sub={view.maxCeChg && view.maxCeChg.value > 0 ? `+${formatCompact(view.maxCeChg.value)}` : undefined}
                />
                <Stat
                  label="Max put writing"
                  value={view.maxPeChg && view.maxPeChg.value > 0 ? formatIndian(view.maxPeChg.strike, 0) : null}
                  reason={view.maxPeChg ? 'No strike in the window added put OI' : noChange(view.d)}
                  sub={view.maxPeChg && view.maxPeChg.value > 0 ? `+${formatCompact(view.maxPeChg.value)}` : undefined}
                />
              </div>
              <Card
                title={`${symbol} strike-wise OI`}
                actions={
                  <>
                    <Segmented size="xs" value={mode} onChange={setMode} options={[{ value: 'oi', label: 'OI' }, { value: 'chg', label: 'Change' }, { value: 'both', label: 'Both' }]} />
                    <Segmented size="xs" value={since} onChange={setSince} options={[{ value: 'prev', label: 'vs Prev close' }, { value: 'open', label: 'Since open' }, { value: '60', label: '60m' }, { value: '30', label: '30m' }, { value: '15', label: '15m' }]} />
                    <Segmented size="xs" value={around} onChange={setAround} options={[{ value: 10, label: '±10' }, { value: 15, label: '±15' }, { value: 25, label: '±25' }]} />
                  </>
                }
              >
                <Chart option={view.option} height={420} blank={view.blank} />
                <div className="mt-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-3 text-2xs text-muted">
                    <AsOf ts={view.d.toTs} label="Chain as of" />
                    <span>{view.shown} of {view.d.rows.length} strikes with OI shown{view.spotCentred ? ' (centred on the spot)' : ' (spot not available: centred on max pain or the middle strike)'}</span>
                  </div>
                  <Coverage text={view.d.coverage} label="Max pain and PCR cover" />
                  <Gaps gaps={view.d.gaps} />
                </div>
              </Card>
            </>
          )
        }
      </Loadable>
    </div>
  );
}
