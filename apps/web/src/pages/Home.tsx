import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ORDER_FLOW_METHOD, type BuildUp, type Candle, type DashboardChain, type DashboardMover, type DashboardResponse, type FiiDiiDay, type Quote } from '@q26/core';
import { OperationsPanel } from '../components/Operations';
import { TrendBadge } from '../components/trend';
import { Chart, baseOption, axis, useChartColors } from '../components/Chart';
import { AsOf, BuildUpBadge, Card, Chg, Coverage, Dash, flowTone, Gaps, Loadable, NoData, PageHeader, Val } from '../components/ui';
import { useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';
import { formatCompact, formatDate, formatExpiry, formatFixed, formatIndian, formatSessionTime, isNum } from '../lib/format';

/** Sparkline of today's 5-minute closes; blank (not an empty axis) while there are no candles. */
function Spark({ symbol, up }: { symbol: string; up: boolean }) {
  const c = useChartColors();
  const q = useLive<Candle[]>(['candles', symbol, 5], `/candles/${symbol}?interval=5`, 30000);
  const option = useMemo(() => {
    const data = (q.data ?? []).map((d) => d.close);
    const color = up ? c.up : c.down;
    return {
      animation: false,
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: 'category', show: false, data: data.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{ type: 'line', data, symbol: 'none', connectNulls: false, lineStyle: { width: 1.5, color }, areaStyle: { color, opacity: 0.08 } }],
    };
  }, [q.data, up, c]);
  if (!q.data?.length) return <div className="flex h-11 items-center text-2xs text-muted" title={q.error instanceof Error ? q.error.message : undefined}>No intraday candles</div>;
  // Recorded candles whose volume leaves units out (a recording restart inside a minute, or units reported after a feed gap) say so.
  const partial = q.data.some((d) => d.partial);
  const gap = q.data.some((d) => isNum(d.gapVolume) && d.gapVolume > 0);
  return (
    <>
      <Chart option={option} height={44} />
      {(partial || gap) && (
        <div className="text-2xs text-warn" title="Candle volume counts only the minutes recorded in full; units reported after a feed gap are not placed in any candle's volume">
          {partial ? 'Some candle volumes are partial (recording restarted inside a minute)' : 'Some volume was reported after a feed gap (not in candle volume)'}
        </div>
      )}
    </>
  );
}

function IndexCard({ q }: { q: Quote }) {
  // The websocket's quote is fresher than the poll when it is newer.
  const ws = useTicks((s) => s.quotes[q.symbol]);
  const live = ws && ws.ts >= q.ts ? ws : q;
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  return (
    <button
      className="card card-pad text-left transition-colors hover:border-accent/60"
      onClick={() => {
        setSymbol(q.symbol);
        navigate('/option-chain');
      }}
    >
      <div className="flex items-center justify-between text-xs text-muted">
        <span className="font-semibold text-ink">{q.symbol}</span>
        <span title="ATM IV solved from live option premiums">IV <Val value={live.atmIv} format={(x) => x.toFixed(1)} reason="ATM IV needs live option premiums" /></span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{formatIndian(live.ltp)}</div>
      <div className="flex items-center justify-between text-xs">
        <Chg value={live.change} reason="Needs the previous close" />
        <Chg value={live.changePct} pct reason="Needs the previous close" />
      </div>
      <Spark symbol={q.symbol} up={(live.change ?? 0) >= 0} />
      <div className="text-2xs text-muted">
        Fut <Val value={live.future} reason="No live near-month future price" /> · H <Val value={live.high} reason="Day high not available" /> · L <Val value={live.low} reason="Day low not available" />
      </div>
      <AsOf ts={live.ts} label="LTP" />
    </button>
  );
}

function MoverTable({ title, rows, metric, reason, none }: { title: string; rows: DashboardMover[]; metric: 'price' | 'oi'; reason?: string; none: string }) {
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  return (
    <Card title={title} pad={false}>
      {rows.length === 0 ? (
        <div className="p-3">
          <NoData compact title={reason ? 'Not available' : none} reason={reason} />
        </div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="num">LTP</th>
              <th className="num">{metric === 'price' ? '% Chg' : 'OI Chg'}</th>
              <th>Build-up</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="cursor-pointer" onClick={() => { setSymbol(r.symbol); navigate('/option-chain'); }}>
                <td className="font-medium">{r.symbol}</td>
                <td className="num"><Val value={r.ltp} reason="No trade in the live session yet" /></td>
                <td className="num">{metric === 'price' ? <Chg value={r.changePct} pct reason="Needs the previous close" /> : <Chg value={r.oiChangePct} pct reason="Needs the previous session's OI" />}</td>
                <td>
                  <BuildUpBadge value={r.buildUp} short reason="Needs price and OI change vs the previous session" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function FlowsChart({ days }: { days: FiiDiiDay[] }) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: days.map((d) => d.date.slice(5)), ...axis(c) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${(v / 1000).toFixed(1)}k` } },
      series: [
        { name: 'FII net (₹ Cr)', type: 'bar', data: days.map((d) => d.fiiNet), itemStyle: { color: c.series[0] } },
        { name: 'DII net (₹ Cr)', type: 'bar', data: days.map((d) => d.diiNet), itemStyle: { color: c.series[1] } },
      ],
    }),
    [days, c],
  );
  return <Chart option={option} height={200} />;
}

/** One index chain card (a row of the derivatives snapshot): each part is blank on its own, with its reason. */
function ChainRow({ c, onOpen }: { c: DashboardChain; onOpen: (symbol: string) => void }) {
  const chainWhy = (specific: string) => c.gaps?.chain ?? specific;
  const strikesWhy = chainWhy('Needs strikes with open interest on both sides');
  const f = c.flow;
  return (
    <tr>
      <td className="font-semibold">{c.symbol}</td>
      <td>{c.expiry ? formatExpiry(c.expiry) : <Dash reason={chainWhy('No listed expiry')} />}</td>
      <td className="num"><Val value={c.spot} reason={chainWhy('No live spot price')} /></td>
      <td className={`num ${c.pcr === null ? '' : c.pcr >= 1 ? 'text-up' : 'text-down'}`}><Val value={c.pcr} format={(x) => x.toFixed(2)} reason={strikesWhy} /></td>
      <td className="num"><Val value={c.maxPain} format={(x) => formatIndian(x, 0)} reason={strikesWhy} /></td>
      <td className="num">
        {/* One dash when neither the IV nor its change is available (not "— —"). */}
        {!isNum(c.atmIv) && !isNum(c.ivChange) ? (
          <Dash reason={chainWhy('ATM IV needs live option premiums')} />
        ) : (
          <>
            <Val value={c.atmIv} format={(x) => x.toFixed(2)} reason={chainWhy('ATM IV needs live option premiums')} /> <Chg value={c.ivChange} className="text-2xs" reason="Needs the previous session's official option closes" />
          </>
        )}
      </td>
      <td className="num text-up"><Val value={c.support} format={(x) => formatIndian(x, 0)} reason={strikesWhy} /></td>
      <td className="num text-down"><Val value={c.resistance} format={(x) => formatIndian(x, 0)} reason={strikesWhy} /></td>
      <td className="num"><Val value={c.daysToExpiry} format={(x) => x.toFixed(1)} reason={chainWhy('No listed expiry')} /></td>
      <td className="num">
        {c.orb ? (
          <>
            <Link to="/orb" onClick={() => onOpen(c.symbol)} className="hover:underline">{formatIndian(c.orb.high, 0)} / {formatIndian(c.orb.low, 0)}</Link>
            {!c.orb.live && <div className="text-2xs text-muted" title={c.orb.note ?? undefined}>previous session · {formatDate(c.orb.date)}</div>}
          </>
        ) : (
          <Dash reason={c.gaps?.orb ?? 'Opening range not available'} />
        )}
      </td>
      <td title={c.orb?.summary}>
        {c.orb ? <TrendBadge trend={c.orb.trend} whipsaw={c.orb.whipsaw} reentered={c.orb.reentered} /> : <Dash reason={c.gaps?.orb ?? 'Opening range not available'} />}
      </td>
      <td className={`num ${f ? flowTone(f.sentiment) : 'text-muted'}`} title={f ? `${f.method} · minute ${formatSessionTime(f.ts)}` : undefined}>
        {f ? (
          <>
            <Link to="/order-book" onClick={() => onOpen(c.symbol)} className="hover:underline">
              {f.sentiment === 'Feed gap' ? 'feed gap' : f.buyPct === null ? 'not classified' : `${formatFixed(f.buyPct, 0)}% buy`}
            </Link>
            <div className="text-2xs text-muted">
              {f.unclassifiedPct !== null && f.unclassifiedPct > 0 ? `${formatFixed(f.unclassifiedPct, 0)}% unclassified` : null}
              {f.gapVolume > 0 ? <span className="text-warn"> feed gap</span> : null}
              {f.partial ? <span className="text-warn"> partial (lower bound)</span> : null}
            </div>
          </>
        ) : (
          <Dash reason={c.gaps?.flow ?? 'No completed recorded minute yet'} />
        )}
      </td>
    </tr>
  );
}

export default function Home() {
  const q = useLive<DashboardResponse>(['dashboard'], '/dashboard', 5000);
  const setSymbol = useApp((s) => s.setSymbol);
  return (
    <div className="space-y-3">
      <PageHeader title="Market Overview" subtitle="Indices, derivatives snapshot, movers and institutional flows" />
      {/* Login monitor, 24×7 watchdog and weekly audit: independent of the market data below. */}
      <OperationsPanel />
      <Loadable q={q}>
        {(d) => {
          const g = d.gaps ?? {};
          const latest = d.fiiDii[d.fiiDii.length - 1];
          const notes = d.chains.flatMap((c) => [c.orb?.note ? `${c.symbol}: ${c.orb.note}` : null, c.flow?.note ? `${c.symbol}: ${c.flow.note}` : null]).filter((x): x is string => !!x);
          const coverage = [...new Set(d.chains.map((c) => c.coverage).filter((x): x is string => !!x))];
          const withGaps = d.chains.filter((c) => c.gaps && Object.keys(c.gaps).length);
          return (
            <>
              {d.indices.length ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                  {d.indices.map((x) => (
                    <IndexCard key={x.symbol} q={x} />
                  ))}
                </div>
              ) : (
                <NoData compact title="No live index prices" reason={g.indices} />
              )}
              {d.indices.length > 0 && g.indices ? <Gaps gaps={g} only={['indices']} /> : null}

              <Card title="Derivatives snapshot" pad={false}>
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Index</th>
                        <th>Expiry</th>
                        <th className="num">Spot</th>
                        <th className="num">PCR</th>
                        <th className="num">Max Pain</th>
                        <th className="num" title="Solved from live premiums">ATM IV</th>
                        <th className="num">Support (PE OI)</th>
                        <th className="num">Resistance (CE OI)</th>
                        <th className="num">DTE</th>
                        <th className="num">15m range H / L</th>
                        <th>Trend</th>
                        <th className="num" title={ORDER_FLOW_METHOD}>1-min flow (fut)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.chains.map((c) => (
                        <ChainRow key={c.symbol} c={c} onOpen={setSymbol} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-1 border-t border-line px-3 py-2">
                  {coverage.map((t) => (
                    <Coverage key={t} label="PCR, max pain, support / resistance" text={t} />
                  ))}
                  <Coverage label="1-min flow" text={`last completed recorded minute of the near future, ${ORDER_FLOW_METHOD}; unclassified volume is never split between buyers and sellers`} />
                  {notes.map((t) => (
                    <Coverage key={t} text={t} />
                  ))}
                  {withGaps.map((c) => (
                    <div key={c.symbol} className="flex gap-2 text-2xs text-muted">
                      <span className="font-semibold text-ink/80">{c.symbol}</span>
                      <Gaps gaps={c.gaps} />
                    </div>
                  ))}
                </div>
              </Card>

              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {(['Long Build-up', 'Short Build-up', 'Short Covering', 'Long Unwinding'] as BuildUp[]).map((b) => (
                  <Link key={b} to={`/scanners?id=${b.toLowerCase().replace(' build-up', '-buildup').replace(' ', '-')}`} className="card card-pad hover:border-accent/60">
                    <div className="flex items-center justify-between">
                      <BuildUpBadge value={b} />
                      <span className="text-xl font-bold tabular-nums">{d.buildUpCounts ? d.buildUpCounts[b] : <Dash reason={g.buildUpCounts ?? 'No stock future has a live build-up yet'} />}</span>
                    </div>
                    <div className="mt-1 text-2xs text-muted">F&O stocks (futures price vs OI)</div>
                  </Link>
                ))}
                <div className="col-span-2 space-y-0.5 lg:col-span-4">
                  <Coverage text={d.buildUpTotal ? `${d.buildUpClassified} of ${d.buildUpTotal} stock futures have a live build-up (price and OI change vs the previous session)` : null} />
                  <Gaps gaps={g} only={['buildUpCounts']} />
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-3">
                <MoverTable title="Top Gainers" rows={d.gainers} metric="price" reason={g.movers} none="No stock is up today" />
                <MoverTable title="Top Losers" rows={d.losers} metric="price" reason={g.movers} none="No stock is down today" />
                <MoverTable title="OI Gainers (Futures)" rows={d.oiGainers} metric="oi" reason={g.oiGainers} none="No stock future has added OI vs the previous session" />
              </div>

              <Card title="FII / DII cash flows (last sessions)" actions={<Link to="/fii-dii" className="text-xs text-accent">More →</Link>}>
                {d.fiiDii.length ? (
                  <>
                    <FlowsChart days={d.fiiDii} />
                    {latest && (
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                        <div>FII net: <Chg value={latest.fiiNet} /> Cr</div>
                        <div>DII net: <Chg value={latest.diiNet} /> Cr</div>
                        <div className="text-muted">FII gross buy ₹{formatCompact(latest.fiiBuy * 1e7)}</div>
                        <div className="text-muted">DII gross buy ₹{formatCompact(latest.diiBuy * 1e7)}</div>
                      </div>
                    )}
                    <Coverage className="mt-1" text={`Official NSE figures for ${formatDate(latest?.date, true)}${latest?.scope === 'nse' ? ' (NSE only)' : latest?.scope === 'combined' ? ' (NSE + BSE + MSEI)' : ''}; published after the close.`} />
                  </>
                ) : (
                  <NoData compact title="No official FII / DII data" reason={g.fiiDii} />
                )}
              </Card>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
