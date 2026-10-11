import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatExpiry, formatIndian, type ChainRow, type OptionChain as Chain, type OptionQuote } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { ExpirySelect, SymbolSelect } from '../components/pickers';
import { BuildUpBadge, Card, Chg, cx, ErrorBox, PageHeader, Segmented, Spinner, Stat, Toggle } from '../components/ui';
import { formatCompact, formatOi } from '../lib/format';
import { useChain } from '../lib/hooks';
import { useApp, useBuilder } from '../lib/store';
import { useSubscribe } from '../lib/ws';

type Side = 'ce' | 'pe';

function OiCell({ q, max, side, unit, lot, itm }: { q: OptionQuote; max: number; side: Side; unit: 'qty' | 'lots'; lot: number; itm: boolean }) {
  const w = max > 0 ? Math.min(100, (q.oi / max) * 100) : 0;
  return (
    <td className={cx('relative num', itm && 'bg-itm')}>
      <span className={cx('absolute inset-y-1', side === 'ce' ? 'right-0 bg-down/20' : 'left-0 bg-up/20')} style={{ width: `${w}%` }} />
      <span className="relative">{formatOi(q.oi, lot, unit)}</span>
    </td>
  );
}

function LtpCell({ q, side, onBuy, onSell, onTrade }: { q: OptionQuote; side: Side; onBuy: () => void; onSell: () => void; onTrade: () => void }) {
  return (
    <td className={cx('num relative md:min-w-[7.5rem]', side === 'ce' ? 'pr-2' : 'pl-2')}>
      <div className={cx('absolute inset-y-0 z-10 hidden items-center gap-1 group-hover:flex', side === 'ce' ? 'left-1' : 'right-1')}>
        <button className="rounded bg-up px-1.5 text-2xs font-bold text-white" onClick={onBuy} title="Add BUY leg to strategy builder">B</button>
        <button className="rounded bg-down px-1.5 text-2xs font-bold text-white" onClick={onSell} title="Add SELL leg to strategy builder">S</button>
      </div>
      <button className="font-semibold hover:underline" onClick={onTrade} title="Place a paper order">{q.ltp.toFixed(2)}</button>
      <div className="text-2xs">
        <Chg value={q.changePct} pct />
      </div>
    </td>
  );
}

export default function OptionChainPage() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const settings = useApp((s) => s.user?.settings);
  const [expiry, setExpiry] = useState<string>();
  const [around, setAround] = useState<number>(settings?.strikesAround ?? 15);
  const [greeks, setGreeks] = useState<boolean>(settings?.showGreeks ?? false);
  const [unit, setUnit] = useState<'qty' | 'lots'>(settings?.oiUnit ?? 'qty');
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const builder = useBuilder();
  const navigate = useNavigate();
  useSubscribe([symbol]);
  const q = useChain(symbol, expiry);
  const chain = q.data && q.data.symbol === symbol ? q.data : undefined;

  const rows = useMemo(() => {
    if (!chain) return [] as ChainRow[];
    const idx = chain.rows.findIndex((r) => r.strike === chain.atm);
    return around >= 999 ? chain.rows : chain.rows.slice(Math.max(0, idx - around), idx + around + 1);
  }, [chain, around]);
  const maxOi = useMemo(() => Math.max(1, ...rows.flatMap((r) => [r.ce.oi, r.pe.oi])), [rows]);

  const addLeg = (row: ChainRow, type: 'CE' | 'PE', side: 'BUY' | 'SELL') => {
    if (!chain) return;
    const quote = type === 'CE' ? row.ce : row.pe;
    builder.add({ symbol, side, type, strike: row.strike, expiry: chain.expiry, lots: 1, lotSize: chain.lotSize, price: quote.ltp, iv: quote.iv / 100 });
  };
  const builderCount = builder.symbol === symbol ? builder.legs.length : 0;

  const greekCols = (side: Side) => (greeks ? (side === 'ce' ? ['Delta', 'Gamma', 'Theta', 'Vega'] : ['Vega', 'Theta', 'Gamma', 'Delta']) : []);
  const greekVal = (q: OptionQuote, g: string) => (g === 'Delta' ? q.delta.toFixed(2) : g === 'Gamma' ? q.gamma.toFixed(4) : g === 'Theta' ? q.theta.toFixed(1) : q.vega.toFixed(1));

  return (
    <div className="space-y-3">
      <PageHeader title="Option Chain" subtitle="Strike-wise premium, OI, change in OI, IV, Greeks and build-up. Click a premium to trade; hover for B/S to build a strategy.">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>

      {chain && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
          <Stat label="Spot" value={formatIndian(chain.spot)} sub={<Chg value={chain.spotChangePct} pct />} />
          <Stat label={`Future (${formatExpiry(chain.futureExpiry)})`} value={formatIndian(chain.future)} sub={`Basis ${(chain.future - chain.spot).toFixed(2)}`} />
          <Stat label="ATM IV" value={chain.atmIv.toFixed(2)} sub={<Chg value={chain.ivChange} />} />
          <Stat label="PCR (OI)" value={chain.pcr.toFixed(2)} tone={chain.pcr >= 1 ? 'up' : 'down'} sub={`Vol PCR ${chain.pcrVolume.toFixed(2)}`} />
          <Stat label="Max Pain" value={formatIndian(chain.maxPain, 0)} sub={`${(((chain.maxPain - chain.spot) / chain.spot) * 100).toFixed(2)}% from spot`} />
          <Stat label="Support / Resist." value={`${formatIndian(chain.support, 0)} / ${formatIndian(chain.resistance, 0)}`} sub="Highest PE / CE OI" />
          <Stat label="Total OI CE / PE" value={`${formatCompact(chain.totalCeOi)} / ${formatCompact(chain.totalPeOi)}`} sub={<span>Chg <Chg value={chain.totalCeOiChange / 1e5} decimals={1} />L / <Chg value={chain.totalPeOiChange / 1e5} decimals={1} />L</span>} />
          <Stat label="Days to expiry" value={chain.daysToExpiry.toFixed(1)} sub={`Lot ${chain.lotSize} · step ${chain.strikeStep}`} />
        </div>
      )}

      <Card
        pad={false}
        title={chain ? `${symbol} · ${formatExpiry(chain.expiry)}` : symbol}
        actions={
          <>
            <Segmented size="xs" value={around} onChange={setAround} options={[{ value: 10, label: '±10' }, { value: 15, label: '±15' }, { value: 25, label: '±25' }, { value: 999, label: 'All' }]} />
            <Segmented size="xs" value={unit} onChange={setUnit} options={[{ value: 'qty', label: 'Qty' }, { value: 'lots', label: 'Lots' }]} />
            <Toggle checked={greeks} onChange={setGreeks} label="Greeks" />
            {builderCount > 0 && (
              <button className="btn-primary px-2 py-1 text-xs" onClick={() => navigate('/builder')}>
                Builder ({builderCount}) →
              </button>
            )}
          </>
        }
      >
        {q.error && !chain ? (
          <div className="p-3"><ErrorBox error={q.error} /></div>
        ) : !chain ? (
          <Spinner />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th colSpan={4 + greekCols('ce').length + 2} className="text-center !text-down">CALLS</th>
                  <th className="text-center">Strike</th>
                  <th colSpan={4 + greekCols('pe').length + 2} className="text-center !text-up">PUTS</th>
                </tr>
                <tr>
                  <th className="hidden md:table-cell">Build-up</th>
                  <th className="num">OI Chg</th>
                  <th className="num">OI</th>
                  <th className="num hidden sm:table-cell">Volume</th>
                  <th className="num hidden sm:table-cell">IV</th>
                  {greekCols('ce').map((g) => <th key={g} className="num hidden md:table-cell">{g}</th>)}
                  <th className="num">LTP</th>
                  <th className="text-center">Strike · PCR</th>
                  <th className="num">LTP</th>
                  {greekCols('pe').map((g) => <th key={g} className="num hidden md:table-cell">{g}</th>)}
                  <th className="num hidden sm:table-cell">IV</th>
                  <th className="num hidden sm:table-cell">Volume</th>
                  <th className="num">OI</th>
                  <th className="num">OI Chg</th>
                  <th className="hidden md:table-cell">Build-up</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const ceItm = r.strike < chain.spot;
                  const peItm = r.strike > chain.spot;
                  const showSpot = i > 0 && rows[i - 1].strike <= chain.spot && r.strike > chain.spot;
                  const span = 2 * (6 + greekCols('ce').length) + 1;
                  return (
                    <Fragment key={r.strike}>
                      {showSpot && (
                        <tr>
                          <td colSpan={span} className="!border-y-2 !border-accent/70 !py-0.5 text-center text-2xs font-semibold text-accent">
                            {symbol} {formatIndian(chain.spot)} <Chg value={chain.spotChangePct} pct />
                          </td>
                        </tr>
                      )}
                      <tr className="group">
                        <td className={cx('hidden md:table-cell', ceItm && 'bg-itm')}><BuildUpBadge value={r.ce.buildUp} short /></td>
                        <td className={cx('num', ceItm && 'bg-itm')}><Chg value={unit === 'lots' ? r.ce.oiChange / chain.lotSize : r.ce.oiChange} decimals={0} /></td>
                        <OiCell q={r.ce} max={maxOi} side="ce" unit={unit} lot={chain.lotSize} itm={ceItm} />
                        <td className={cx('num hidden sm:table-cell', ceItm && 'bg-itm')}>{formatOi(r.ce.volume, chain.lotSize, unit)}</td>
                        <td className={cx('num hidden sm:table-cell', ceItm && 'bg-itm')}>{r.ce.iv.toFixed(2)}</td>
                        {greekCols('ce').map((g) => <td key={g} className={cx('num hidden md:table-cell', ceItm && 'bg-itm')}>{greekVal(r.ce, g)}</td>)}
                        <LtpCell q={r.ce} side="ce" onBuy={() => addLeg(r, 'CE', 'BUY')} onSell={() => addLeg(r, 'CE', 'SELL')} onTrade={() => setTicket({ symbol, type: 'CE', strike: r.strike, expiry: chain.expiry, side: 'BUY', price: r.ce.ltp })} />
                        <td className={cx('text-center font-semibold', r.strike === chain.atm ? 'bg-accent/15 text-accent' : 'bg-panel2')}>
                          <Link to={`/oi/multi-strike?strikes=${r.strike}`} className="hover:underline" title="Multi-strike OI chart">{formatIndian(r.strike, r.strike % 1 ? 1 : 0)}</Link>
                          <div className="text-2xs font-normal text-muted">{r.ce.oi ? (r.pe.oi / r.ce.oi).toFixed(2) : '—'}</div>
                        </td>
                        <LtpCell q={r.pe} side="pe" onBuy={() => addLeg(r, 'PE', 'BUY')} onSell={() => addLeg(r, 'PE', 'SELL')} onTrade={() => setTicket({ symbol, type: 'PE', strike: r.strike, expiry: chain.expiry, side: 'BUY', price: r.pe.ltp })} />
                        {greekCols('pe').map((g) => <td key={g} className={cx('num hidden md:table-cell', peItm && 'bg-itm')}>{greekVal(r.pe, g)}</td>)}
                        <td className={cx('num hidden sm:table-cell', peItm && 'bg-itm')}>{r.pe.iv.toFixed(2)}</td>
                        <td className={cx('num hidden sm:table-cell', peItm && 'bg-itm')}>{formatOi(r.pe.volume, chain.lotSize, unit)}</td>
                        <OiCell q={r.pe} max={maxOi} side="pe" unit={unit} lot={chain.lotSize} itm={peItm} />
                        <td className={cx('num', peItm && 'bg-itm')}><Chg value={unit === 'lots' ? r.pe.oiChange / chain.lotSize : r.pe.oiChange} decimals={0} /></td>
                        <td className={cx('hidden md:table-cell', peItm && 'bg-itm')}><BuildUpBadge value={r.pe.buildUp} short /></td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-2xs text-muted">LB = Long Build-up, SB = Short Build-up, SC = Short Covering, LU = Long Unwinding. Shaded cells are in-the-money. OI bars are relative to the largest OI on screen.</p>
      <OrderTicket
        spec={ticket}
        onClose={() => setTicket(null)}
        onAddToBuilder={(side, lots) => {
          const row = chain?.rows.find((x) => x.strike === ticket?.strike);
          if (row && ticket && ticket.type !== 'FUT') {
            const quote = ticket.type === 'CE' ? row.ce : row.pe;
            builder.add({ symbol, side, type: ticket.type, strike: row.strike, expiry: chain!.expiry, lots, lotSize: chain!.lotSize, price: quote.ltp, iv: quote.iv / 100 });
          }
          setTicket(null);
        }}
      />
    </div>
  );
}
