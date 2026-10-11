import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatExpiry, formatIndian, type BuildUp, type BuildUpCounts, type Candle, type FiiDiiDay, type FlowSummary, type MarketClockInfo, type OrbTrend, type Quote } from '@q26/core';
import { TrendBadge, sentimentTone } from '../components/trend';
import { Chart, baseOption, axis, useChartColors } from '../components/Chart';
import { BuildUpBadge, Card, Chg, Loadable, PageHeader } from '../components/ui';
import { useLive } from '../lib/hooks';
import { NAV } from '../lib/nav';
import { useApp, useTicks } from '../lib/store';
import { formatCompact } from '../lib/format';

interface Mover {
  symbol: string;
  ltp: number;
  changePct: number;
  oiChangePct: number;
  buildUp: BuildUp;
}

interface Dashboard {
  clock: MarketClockInfo;
  indices: Quote[];
  gainers: Mover[];
  losers: Mover[];
  oiGainers: Mover[];
  buildUpCounts: BuildUpCounts;
  chains: {
    symbol: string; expiry: string; pcr: number; maxPain: number; atmIv: number; ivChange: number; support: number; resistance: number; spot: number; daysToExpiry: number;
    orb: { high: number; low: number; trend: OrbTrend; whipsaw: boolean; reentered: boolean; summary: string };
    flow: { buyPct: number; delta: number; sentiment: FlowSummary['sentiment']; ts: number } | null;
  }[];
  fiiDii: FiiDiiDay[];
}

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
      series: [{ type: 'line', data, symbol: 'none', lineStyle: { width: 1.5, color }, areaStyle: { color, opacity: 0.08 } }],
    };
  }, [q.data, up, c]);
  return <Chart option={option} height={44} />;
}

function IndexCard({ q }: { q: Quote }) {
  const live = useTicks((s) => s.quotes[q.symbol]) ?? q;
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
        <span>IV {live.atmIv.toFixed(1)}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{formatIndian(live.ltp)}</div>
      <div className="flex items-center justify-between text-xs">
        <Chg value={live.change} />
        <Chg value={live.changePct} pct />
      </div>
      <Spark symbol={q.symbol} up={live.change >= 0} />
      <div className="text-2xs text-muted">
        Fut {formatIndian(live.future)} · H {formatIndian(live.high)} · L {formatIndian(live.low)}
      </div>
    </button>
  );
}

function MoverTable({ title, rows, metric }: { title: string; rows: Mover[]; metric: 'price' | 'oi' }) {
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  return (
    <Card title={title} pad={false}>
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
              <td className="num">{formatIndian(r.ltp)}</td>
              <td className="num">{metric === 'price' ? <Chg value={r.changePct} pct /> : <Chg value={r.oiChangePct} pct />}</td>
              <td>
                <BuildUpBadge value={r.buildUp} short />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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

export default function Home() {
  const q = useLive<Dashboard>(['dashboard'], '/dashboard', 5000);
  const quick = NAV.flatMap((g) => g.items).filter((i) => ['/option-chain', '/orb', '/order-flow', '/builder', '/optimizer', '/oi/strikes', '/straddle', '/scanners'].includes(i.to));
  return (
    <div className="space-y-3">
      <PageHeader title="Market Overview" subtitle="Indices, derivatives snapshot, movers and institutional flows" />
      <Loadable q={q}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
              {d.indices.map((x) => (
                <IndexCard key={x.symbol} q={x} />
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              {quick.map((t) => (
                <Link key={t.to} to={t.to} className="card flex flex-col items-center gap-1 px-2 py-3 text-center text-xs hover:border-accent/60">
                  <span className="text-xl">{t.icon}</span>
                  <span className="font-medium">{t.label}</span>
                </Link>
              ))}
            </div>

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
                      <th className="num">ATM IV</th>
                      <th className="num">Support (PE OI)</th>
                      <th className="num">Resistance (CE OI)</th>
                      <th className="num">DTE</th>
                      <th className="num">15m range H / L</th>
                      <th>Trend</th>
                      <th className="num">1-min flow (fut)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.chains.map((c) => (
                      <tr key={c.symbol}>
                        <td className="font-semibold">{c.symbol}</td>
                        <td>{formatExpiry(c.expiry)}</td>
                        <td className="num">{formatIndian(c.spot)}</td>
                        <td className={`num ${c.pcr >= 1 ? 'text-up' : 'text-down'}`}>{c.pcr.toFixed(2)}</td>
                        <td className="num">{formatIndian(c.maxPain, 0)}</td>
                        <td className="num">
                          {c.atmIv.toFixed(2)} <Chg value={c.ivChange} className="text-2xs" />
                        </td>
                        <td className="num text-up">{formatIndian(c.support, 0)}</td>
                        <td className="num text-down">{formatIndian(c.resistance, 0)}</td>
                        <td className="num">{c.daysToExpiry.toFixed(1)}</td>
                        <td className="num">
                          <Link to="/orb" className="hover:underline">{formatIndian(c.orb.high, 0)} / {formatIndian(c.orb.low, 0)}</Link>
                        </td>
                        <td title={c.orb.summary}>
                          <TrendBadge trend={c.orb.trend} whipsaw={c.orb.whipsaw} reentered={c.orb.reentered} />
                        </td>
                        <td className={`num ${c.flow ? sentimentTone(c.flow.sentiment) : 'text-muted'}`}>
                          <Link to="/order-flow" className="hover:underline">{c.flow ? `${c.flow.buyPct.toFixed(0)}% buy` : '—'}</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {(['Long Build-up', 'Short Build-up', 'Short Covering', 'Long Unwinding'] as BuildUp[]).map((b) => (
                <Link key={b} to={`/scanners?id=${b.toLowerCase().replace(' build-up', '-buildup').replace(' ', '-')}`} className="card card-pad hover:border-accent/60">
                  <div className="flex items-center justify-between">
                    <BuildUpBadge value={b} />
                    <span className="text-xl font-bold tabular-nums">{d.buildUpCounts[b]}</span>
                  </div>
                  <div className="mt-1 text-2xs text-muted">F&O stocks (futures price vs OI)</div>
                </Link>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <MoverTable title="Top Gainers" rows={d.gainers} metric="price" />
              <MoverTable title="Top Losers" rows={d.losers} metric="price" />
              <MoverTable title="OI Gainers (Futures)" rows={d.oiGainers} metric="oi" />
            </div>

            <Card title="FII / DII cash flows (last sessions)" actions={<Link to="/fii-dii" className="text-xs text-accent">More →</Link>}>
              <FlowsChart days={d.fiiDii} />
              <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {d.fiiDii.slice(-1).map((x) => (
                  <div key={x.date} className="contents">
                    <div>FII net: <Chg value={x.fiiNet} /> Cr</div>
                    <div>DII net: <Chg value={x.diiNet} /> Cr</div>
                    <div className="text-muted">FII gross buy ₹{formatCompact(x.fiiBuy * 1e7)}</div>
                    <div className="text-muted">DII gross buy ₹{formatCompact(x.diiBuy * 1e7)}</div>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
