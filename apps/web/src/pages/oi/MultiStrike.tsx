import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatIndian, istTs, type MultiStrikeResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Coverage, cx, Dash, Gaps, Loadable, PageHeader, Segmented } from '../../components/ui';
import { errorText, isNoLiveData, qs } from '../../lib/api';
import { formatCompact, formatFixed, formatSessionTime, isNum } from '../../lib/format';
import { useChain, useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

type Metric = 'oi' | 'ltp' | 'iv';

const METRIC_NOTE: Record<Metric, string> = {
  oi: 'Recorded open interest of the streamed strikes, as of the end of each window (blank where nothing was recorded).',
  ltp: 'Close of the last traded minute in each window (blank where the contract did not trade).',
  iv: 'IV solved from that traded premium with the recorded forward of the window (blank where either is missing).',
};

/** Latest real value of a series and the index it sits at (null when the series has none). */
function latest(values: (number | null)[]): { v: number; i: number } | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (isNum(v)) return { v, i };
  }
  return null;
}

/** Change between the first and the last real value of a series (null with fewer than two). */
function span(values: (number | null)[]): { change: number; from: number; to: number } | null {
  const idx = values.flatMap((v, i) => (isNum(v) ? [i] : []));
  if (idx.length < 2) return null;
  const from = idx[0];
  const to = idx[idx.length - 1];
  return { change: (values[to] as number) - (values[from] as number), from, to };
}

export default function MultiStrike() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [params] = useSearchParams();
  const [expiry, setExpiry] = useState<string>();
  const [picked, setPicked] = useState<number[]>(() => (params.get('strikes') ?? '').split(',').map(Number).filter((x) => x > 0));
  const [type, setType] = useState<'CE' | 'PE' | 'both'>('both');
  const [metric, setMetric] = useState<Metric>('oi');
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  // The strike buttons come from the chain of that session (today's live chain, or the chain recorded at that day's close).
  const at = date && today && date < today ? istTs(date, 15 * 60 + 29) : undefined;
  const chain = useChain(symbol, expiry, at ? { at } : { refetch: 30000 });
  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  const atm = chain.data?.atm ?? null;
  // Without picked strikes the server centres the series on the recorded ATM (no client-side default strikes).
  const q = useLive<MultiStrikeResponse>(['multi-strike', symbol, expiry, picked.join(','), interval, date], `/oi/multi-strike/${symbol}${qs({ expiry, strikes: picked.join(','), interval, date })}`, date ? false : 15000);
  const c = useChartColors();
  const shown = q.data?.series.map((s) => s.strike).filter((k, i, a) => a.indexOf(k) === i) ?? [];
  const active = picked.length ? picked : shown;

  const option = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    const series = d.series
      .filter((s) => type === 'both' || s.type === type)
      .map((s, i) => ({
        name: `${s.strike} ${s.type}`,
        type: 'line',
        symbol: 'none',
        smooth: false,
        lineStyle: { width: 1.8, type: s.type === 'PE' ? 'dashed' : 'solid' },
        itemStyle: { color: c.series[(i >> (type === 'both' ? 1 : 0)) % c.series.length] },
        data: d.times.map((t, j) => [t, s[metric][j]]),
      }));
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => (metric === 'oi' ? formatCompact(v) : formatFixed(v, 2)) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => (metric === 'oi' ? formatCompact(v) : v.toFixed(metric === 'iv' ? 1 : 0)) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [...series, { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1, color: c.muted }, itemStyle: { color: c.muted }, data: d.times.map((t, j) => [t, d.spot[j]]) }],
    };
  }, [q.data, type, metric, c]);
  // Nothing of the chosen metric was recorded for the shown contracts: say so instead of drawing the spot alone.
  const blank = useMemo(() => {
    const d = q.data;
    if (!d) return undefined;
    const rows = d.series.filter((s) => type === 'both' || s.type === type);
    return rows.some((s) => s[metric].some(isNum)) ? undefined : d.gaps?.strikes ?? `No recorded ${metric === 'oi' ? 'open interest' : metric === 'ltp' ? 'traded premium' : 'IV'} for the shown contracts on ${d.date}`;
  }, [q.data, type, metric]);

  const toggle = (k: number) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...(p.length ? p : active), k].slice(-6)));
  const step = chain.data?.strikeStep;
  const near = atm !== null && step ? strikes.filter((k) => Math.abs(k - atm) <= step * 6) : [];

  return (
    <div className="space-y-3">
      <PageHeader title="Multi-Strike OI" subtitle="How OI, premium and IV of selected strikes evolved through the session — from the minutes this app recorded">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); setPicked([]); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      <Card title="Strikes (max 6)">
        {near.length ? (
          <div className="flex flex-wrap gap-1">
            {near.map((k) => (
              <button key={k} onClick={() => toggle(k)} className={cx('chip cursor-pointer px-2 py-1 text-xs', active.includes(k) ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-ink', k === atm && !active.includes(k) && 'ring-1 ring-accent')}>
                {k}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted">
            {chain.isLoading ? 'Loading the strikes…' : chain.error ? `The strike list needs the option chain: ${errorText(chain.error)}` : 'The strike list needs the chain’s ATM strike, which is not available.'}
            {!picked.length && q.data ? ' The series shown are centred on the recorded ATM strike.' : ''}
          </div>
        )}
      </Card>
      <Card
        title={`${symbol} · ${active.join(', ') || 'strikes around the recorded ATM'}`}
        actions={
          <>
            <Segmented size="xs" value={type} onChange={setType} options={[{ value: 'both', label: 'CE+PE' }, { value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]} />
            <Segmented size="xs" value={metric} onChange={setMetric} options={[{ value: 'oi', label: 'OI' }, { value: 'ltp', label: 'Premium' }, { value: 'iv', label: 'IV' }]} />
          </>
        }
      >
        <Loadable q={q} hint="Only strikes the recorder streamed on that session can be charted; nothing is back-filled.">
          {(d) => (
            <>
              <Chart option={option} height={420} blank={blank} />
              <div className="mt-2 space-y-1">
                <Coverage text={`${METRIC_NOTE[metric]} Session ${d.date}, expiry ${d.expiry}.`} />
                <Gaps gaps={d.gaps} />
              </div>
            </>
          )}
        </Loadable>
      </Card>
      {q.data && !isNoLiveData(q.error) && (
        <Card title="Latest values" pad={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th className="num">OI</th>
                  <th className="num" title="Last recorded OI minus the first recorded OI of the shown session (the first point is where recording of the contract began)">OI chg (recorded span)</th>
                  <th className="num">Premium</th>
                  <th className="num" title="Solved from the traded premium with the recorded forward">IV</th>
                  <th className="num">Window end</th>
                </tr>
              </thead>
              <tbody>
                {q.data.series.map((s) => {
                  const times = q.data!.times;
                  const n = times.length - 1;
                  const oi = latest(s.oi);
                  const ltp = latest(s.ltp);
                  const iv = latest(s.iv);
                  const chg = span(s.oi);
                  // A value older than the last window carries its own time.
                  const stamp = (x: { i: number } | null) => (x && x.i < n ? <span className="ml-1 text-2xs text-muted">{formatSessionTime(times[x.i])}</span> : null);
                  return (
                    <tr key={`${s.strike}${s.type}`}>
                      <td className="font-medium">{s.strike} {s.type}</td>
                      <td className="num">{oi ? formatCompact(oi.v) : <Dash reason="No OI recorded for this contract" />}{stamp(oi)}</td>
                      <td className={cx('num', chg ? (chg.change >= 0 ? 'text-up' : 'text-down') : '')}>{chg ? formatCompact(chg.change) : <Dash reason="Needs two recorded OI points" />}</td>
                      <td className="num">{ltp ? formatFixed(ltp.v, 2) : <Dash reason="The contract did not trade in the recorded windows" />}{stamp(ltp)}</td>
                      <td className="num">{iv ? formatFixed(iv.v, 2) : <Dash reason="Needs a traded premium and a recorded forward" />}{stamp(iv)}</td>
                      <td className="num">{formatSessionTime(times[n])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
