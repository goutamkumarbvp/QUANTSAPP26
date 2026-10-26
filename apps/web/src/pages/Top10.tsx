import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Bias, Top10Response, Top10Row } from '@q26/core';
import { DataTable, type Column } from '../components/DataTable';
import { BuildUpBadge, Card, Chg, Coverage, cx, Dash, Gaps, Loadable, PageHeader, Stat, Val } from '../components/ui';
import { formatCompact, formatExpiry, formatFixed, formatIndian, isNum } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

/**
 * NIFTY Top 10: one desk for the index heavyweights — each stock's spot, near-month future, nearest option
 * chain and futures order flow side by side, with a transparent bias (four live readings, each with its
 * reason). Everything is live; a figure that is not available is "—" with the reason.
 */

const BIAS_TONE: Record<Bias['label'], string> = {
  Bullish: 'bg-up text-white',
  'Mild bullish': 'bg-up/20 text-up',
  Neutral: 'bg-panel2 text-muted',
  'Mild bearish': 'bg-down/20 text-down',
  Bearish: 'bg-down text-white',
  'No live reading': 'bg-panel2 text-muted',
};

const ORB_LABEL = { up: 'Broke above ↑', down: 'Broke below ↓', sideways: 'Inside the range', forming: 'Still forming' } as const;

const FLOW_LABEL = { buyers: 'Buyers', sellers: 'Sellers', 'buying-absorbed': 'Buying absorbed', 'selling-absorbed': 'Selling absorbed', balanced: 'Balanced' } as const;

function BiasPill({ b }: { b: Bias }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold', BIAS_TONE[b.label])} title={b.votes.map((v) => `${v.vote > 0 ? '+1' : v.vote < 0 ? '−1' : ' 0'}  ${v.why}`).join('\n')}>
      {b.label}
      {b.available > 0 && <span className="tabular-nums opacity-80">{b.score > 0 ? `+${b.score}` : b.score}/{b.available}</span>}
    </span>
  );
}

/** Buyer share of the flow window as a split bar (green buyers, red sellers). */
function FlowCell({ r }: { r: Top10Row }) {
  const f = r.flow;
  if (!f || !isNum(f.buyPct)) return <Dash reason={r.gaps?.flow ?? 'No recorded minutes of the future yet'} />;
  return (
    <div className="min-w-[6rem]" title={`${FLOW_LABEL[f.read]} — last ${f.window} min, ${f.buyPct}% of initiated quantity bought`}>
      <div className="flex justify-between text-2xs tabular-nums">
        <span className="text-up">{formatFixed(f.buyPct, 0)}%</span>
        <span className={cx(f.read === 'buyers' && 'text-up', f.read === 'sellers' && 'text-down', f.read.endsWith('absorbed') && 'text-warn')}>{FLOW_LABEL[f.read]}</span>
      </div>
      <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-down/70">
        <div className="bg-up" style={{ width: `${f.buyPct}%` }} />
      </div>
    </div>
  );
}

export default function Top10() {
  const q = useLive<Top10Response>(['top10'], '/top10', 5000);
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const go = (symbol: string, to: string) => {
    setSymbol(symbol);
    navigate(to);
  };

  const columns = useMemo<Column<Top10Row>[]>(
    () => [
      { key: 'rank', label: '#', num: true, value: (r) => r.rank, render: (r) => <span className="text-muted">{r.rank}</span> },
      {
        key: 'symbol',
        label: 'Stock',
        value: (r) => r.symbol,
        render: (r) => (
          <div className="leading-tight">
            <div className="font-semibold">{r.symbol}</div>
            <div className="hidden text-2xs text-muted md:block">{r.sector}</div>
          </div>
        ),
      },
      {
        key: 'spot',
        label: 'Spot',
        num: true,
        value: (r) => r.spot.changePct,
        render: (r) => (
          <div className="leading-tight">
            <Val value={r.spot.ltp} format={(x) => formatIndian(x)} reason={r.gaps?.options ?? 'No live spot price'} />
            <div className="text-2xs"><Chg value={r.spot.changePct} pct reason="Needs the previous close" /></div>
          </div>
        ),
      },
      {
        key: 'basis',
        label: <span title="Future − spot (and as % of spot)">Fut basis</span>,
        num: true,
        hideSm: true,
        value: (r) => r.future?.basisPct,
        render: (r) => (
          <div className="leading-tight">
            <Val value={r.future?.basis} format={(x) => formatFixed(x, 1)} reason={r.gaps?.future ?? 'Needs live spot and future'} />
            <div className="text-2xs text-muted">{isNum(r.future?.basisPct) ? `${formatFixed(r.future!.basisPct, 2)}%` : ''}</div>
          </div>
        ),
      },
      { key: 'oiChg', label: 'Fut OI chg', num: true, value: (r) => r.future?.oiChangePct, render: (r) => <Chg value={r.future?.oiChangePct} pct reason="Needs live OI and the previous session's OI" /> },
      { key: 'bu', label: 'Build-up', value: (r) => r.future?.buildUp, render: (r) => <BuildUpBadge value={r.future?.buildUp} short reason="Needs a live price and OI change vs the previous session" /> },
      {
        key: 'iv',
        label: <span title="ATM implied volatility solved from live premiums, and its change vs the previous close">ATM IV</span>,
        num: true,
        value: (r) => r.options?.atmIv,
        render: (r) => (
          <div className="leading-tight">
            <Val value={r.options?.atmIv} format={(x) => formatFixed(x, 1)} reason={r.gaps?.options ?? 'Needs live ATM premiums'} />
            <div className="text-2xs"><Chg value={r.options?.ivChange} reason="Needs the previous session's official option closes" /></div>
          </div>
        ),
      },
      { key: 'pcr', label: 'PCR', num: true, value: (r) => r.options?.pcr, render: (r) => <Val value={r.options?.pcr} format={(x) => formatFixed(x, 2)} reason="Needs strikes with OI on both sides" /> },
      {
        key: 'cpcr',
        label: <span title="Today's put OI added ÷ call OI added (vs the previous close)">Chg PCR</span>,
        num: true,
        value: (r) => r.options?.changePcr,
        render: (r) => <Val value={r.options?.changePcr} format={(x) => formatFixed(x, 2)} className={isNum(r.options?.changePcr) ? (r.options!.changePcr! >= 1.2 ? 'text-up' : r.options!.changePcr! <= 0.8 ? 'text-down' : '') : ''} reason="Needs live OI and the previous close; blank while the call OI change is under 0.1%" />,
      },
      {
        key: 'walls',
        label: <span title="Highest put-OI strike (support) / highest call-OI strike (resistance), and max pain">Support · Resist · Max pain</span>,
        hideSm: true,
        value: (r) => r.options?.maxPain,
        render: (r) => (
          <span className="tabular-nums text-xs">
            <span className="text-up"><Val value={r.options?.support} format={(x) => formatIndian(x, 0)} reason="No put OI" /></span>
            {' · '}
            <span className="text-down"><Val value={r.options?.resistance} format={(x) => formatIndian(x, 0)} reason="No call OI" /></span>
            {' · '}
            <Val value={r.options?.maxPain} format={(x) => formatIndian(x, 0)} reason="No OI" />
          </span>
        ),
      },
      {
        key: 'move',
        label: <span title="ATM call + put premium as % of spot: the move the options market prices to expiry">Implied move</span>,
        num: true,
        hideSm: true,
        value: (r) => r.options?.straddlePct,
        render: (r) => (
          <div className="leading-tight">
            <Val value={r.options?.straddlePct} format={(x) => `±${formatFixed(x, 2)}%`} reason={r.gaps?.straddle ?? 'Needs live ATM premiums'} />
            <div className="text-2xs text-muted">{r.options ? `${formatExpiry(r.options.expiry)} · ${formatFixed(r.options.daysToExpiry, 1)}d` : ''}</div>
          </div>
        ),
      },
      { key: 'flow', label: <span title="Future: buyer vs seller initiated quantity, last 15 minutes, read with the price">Flow 15m</span>, value: (r) => r.flow?.buyPct, render: (r) => <FlowCell r={r} /> },
      { key: 'bias', label: <span title="Sum of four live readings (futures build-up, flow, change PCR, opening range); hover for the reasons">Bias</span>, value: (r) => r.bias.score, render: (r) => <BiasPill b={r.bias} /> },
    ],
    [],
  );

  return (
    <div className="space-y-3">
      <PageHeader title="NIFTY Top 10 — F&O Desk" subtitle="The index heavyweights side by side: spot, near-month future, nearest option chain and futures order flow, with a transparent bias. Live ticks; click a stock for its readings." />
      <Loadable q={q} hint="Needs the Kotak login: the heavyweights' futures and option chains are streamed tick by tick.">
        {(d) => {
          const sel = d.rows.find((r) => r.symbol === open) ?? null;
          return (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Advancing / declining" value={`${d.basket.advancing} / ${d.basket.declining}`} tone={d.basket.advancing > d.basket.declining ? 'up' : d.basket.advancing < d.basket.declining ? 'down' : undefined} sub={`of ${d.rows.length} stocks`} />
                <Stat label="Bullish bias" value={d.basket.bullish} tone="up" />
                <Stat label="Bearish bias" value={d.basket.bearish} tone="down" />
                <Stat label="Neutral / no reading" value={d.basket.neutral} />
                <Stat label="Buyer share 15m" value={isNum(d.basket.buyPct) ? `${formatFixed(d.basket.buyPct, 1)}%` : null} reason="No recorded futures minutes yet" tone={isNum(d.basket.buyPct) ? (d.basket.buyPct >= 55 ? 'up' : d.basket.buyPct <= 45 ? 'down' : undefined) : undefined} sub="futures, average of the stocks" />
                <Stat label="Median ATM IV" value={isNum(d.basket.medianIv) ? formatFixed(d.basket.medianIv, 1) : null} reason="No ATM IV solved yet" />
              </div>
              <Card pad={false}>
                <DataTable rows={d.rows} rowKey={(r) => r.symbol} columns={columns} initialSort={{ key: 'rank', dir: 'asc' }} onRowClick={(r) => setOpen((o) => (o === r.symbol ? null : r.symbol))} empty="No stock of the list has live data yet" />
              </Card>
              {sel && (
                <Card
                  title={`${sel.symbol} — ${sel.name}`}
                  actions={
                    <>
                      <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => go(sel.symbol, '/option-chain')}>Option chain →</button>
                      <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => go(sel.symbol, '/order-book')}>Order flow & book →</button>
                    </>
                  }
                >
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-2xs uppercase tracking-wide text-muted">Bias readings</div>
                      <ul className="space-y-1 text-sm">
                        {sel.bias.votes.map((v) => (
                          <li key={v.factor} className="flex gap-2">
                            <span className={cx('w-6 shrink-0 text-right font-semibold tabular-nums', v.vote > 0 && 'text-up', v.vote < 0 && 'text-down', v.vote === 0 && 'text-muted')}>{v.vote > 0 ? '+1' : v.vote < 0 ? '−1' : '0'}</span>
                            <span className={cx(!v.available && 'text-muted')}>{v.why}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><div className="text-2xs text-muted">Future</div><Val value={sel.future?.ltp} format={(x) => formatIndian(x)} reason="No live future price" /> <span className="text-2xs text-muted">{sel.future ? formatExpiry(sel.future.expiry) : ''}</span></div>
                      <div><div className="text-2xs text-muted">Future OI</div><Val value={sel.future?.oi} format={(x) => formatCompact(x)} reason="No live OI" /></div>
                      <div><div className="text-2xs text-muted">ATM strike · straddle</div><Val value={sel.options?.atm} format={(x) => formatIndian(x, 0)} reason="No ATM strike" /> · <Val value={sel.options?.straddle} format={(x) => formatFixed(x, 2)} reason={sel.gaps?.straddle ?? 'No live ATM premiums'} /></div>
                      <div><div className="text-2xs text-muted">Session delta (future)</div><Chg value={sel.flow?.sessionDelta} decimals={0} reason="No recorded minutes of the future yet" /></div>
                      <div><div className="text-2xs text-muted">Lot size</div>{sel.lotSize ?? <Dash reason="Lot size not known" />}</div>
                      <div><div className="text-2xs text-muted">Opening range (15 min)</div>{sel.orbTrend ? ORB_LABEL[sel.orbTrend] : <Dash reason={sel.gaps?.trend ?? 'Not available'} />}</div>
                    </div>
                  </div>
                  <div className="mt-2"><Gaps gaps={sel.gaps} /></div>
                </Card>
              )}
              <div className="space-y-1">
                <Coverage text={d.listSource} />
                <Coverage text="Bias = sum of four live readings: futures build-up, buyer vs seller initiated quantity (15 min, with the price), today's change-in-OI PCR, and the 15-minute opening range. A reading that is not available never votes. An indicator summary to support a view, not a trading signal." />
                <Gaps gaps={d.gaps} />
              </div>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
