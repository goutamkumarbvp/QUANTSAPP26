import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  addDays,
  buildFromTemplate,
  defaultUnit,
  isWeekend,
  istParts,
  istTs,
  prevTradingDay,
  STRATEGY_TEMPLATES,
  type Leg,
  type OptionQuote,
  type RecapResponse,
} from '@q26/core';
import { Chart, axis, baseOption, useChartColors, pnlVisualMap } from '../components/Chart';
import { PayoffChart, StrategySummary, useStrategyView } from '../components/Payoff';
import { SymbolSelect } from '../components/pickers';
import { AsOf, Card, Coverage, cx, Dash, ErrorState, Field, Gaps, NoData, PageHeader, Spinner, Stat, Val } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatDateTime, formatExpiry, formatFixed, formatINR, formatIndian, isNum } from '../lib/format';
import { useChain } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

const QUICK = ['short-straddle', 'short-strangle', 'iron-condor', 'long-straddle', 'bull-call-spread', 'bear-put-spread'];

/** Weekdays strictly between two ISO dates (the client does not know the exchange holidays, so a holiday counts too). */
function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d < to; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

export default function Recap() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const clockDate = useTicks((s) => s.clock?.date);
  // First session the recorder holds (null: nothing recorded yet); undefined until the server has reported its feed status.
  const feed = useTicks((s) => s.clock?.feed);
  const recordingSince = feed?.recordingSince ?? null;
  const [date, setDate] = useState<string>(() => (clockDate ? prevTradingDay(clockDate) : ''));
  const [time, setTime] = useState('09:30');
  const [expiry, setExpiry] = useState<string>();
  const [legs, setLegs] = useState<Leg[]>([]);
  const [interval, setIntervalMin] = useState(5);
  const [note, setNote] = useState<string | null>(null);
  const effDate = date || (clockDate ? prevTradingDay(clockDate) : '');
  const [hh, mm] = time.split(':').map(Number);
  const at = effDate && Number.isFinite(hh) && Number.isFinite(mm) ? istTs(effDate, Math.min(15 * 60 + 29, Math.max(9 * 60 + 15, hh * 60 + mm))) : undefined;
  // Trade Recap replays recorded sessions only: a date before the first recorded session has nothing to show.
  const beforeRecording = !!effDate && !!feed && (recordingSince === null || effDate < recordingSince);
  const chain = useChain(symbol, expiry, { at, enabled: at !== undefined && !beforeRecording });
  const ch = chain.data && chain.data.symbol === symbol ? chain.data : undefined;
  const view = useStrategyView(symbol, legs, { at });
  const c = useChartColors();

  const replay = useMutation({
    mutationFn: () => api<RecapResponse>('/recap', { body: { symbol, legs, fromTs: at, intervalMin: interval } }),
  });

  const rows = useMemo(() => {
    if (!ch) return [];
    // Around the ATM strike; without one (no spot recorded) around the middle of the strikes.
    const i = ch.atm === null ? Math.floor(ch.rows.length / 2) : ch.rows.findIndex((r) => r.strike === ch.atm);
    return ch.rows.slice(Math.max(0, i - 10), i + 11);
  }, [ch]);

  const add = (type: 'CE' | 'PE', strike: number, side: 'BUY' | 'SELL', q: OptionQuote) => {
    // A leg's price is the last traded price at that moment: a contract that had not traded has none, so it cannot be entered.
    const price = q.ltp;
    if (!ch || price === null) return;
    setLegs((l) => [...l, { side, type, strike, expiry: ch.expiry, lots: 1, lotSize: ch.lotSize, price, iv: q.iv !== null ? q.iv / 100 : undefined }]);
    setNote(null);
    replay.reset();
  };

  const quick = (id: string) => {
    if (!ch) return;
    const t = STRATEGY_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    if (ch.spot === null) {
      setNote(ch.gaps?.spot ?? 'No spot price was recorded at that moment, so the template strikes cannot be placed around it.');
      return;
    }
    // Every leg is entered at a price that really traded at that moment; if any has none the template is not built.
    const missing: string[] = [];
    const built = buildFromTemplate(t, {
      spot: ch.spot,
      strikes: () => ch.rows.map((r) => r.strike),
      expiries: [ch.expiry],
      lotSize: ch.lotSize,
      unit: defaultUnit(ch.spot, ch.strikeStep),
      quote: (type, strike) => {
        const r = ch.rows.find((x) => x.strike === strike);
        const q = r ? (type === 'CE' ? r.ce : r.pe) : undefined;
        const price = type === 'FUT' ? ch.future : q?.ltp ?? null;
        if (price === null) {
          missing.push(type === 'FUT' ? 'the future' : `${strike} ${type}`);
          return { price: Number.NaN };
        }
        return { price, iv: q && q.iv !== null ? q.iv / 100 : undefined };
      },
      futureExpiry: ch.futureExpiry ?? undefined,
    });
    if (missing.length) {
      setNote(`${t.name} was not built: ${[...new Set(missing)].join(', ')} had no traded price at that moment.`);
      return;
    }
    setNote(null);
    setLegs(built);
    replay.reset();
  };

  const result = replay.data;
  const option = useMemo(() => {
    const pts = result?.points ?? [];
    // A trading day with no recorded session between two points is a gap in the line, not a bridge.
    const entries: { label: string; pnl: number | null; spot: number | null }[] = [];
    let prevDate = '';
    for (const p of pts) {
      const day = istParts(p.ts).date;
      if (prevDate && day !== prevDate && weekdaysBetween(prevDate, day) > 0) entries.push({ label: '', pnl: null, spot: null });
      entries.push({ label: formatDateTime(p.ts), pnl: p.pnl, spot: p.spot });
      prevDate = day;
    }
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatFixed(v, 2) },
      xAxis: { type: 'category', data: entries.map((p) => p.label), ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 10, formatter: (v: string) => (v ? v.slice(0, 6) + v.slice(-6) : '') } },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatINR(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      visualMap: pnlVisualMap(c),
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 0, borderColor: c.line, textStyle: { color: c.muted } }],
      grid: { left: 8, right: 12, top: 36, bottom: 30, containLabel: true },
      series: [
        // The break-even level is a reference line on the P&L series (a series of zeros would look like data).
        { name: 'P&L', type: 'line', symbol: 'none', areaStyle: { opacity: 0.12 }, data: entries.map((p) => p.pnl), markLine: { symbol: 'none', silent: true, lineStyle: { color: c.muted, width: 1 }, label: { show: false }, data: [{ yAxis: 0 }] } },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: entries.map((p) => p.spot) },
      ],
    };
  }, [result, c]);

  const sessionWhy = beforeRecording
    ? recordingSince
      ? `Trade Recap replays recorded sessions only. The first recorded session is ${formatDate(recordingSince, true)}; ${formatDate(effDate, true)} was not recorded.`
      : 'Trade Recap replays recorded sessions only, and no session has been recorded yet.'
    : null;
  const priced = (result?.points ?? []).filter((p) => isNum(p.pnl));
  const lastPriced = priced[priced.length - 1];

  return (
    <div className="space-y-3">
      <PageHeader title="Trade Recap" subtitle="Go back to a recorded date & time, take a position at that moment's traded prices, and replay how it played out over the recorded sessions">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setLegs([]); setExpiry(undefined); setNote(null); replay.reset(); }} />
      </PageHeader>
      <Card title="1 · Pick the moment">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date">
            <input className="input w-auto" type="date" value={effDate} min={recordingSince ?? undefined} max={clockDate} onChange={(e) => { setDate(e.target.value); setLegs([]); setNote(null); replay.reset(); }} />
          </Field>
          <Field label="Time (IST)">
            <input className="input w-auto" type="time" min="09:15" max="15:29" value={time} onChange={(e) => { setTime(e.target.value); setLegs([]); setNote(null); replay.reset(); }} />
          </Field>
          <Field label="Expiry (as recorded then)">
            <select className="input w-auto" value={ch?.expiry ?? ''} onChange={(e) => { setExpiry(e.target.value); setLegs([]); setNote(null); }} disabled={!ch}>
              {(ch?.expiries ?? []).map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
            </select>
          </Field>
          {ch && (
            <div className="text-sm">
              Spot then: <b><Val value={ch.spot} format={(x) => formatIndian(x)} reason={ch.gaps?.spot ?? 'No spot price was recorded at that moment'} /></b> · ATM IV <Val value={ch.atmIv} format={(x) => `${formatFixed(x, 2)}%`} reason={ch.gaps?.atmIv ?? 'ATM IV could not be solved from the recorded premiums'} /> · PCR <Val value={ch.pcr} format={(x) => formatFixed(x, 2)} reason={ch.gaps?.oi ?? 'Needs strikes with OI on both sides'} />{' '}
              <AsOf ts={ch.ts} label="chain recorded at" />
            </div>
          )}
        </div>
        <Coverage className="mt-2" text={recordingSince ? `Recorded sessions only — recording started on ${formatDate(recordingSince, true)}. Nothing before it (and no unrecorded day) can be replayed.` : feed ? 'No session has been recorded yet, so there is nothing to replay.' : undefined} />
      </Card>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card title="2 · Build the position (prices at that moment)" pad={false} className="lg:col-span-2">
          <div className="flex flex-wrap gap-1 border-b border-line p-2">
            {QUICK.map((id) => (
              <button key={id} className="btn-ghost px-2 py-1 text-xs" onClick={() => quick(id)} disabled={!ch}>{STRATEGY_TEMPLATES.find((t) => t.id === id)?.name ?? id}</button>
            ))}
          </div>
          {note && <div className="border-b border-line px-3 py-2 text-2xs text-warn">{note}</div>}
          {sessionWhy ? (
            <div className="p-3"><NoData compact title="Nothing recorded for this date" reason={sessionWhy} /></div>
          ) : chain.error ? (
            <div className="p-3"><ErrorState error={chain.error} compact title="Nothing recorded at that moment" /></div>
          ) : !ch ? (
            <Spinner />
          ) : (
            <div className="max-h-[420px] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr><th className="num">Call</th><th></th><th className="text-center">Strike</th><th></th><th className="num">Put</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.strike}>
                      <td className="num">{isNum(r.ce.ltp) ? formatFixed(r.ce.ltp, 2) : <Dash reason="This call had not traded at that moment" />}</td>
                      <td className="whitespace-nowrap">
                        <button className="rounded bg-up px-1.5 text-2xs font-bold text-white disabled:opacity-30" disabled={r.ce.ltp === null} title={r.ce.ltp === null ? 'No traded price at that moment' : 'Buy at the last traded price'} onClick={() => add('CE', r.strike, 'BUY', r.ce)}>B</button>{' '}
                        <button className="rounded bg-down px-1.5 text-2xs font-bold text-white disabled:opacity-30" disabled={r.ce.ltp === null} title={r.ce.ltp === null ? 'No traded price at that moment' : 'Sell at the last traded price'} onClick={() => add('CE', r.strike, 'SELL', r.ce)}>S</button>
                      </td>
                      <td className={cx('text-center font-semibold', r.strike === ch.atm && 'text-accent')}>{r.strike}</td>
                      <td className="whitespace-nowrap">
                        <button className="rounded bg-up px-1.5 text-2xs font-bold text-white disabled:opacity-30" disabled={r.pe.ltp === null} title={r.pe.ltp === null ? 'No traded price at that moment' : 'Buy at the last traded price'} onClick={() => add('PE', r.strike, 'BUY', r.pe)}>B</button>{' '}
                        <button className="rounded bg-down px-1.5 text-2xs font-bold text-white disabled:opacity-30" disabled={r.pe.ltp === null} title={r.pe.ltp === null ? 'No traded price at that moment' : 'Sell at the last traded price'} onClick={() => add('PE', r.strike, 'SELL', r.pe)}>S</button>
                      </td>
                      <td className="num">{isNum(r.pe.ltp) ? formatFixed(r.pe.ltp, 2) : <Dash reason="This put had not traded at that moment" />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t border-line px-3 py-2"><Coverage text="Prices are the last traded price at the chosen moment from the recorded chain; a contract that had not traded has no price and cannot be entered." /></div>
            </div>
          )}
        </Card>
        <Card title={`3 · Position (${legs.length} legs)`} className="lg:col-span-3" actions={legs.length > 0 && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setLegs([]); replay.reset(); }}>Clear</button>}>
          {!legs.length ? (
            <div className="py-8 text-center text-sm text-muted">Use B / S on the chain or a quick strategy to add legs.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {legs.map((l, i) => (
                  <span key={i} className={cx('chip gap-1 px-2 py-1 text-xs', l.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                    {l.side === 'BUY' ? 'B' : 'S'}
                    <input aria-label="Lots" className="w-8 rounded bg-transparent text-center" type="number" min={1} value={l.lots} onChange={(e) => setLegs((ls) => ls.map((x, j) => (j === i ? { ...x, lots: Math.max(1, Number(e.target.value) || 1) } : x)))} />
                    × {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`} @ {formatFixed(l.price, 2)}
                    <button onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                  </span>
                ))}
              </div>
              {view.analysis && <PayoffChart view={view} height={240} />}
              {view.analysis && <StrategySummary view={view} />}
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Replay step">
                  <select className="input w-auto" value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                    {[1, 5, 15, 30, 75].map((m) => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </Field>
                <button className="btn-primary" disabled={replay.isPending || at === undefined} onClick={() => replay.mutate()}>{replay.isPending ? 'Replaying…' : '⏵ Replay recorded sessions'}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {replay.error ? <ErrorState error={replay.error} title="Nothing to replay" hint="Trade Recap replays recorded sessions only; each lot size comes from the exchange listing or the official file of the contract’s last day." /> : null}
      {result && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label={result.expired ? 'Final P&L (at expiry)' : 'P&L at the last recorded point'}
              value={isNum(result.finalPnl) ? formatINR(result.finalPnl) : null}
              reason={result.gaps?.pnl ?? 'A leg did not trade in any replayed window'}
              tone={isNum(result.finalPnl) ? (result.finalPnl >= 0 ? 'up' : 'down') : undefined}
              sub={lastPriced ? formatDateTime(lastPriced.ts) : undefined}
            />
            <Stat label="Best point" value={isNum(result.maxPnl) ? formatINR(result.maxPnl) : null} reason="No window had a P&L" tone="up" />
            <Stat label="Worst point (max drawdown)" value={isNum(result.minPnl) ? formatINR(result.minPnl) : null} reason="No window had a P&L" tone="down" />
            <Stat label="Windows with a P&L" value={`${priced.length} of ${result.points.length}`} sub={result.expired ? 'Held to expiry' : 'Ends at the last recorded point'} />
          </div>
          <Card title="P&L replay">
            <Chart option={option} height={380} blank={priced.length ? undefined : result.gaps?.pnl ?? 'No window had a traded price for every leg'} />
            <div className="mt-2 space-y-1">
              <Coverage text={`Recorded sessions replayed: ${result.sessions.length ? result.sessions.map((s) => formatDate(s)).join(', ') : 'none'}. A leg is priced at the close of its last traded minute in each window; a window where a leg did not trade has no P&L. A gap in the line marks a weekday with no recorded session (or an exchange holiday).`} />
              <Gaps gaps={result.gaps} />
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
