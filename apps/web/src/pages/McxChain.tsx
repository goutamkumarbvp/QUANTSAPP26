import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { McxChainResponse, McxLeg, McxSymbolsResponse } from '@q26/core';
import { Card, Chg, cx, ErrorState, Loadable, PageHeader, Spinner, Stat, Val } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatCompact, formatDateTime, formatExpiry, formatFixed, formatPrice, isNum } from '../lib/format';
import { adaptivePoll } from '../lib/hooks';

/**
 * MCX commodity option chain: live Kotak quotes only. MCX options settle into futures, so the price,
 * ATM strike and Black-76 IV use the future of the option's expiry. A value Kotak does not send is "—".
 */

const NO_QUOTE = 'Kotak sent no value for this contract';

function Leg({ q, side, itm }: { q: McxLeg | null; side: 'ce' | 'pe'; itm: boolean }) {
  const cells = q
    ? [
        <Val key="oi" value={q.oi} format={(x) => formatCompact(x)} reason={NO_QUOTE} />,
        <Val key="vol" value={q.volume} format={(x) => formatCompact(x)} reason={NO_QUOTE} />,
        <Val key="iv" value={q.iv} format={(x) => formatFixed(x * 100, 1)} reason={q.ltp === null ? 'No LTP' : 'IV could not be solved from the premium'} />,
        <span key="ltp" className="font-semibold">
          <Val value={q.ltp} format={formatPrice} reason="Not traded in this session" />
          <div className="text-2xs font-normal"><Chg value={q.changePct} pct reason="Needs the previous close" /></div>
        </span>,
      ]
    : [0, 1, 2, 3].map((i) => <span key={i} className="text-muted" title="No contract at this strike">—</span>);
  const ordered = side === 'ce' ? cells : [...cells].reverse();
  return (
    <>
      {ordered.map((c, i) => (
        <td key={i} className={cx('num px-2 py-1', itm && 'bg-itm')}>{c}</td>
      ))}
    </>
  );
}

export default function McxChain() {
  const [params, setParams] = useSearchParams();
  const symbols = useQuery({ queryKey: ['mcx-symbols'], queryFn: () => api<McxSymbolsResponse>('/mcx/symbols'), staleTime: 10 * 60_000 });
  const list = symbols.data?.symbols ?? [];
  const symbol = params.get('symbol') ?? (list.find((s) => s.symbol === 'CRUDEOIL') ?? list[0])?.symbol ?? '';
  const expiry = params.get('expiry') ?? undefined;
  const [showAll, setShowAll] = useState(false);

  const chain = useQuery({
    queryKey: ['mcx-chain', symbol, expiry ?? ''],
    queryFn: () => api<McxChainResponse>(`/mcx/chain/${encodeURIComponent(symbol)}${qs({ expiry })}`),
    refetchInterval: adaptivePoll(5000),
    placeholderData: keepPreviousData,
    enabled: !!symbol,
  });

  // A symbol change drops an expiry that belonged to the previous one.
  useEffect(() => {
    if (expiry && chain.data && chain.data.symbol === symbol && !chain.data.expiries.includes(expiry)) setParams({ symbol });
  }, [expiry, chain.data, symbol, setParams]);

  const set = (next: { symbol?: string; expiry?: string }) => {
    const p: Record<string, string> = {};
    const s = next.symbol ?? symbol;
    if (s) p.symbol = s;
    const e = next.symbol !== undefined && next.symbol !== symbol ? undefined : next.expiry ?? expiry;
    if (e) p.expiry = e;
    setParams(p);
  };

  return (
    <div>
      <PageHeader title="MCX Option Chain" subtitle="Commodity options on live Kotak quotes. Priced on the future they settle into (Black-76).">
        {symbols.data && (
          <select className="input" value={symbol} onChange={(e) => set({ symbol: e.target.value })} aria-label="Commodity">
            {list.map((s) => (
              <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
            ))}
          </select>
        )}
        {chain.data && chain.data.symbol === symbol && (
          <select className="input" value={chain.data.expiry} onChange={(e) => set({ expiry: e.target.value })} aria-label="Expiry">
            {chain.data.expiries.map((e) => (
              <option key={e} value={e}>{formatExpiry(e)}</option>
            ))}
          </select>
        )}
      </PageHeader>
      {symbols.error ? (
        <ErrorState error={symbols.error} title="MCX contracts not available" />
      ) : !symbols.data ? (
        <Spinner />
      ) : !symbol ? (
        <ErrorState error={new Error('No MCX commodity has options today')} />
      ) : (
        <Loadable q={chain} title="MCX chain not available">
          {(c) => <ChainView c={c} showAll={showAll} onShowAll={() => setShowAll((v) => !v)} />}
        </Loadable>
      )}
    </div>
  );
}

function ChainView({ c, showAll, onShowAll }: { c: McxChainResponse; showAll: boolean; onShowAll: () => void }) {
  const rows = useMemo(() => {
    if (showAll || c.atmStrike === null) return c.rows;
    const i = c.rows.findIndex((r) => r.strike === c.atmStrike);
    return c.rows.slice(Math.max(0, i - 8), i + 9);
  }, [c, showAll]);
  const F = c.future.ltp;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label={`Future ${formatExpiry(c.future.expiry)}`} value={<Val value={F} format={formatPrice} />} sub={<Chg value={c.future.changePct} pct reason="Needs the previous close" />} hint={c.future.tradingSymbol} />
        <Stat label="ATM strike" value={<Val value={c.atmStrike} format={formatPrice} />} />
        <Stat label="PCR (OI)" value={<Val value={c.totals.pcr} format={(x) => x.toFixed(2)} reason="No call OI reported" />} hint="Over the strikes shown" />
        <Stat label="Max pain" value={<Val value={c.maxPain} format={formatPrice} reason="No OI reported" />} hint="Over the strikes shown" />
        <Stat label="Lot size" value={c.lotSize} />
        <Stat label="Market" value={c.market.open ? 'Open' : 'Closed'} tone={c.market.open ? 'up' : 'warn'} hint={c.market.note} sub={c.asOf ? `as of ${formatDateTime(c.asOf)}` : 'no quote time'} />
      </div>
      {c.gaps.length > 0 && <div className="text-xs text-warn">{c.gaps.join(' · ')}</div>}
      <Card
        pad={false}
        title={`${c.symbol} options · expiry ${formatExpiry(c.expiry)}`}
        actions={
          <button className="btn-ghost px-2 py-0.5 text-xs" onClick={onShowAll}>{showAll ? 'Near ATM only' : `All ${c.rows.length} strikes`}</button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="text-2xs uppercase text-muted">
                <th colSpan={4} className="py-1 text-center">Calls</th>
                <th />
                <th colSpan={4} className="py-1 text-center">Puts</th>
              </tr>
              <tr className="text-2xs text-muted">
                <th className="px-2 text-right">OI</th>
                <th className="px-2 text-right">Volume</th>
                <th className="px-2 text-right">IV %</th>
                <th className="px-2 text-right">LTP</th>
                <th className="px-2 text-center">Strike</th>
                <th className="px-2 text-right">LTP</th>
                <th className="px-2 text-right">IV %</th>
                <th className="px-2 text-right">Volume</th>
                <th className="px-2 text-right">OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.strike} className={cx('border-t border-line', r.strike === c.atmStrike && 'font-semibold')}>
                  <Leg q={r.ce} side="ce" itm={isNum(F) && r.strike < F} />
                  <td className={cx('px-2 py-1 text-center num', r.strike === c.atmStrike && 'text-accent')}>{formatPrice(r.strike)}</td>
                  <Leg q={r.pe} side="pe" itm={isNum(F) && r.strike > F} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-2xs text-muted">
        Contracts from the Kotak MCX instrument master of {c.masterDate}. OI and volume are as Kotak reports them. Paper trading of MCX contracts is not available yet.
      </p>
    </div>
  );
}
