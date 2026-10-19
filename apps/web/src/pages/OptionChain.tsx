import { Fragment, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { formatTimeIST, istParts, type ChainRow, type OptionChain as Chain, type OptionQuote } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { defaultStrike, ExpirySelect, SymbolSelect } from '../components/pickers';
import { AsOf, BuildUpBadge, Card, Chg, Coverage, cx, Dash, ErrorState, Gaps, PageHeader, Segmented, Spinner, Stat, Toggle, Val } from '../components/ui';
import { errorText, isNoLiveData } from '../lib/api';
import { useServerNow } from '../lib/feed';
import { formatCompact, formatDateTime, formatExpiry, formatFixed, formatIndian, formatOi, formatPrice, isNum } from '../lib/format';
import { useChain } from '../lib/hooks';
import { useApp, useBuilder } from '../lib/store';
import { useSubscribe } from '../lib/ws';

type Side = 'ce' | 'pe';

const FORWARD_SOURCE: Record<NonNullable<Chain['forwardSource']>, string> = { future: 'same-expiry future', parity: 'put-call parity', spot: 'spot (no carry)' };
const NO_BOOK = 'No fresh two-sided book: the session is closed or the quote is older than 10 s';

/** Why a leg has no IV / Greeks: the chain's own reason, else what the leg itself lacks. */
function ivWhy(q: OptionQuote, chain: Chain): string {
  return chain.gaps?.iv ?? (q.ivSource === null ? 'No usable premium: not traded in the live session and no fresh two-sided book' : 'The IV could not be solved from the premium');
}

function OiCell({ q, max, side, unit, lot, itm }: { q: OptionQuote; max: number; side: Side; unit: 'qty' | 'lots'; lot: number; itm: boolean }) {
  const w = isNum(q.oi) && max > 0 ? Math.min(100, (q.oi / max) * 100) : 0;
  return (
    <td className={cx('relative num', itm && 'bg-itm')}>
      <span className={cx('absolute inset-y-1', side === 'ce' ? 'right-0 bg-down/20' : 'left-0 bg-up/20')} style={{ width: `${w}%` }} />
      <span className="relative">{isNum(q.oi) ? formatOi(q.oi, lot, unit) : <Dash reason="No open interest reported for this contract" />}</span>
    </td>
  );
}

function LtpCell({ q, side, live, onBuy, onSell, onTrade }: { q: OptionQuote; side: Side; live: boolean; onBuy: () => void; onSell: () => void; onTrade: () => void }) {
  const ltp = q.ltp;
  const traded = isNum(ltp);
  return (
    <td className={cx('num relative md:min-w-[7.5rem]', side === 'ce' ? 'pr-2' : 'pl-2')}>
      {live && (
        <div className={cx('absolute inset-y-0 z-10 hidden items-center gap-1 group-hover:flex', side === 'ce' ? 'left-1' : 'right-1')}>
          <button className="rounded bg-up px-1.5 text-2xs font-bold text-white disabled:opacity-40" onClick={onBuy} disabled={!traded} title={traded ? 'Add BUY leg to strategy builder' : 'No live LTP: the strategy builder needs a traded premium'}>B</button>
          <button className="rounded bg-down px-1.5 text-2xs font-bold text-white disabled:opacity-40" onClick={onSell} disabled={!traded} title={traded ? 'Add SELL leg to strategy builder' : 'No live LTP: the strategy builder needs a traded premium'}>S</button>
        </div>
      )}
      {live ? (
        <button className={cx('font-semibold hover:underline', !traded && 'text-muted')} onClick={onTrade} title={traded ? `Place a paper order${q.ts ? ` (LTP of ${formatDateTime(q.ts)})` : ''}` : 'Not traded in the live session; click to trade at the live bid/ask'}>
          {traded ? ltp.toFixed(2) : '—'}
        </button>
      ) : (
        <span className={cx('font-semibold', !traded && 'text-muted')} title={traded ? undefined : 'Not traded in this session'}>{traded ? ltp.toFixed(2) : '—'}</span>
      )}
      <div className="text-2xs">
        <Chg value={q.changePct} pct reason={traded ? 'Needs the previous close' : 'Not traded in the live session'} />
      </div>
      <div className="hidden text-2xs text-muted md:block" title="Best bid / best ask of the live book">
        <Val value={q.bid} format={formatPrice} reason={NO_BOOK} /> / <Val value={q.ask} format={formatPrice} reason={NO_BOOK} />
      </div>
    </td>
  );
}

function IvCell({ q, chain, itm }: { q: OptionQuote; chain: Chain; itm: boolean }) {
  return (
    <td className={cx('num hidden sm:table-cell', itm && 'bg-itm')}>
      <Val value={q.iv} format={(x) => x.toFixed(2)} reason={ivWhy(q, chain)} />
      {isNum(q.iv) && q.ivSource === 'ltp' && <sup className="ml-0.5 text-muted" title="Solved from the last traded price (no fresh two-sided book)">L</sup>}
    </td>
  );
}

/** 'YYYY-MM-DDTHH:mm' (IST wall clock, as a datetime-local input holds it) → epoch ms; undefined when empty, invalid or not in the past. */
function recordedTs(v: string, nowTs: number): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(`${v}:00+05:30`);
  return Number.isFinite(t) && t < nowTs ? t : undefined;
}

const istLocal = (ts: number) => `${istParts(ts).date}T${formatTimeIST(ts)}`;

export default function OptionChainPage() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [expiry, setExpiry] = useState<string>();
  const [params] = useSearchParams();
  // `?at=<epoch ms>` opens the page on a recorded chain, at that exact time (the input only shows minutes).
  const [urlAt] = useState(() => {
    const t = Number(params.get('at'));
    return Number.isFinite(t) && t > 0 ? t : undefined;
  });
  const [asOf, setAsOf] = useState(() => (urlAt !== undefined ? istLocal(urlAt) : ''));
  const serverNow = useServerNow();
  const atTs = urlAt !== undefined && urlAt < serverNow && asOf === istLocal(urlAt) ? urlAt : recordedTs(asOf, serverNow);
  return (
    <div className="space-y-3">
      <PageHeader title="Option Chain" subtitle="Strike-wise premium, OI, change in OI, IV, Greeks and build-up. Click a premium to trade; hover for B/S to build a strategy.">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} at={atTs} />
        <label className="flex items-center gap-1 text-xs text-muted" title="View the chain as the recorder saw it (IST). Empty = live.">
          Recorded
          <input type="datetime-local" aria-label="Recorded view, IST" className="input w-auto" value={asOf} max={istLocal(serverNow)} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        {asOf && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAsOf('')}>Live</button>}
      </PageHeader>
      {/* A fresh panel for every underlying and for live / recorded, so one is never shown as the other while it loads. */}
      <ChainPanel key={`${symbol}|${atTs ?? 'live'}`} symbol={symbol} expiry={expiry} atTs={atTs} requested={!!asOf} />
    </div>
  );
}

function ChainPanel({ symbol, expiry, atTs, requested }: { symbol: string; expiry: string | undefined; atTs: number | undefined; requested: boolean }) {
  const settings = useApp((s) => s.user?.settings);
  const [around, setAround] = useState<number>(settings?.strikesAround ?? 15);
  const [greeks, setGreeks] = useState<boolean>(settings?.showGreeks ?? false);
  const [unit, setUnit] = useState<'qty' | 'lots'>(settings?.oiUnit ?? 'qty');
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const builder = useBuilder();
  const navigate = useNavigate();
  useSubscribe([symbol]);
  const recorded = atTs !== undefined;
  const q = useChain(symbol, expiry, { at: atTs });
  // The server says nothing is live now / recorded then: the last answer is not kept on screen.
  const chain = !isNoLiveData(q.error) && q.data && q.data.symbol === symbol ? q.data : undefined;

  const rows = useMemo(() => {
    if (!chain) return [] as ChainRow[];
    // Windowing centres on the ATM strike, else the strike nearest the forward: nothing is assumed about a missing spot.
    const idx = chain.rows.findIndex((r) => r.strike === defaultStrike(chain));
    return around >= 999 || idx < 0 ? chain.rows : chain.rows.slice(Math.max(0, idx - around), idx + around + 1);
  }, [chain, around]);
  const maxOi = useMemo(() => Math.max(1, ...rows.flatMap((r) => [r.ce.oi, r.pe.oi]).filter(isNum)), [rows]);

  const addLeg = (row: ChainRow, type: 'CE' | 'PE', side: 'BUY' | 'SELL', lots = 1) => {
    if (!chain) return;
    const quote = type === 'CE' ? row.ce : row.pe;
    // The entry price is the live LTP; a contract without one cannot be added (no premium is made up).
    if (!isNum(quote.ltp)) return;
    builder.add({ symbol, side, type, strike: row.strike, expiry: chain.expiry, lots, lotSize: chain.lotSize, price: quote.ltp, iv: isNum(quote.iv) ? quote.iv / 100 : undefined });
  };
  const builderCount = builder.symbol === symbol ? builder.legs.length : 0;

  const greekCols = (side: Side) => (greeks ? (side === 'ce' ? ['Delta', 'Gamma', 'Theta', 'Vega'] : ['Vega', 'Theta', 'Gamma', 'Delta']) : []);
  const greekVal = (leg: OptionQuote, g: string): number | null => (g === 'Delta' ? leg.delta : g === 'Gamma' ? leg.gamma : g === 'Theta' ? leg.theta : leg.vega);
  const greekFmt = (g: string) => (x: number) => (g === 'Delta' ? x.toFixed(2) : g === 'Gamma' ? x.toFixed(4) : x.toFixed(1));

  const spot = chain?.spot ?? null;
  const ticketRow = ticket && chain ? chain.rows.find((x) => x.strike === ticket.strike) : undefined;
  const ticketQuote = ticketRow && ticket && ticket.type !== 'FUT' ? (ticket.type === 'CE' ? ticketRow.ce : ticketRow.pe) : undefined;

  return (
    <>
      {chain && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9">
            <Stat label="Spot" value={isNum(chain.spot) ? formatIndian(chain.spot) : null} reason={chain.gaps?.spot} sub={isNum(chain.spot) ? <span><Chg value={chain.spotChangePct} pct reason="Needs the previous close" /> <AsOf ts={chain.spotTs} label="" /></span> : undefined} />
            <Stat label={chain.futureExpiry ? `Future (${formatExpiry(chain.futureExpiry)})` : 'Future'} value={isNum(chain.future) ? formatIndian(chain.future) : null} reason={chain.futureExpiry ? `No ${recorded ? 'recorded' : 'live'} price for the future` : 'No listed future'}sub={isNum(chain.future) && isNum(chain.spot) ? `Basis ${(chain.future - chain.spot).toFixed(2)}` : undefined} />
            <Stat
              label="Forward"
              value={isNum(chain.forward) ? formatIndian(chain.forward) : null}
              reason={chain.gaps?.forward}
              sub={chain.forwardSource ? <span>{FORWARD_SOURCE[chain.forwardSource]} · carry <Val value={isNum(chain.carry) ? chain.carry * 100 : null} format={(x) => formatFixed(x, 2, '%')} reason={chain.gaps?.carry ?? 'No carry implied for this expiry'} /></span> : undefined}
              hint="The forward of this expiry that IV and Greeks are solved against"
            />
            <Stat label="ATM IV" value={isNum(chain.atmIv) ? chain.atmIv.toFixed(2) : null} reason={chain.gaps?.atmIv} sub={<Chg value={chain.ivChange} reason={chain.gaps?.ivChange ?? 'Needs the previous session\'s official option closes'} />} hint="Solved from the live ATM premiums" />
            <Stat label="PCR (OI)" value={isNum(chain.pcr) ? chain.pcr.toFixed(2) : null} reason={chain.gaps?.oi} tone={isNum(chain.pcr) ? (chain.pcr >= 1 ? 'up' : 'down') : undefined} sub={`Vol PCR ${formatFixed(chain.pcrVolume)}`} />
            <Stat label="Max Pain" value={isNum(chain.maxPain) ? formatIndian(chain.maxPain, 0) : null} reason={chain.gaps?.oi} sub={isNum(chain.maxPain) && isNum(chain.spot) ? `${(((chain.maxPain - chain.spot) / chain.spot) * 100).toFixed(2)}% from spot` : undefined} />
            <Stat label="Support / Resist." value={isNum(chain.support) || isNum(chain.resistance) ? `${formatIndian(chain.support, 0)} / ${formatIndian(chain.resistance, 0)}` : null} reason={chain.gaps?.oi} sub="Highest PE / CE OI" />
            <Stat
              label="Total OI CE / PE"
              value={isNum(chain.totalCeOi) || isNum(chain.totalPeOi) ? `${formatCompact(chain.totalCeOi)} / ${formatCompact(chain.totalPeOi)}` : null}
              reason={chain.gaps?.oi}
              sub={<span>Chg <Chg value={isNum(chain.totalCeOiChange) ? chain.totalCeOiChange / 1e5 : null} decimals={1} reason={chain.gaps?.oiChange} />{isNum(chain.totalCeOiChange) && 'L'} / <Chg value={isNum(chain.totalPeOiChange) ? chain.totalPeOiChange / 1e5 : null} decimals={1} reason={chain.gaps?.oiChange} />{isNum(chain.totalPeOiChange) && 'L'}</span>}
            />
            <Stat label="Days to expiry" value={formatFixed(chain.daysToExpiry, 1)} sub={`Lot ${chain.lotSize} · step ${chain.strikeStep}`} />
          </div>
          <div className="space-y-0.5">
            <Coverage text={chain.coverage} label="PCR, max pain, support / resistance and OI totals cover" />
            <div className="text-2xs text-muted"><AsOf ts={chain.valuationTs} label="IV, Greeks, forward and days to expiry valued at" /></div>
            <Gaps gaps={chain.gaps} />
          </div>
        </>
      )}

      <Card
        pad={false}
        title={chain ? `${symbol} · ${formatExpiry(chain.expiry)}${recorded ? ' · recorded' : ''}` : symbol}
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
        {recorded && chain && (
          <div className="border-b border-line bg-warn/10 px-3 py-1.5 text-xs text-warn" role="status">
            Recorded chain as of <b>{formatDateTime(chain.ts)}</b> (IST), not live. Orders and strategy-builder legs are disabled in this view.
          </div>
        )}
        {requested && !recorded && (
          <div className="border-b border-line px-3 py-1.5 text-xs text-muted" role="status">That time is not in the past: showing the live chain.</div>
        )}
        {chain && q.error ? <div className="px-3 pt-2 text-2xs text-warn">Could not refresh — showing the last answer ({errorText(q.error)})</div> : null}
        {chain && spot === null && <div className="px-3 pt-2 text-2xs text-muted">No {recorded ? 'recorded' : 'live'} spot price: ATM, in-the-money shading and the spot line are not shown. The strikes are listed around the forward.</div>}
        {q.error && !chain ? (
          <div className="p-3"><ErrorState error={q.error} hint={recorded ? 'Recorded views exist only for the minutes the app recorded.' : undefined} /></div>
        ) : !chain ? (
          <Spinner />
        ) : (
          <div className={cx('max-h-[70vh] overflow-auto', q.isPlaceholderData && 'opacity-60')}>
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
                  // In-the-money shading and the spot line need a live spot.
                  const ceItm = spot !== null && r.strike < spot;
                  const peItm = spot !== null && r.strike > spot;
                  const showSpot = spot !== null && i > 0 && rows[i - 1].strike <= spot && r.strike > spot;
                  const span = 2 * (6 + greekCols('ce').length) + 1;
                  const oiChgWhy = chain.gaps?.oiChange ?? 'Needs the previous session\'s open interest';
                  const buildWhy = 'Needs the price change and the OI change vs the previous session';
                  const pcr = isNum(r.ce.oi) && isNum(r.pe.oi) && r.ce.oi > 0 ? (r.pe.oi / r.ce.oi).toFixed(2) : null;
                  return (
                    <Fragment key={r.strike}>
                      {showSpot && (
                        <tr>
                          <td colSpan={span} className="!border-y-2 !border-accent/70 !py-0.5 text-center text-2xs font-semibold text-accent">
                            {symbol} {formatIndian(spot)} <Chg value={chain.spotChangePct} pct reason="Needs the previous close" />
                          </td>
                        </tr>
                      )}
                      <tr className="group">
                        <td className={cx('hidden md:table-cell', ceItm && 'bg-itm')}><BuildUpBadge value={r.ce.buildUp} short reason={buildWhy} /></td>
                        <td className={cx('num', ceItm && 'bg-itm')}><Chg value={isNum(r.ce.oiChange) ? (unit === 'lots' ? r.ce.oiChange / chain.lotSize : r.ce.oiChange) : null} decimals={0} reason={oiChgWhy} /></td>
                        <OiCell q={r.ce} max={maxOi} side="ce" unit={unit} lot={chain.lotSize} itm={ceItm} />
                        <td className={cx('num hidden sm:table-cell', ceItm && 'bg-itm')}>{isNum(r.ce.volume) ? formatOi(r.ce.volume, chain.lotSize, unit) : <Dash reason="No volume reported" />}</td>
                        <IvCell q={r.ce} chain={chain} itm={ceItm} />
                        {greekCols('ce').map((g) => <td key={g} className={cx('num hidden md:table-cell', ceItm && 'bg-itm')}><Val value={greekVal(r.ce, g)} format={greekFmt(g)} reason={ivWhy(r.ce, chain)} /></td>)}
                        <LtpCell q={r.ce} side="ce" live={!recorded} onBuy={() => addLeg(r, 'CE', 'BUY')} onSell={() => addLeg(r, 'CE', 'SELL')} onTrade={() => setTicket({ symbol, type: 'CE', strike: r.strike, expiry: chain.expiry, side: 'BUY', price: r.ce.ltp })} />
                        <td className={cx('text-center font-semibold', r.strike === chain.atm ? 'bg-accent/15 text-accent' : 'bg-panel2')}>
                          <Link to={`/oi/multi-strike?strikes=${r.strike}`} className="hover:underline" title="Multi-strike OI chart">{formatIndian(r.strike, r.strike % 1 ? 1 : 0)}</Link>
                          <div className="text-2xs font-normal text-muted">{pcr ?? <Dash reason="Needs OI on both sides of the strike" />}</div>
                        </td>
                        <LtpCell q={r.pe} side="pe" live={!recorded} onBuy={() => addLeg(r, 'PE', 'BUY')} onSell={() => addLeg(r, 'PE', 'SELL')} onTrade={() => setTicket({ symbol, type: 'PE', strike: r.strike, expiry: chain.expiry, side: 'BUY', price: r.pe.ltp })} />
                        {greekCols('pe').map((g) => <td key={g} className={cx('num hidden md:table-cell', peItm && 'bg-itm')}><Val value={greekVal(r.pe, g)} format={greekFmt(g)} reason={ivWhy(r.pe, chain)} /></td>)}
                        <IvCell q={r.pe} chain={chain} itm={peItm} />
                        <td className={cx('num hidden sm:table-cell', peItm && 'bg-itm')}>{isNum(r.pe.volume) ? formatOi(r.pe.volume, chain.lotSize, unit) : <Dash reason="No volume reported" />}</td>
                        <OiCell q={r.pe} max={maxOi} side="pe" unit={unit} lot={chain.lotSize} itm={peItm} />
                        <td className={cx('num', peItm && 'bg-itm')}><Chg value={isNum(r.pe.oiChange) ? (unit === 'lots' ? r.pe.oiChange / chain.lotSize : r.pe.oiChange) : null} decimals={0} reason={oiChgWhy} /></td>
                        <td className={cx('hidden md:table-cell', peItm && 'bg-itm')}><BuildUpBadge value={r.pe.buildUp} short reason={buildWhy} /></td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-2xs text-muted">
        LB = Long Build-up, SB = Short Build-up, SC = Short Covering, LU = Long Unwinding. Shaded cells are in-the-money (needs a live spot). OI bars are relative to the largest OI on screen. LTP is the last trade of the live session (— = not traded yet); bid / ask need an open session and a quote under 10 s old. IV and Greeks are solved from the live mid of bid and ask; <sup>L</sup> marks an IV solved from the last traded price instead.
      </p>
      <OrderTicket
        spec={ticket}
        onClose={() => setTicket(null)}
        // A contract without a live LTP cannot go to the builder (its entry price would have to be made up).
        onAddToBuilder={
          ticketRow && ticket && ticket.type !== 'FUT' && isNum(ticketQuote?.ltp)
            ? (side, lots) => {
                addLeg(ticketRow, ticket.type as 'CE' | 'PE', side, lots);
                setTicket(null);
              }
            : undefined
        }
      />
    </>
  );
}
