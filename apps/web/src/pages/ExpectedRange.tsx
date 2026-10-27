import { useState } from 'react';
import type { ExpectedRangeRow } from '@q26/core';
import { Card, Coverage, cx, Dash, Gaps, Loadable, PageHeader, Pill, Segmented, Stat, Val } from '../components/ui';
import { formatDate, formatExpiry, formatFixed, formatIndian, isNum } from '../lib/format';
import { useLive } from '../lib/hooks';

const POSITION: Record<NonNullable<ExpectedRangeRow['position']>, { label: string; tone: 'up' | 'down' | 'accent' | 'warn' }> = {
  inside: { label: 'Inside ±1σ', tone: 'accent' },
  'above-1': { label: 'Above +1σ', tone: 'up' },
  'below-1': { label: 'Below −1σ', tone: 'down' },
  'above-2': { label: 'Above +2σ (rare)', tone: 'warn' },
  'below-2': { label: 'Below −2σ (rare)', tone: 'warn' },
};

const SOURCE: Record<NonNullable<ExpectedRangeRow['ivSource']>, string> = {
  live: 'live premiums',
  official: 'official close (not live)',
  recorded: 'recorded MCX close (not live)',
};

const px = (v: number | null | undefined) => formatIndian(v);

/**
 * The ±2σ band as a track, ±1σ shaded inside it, the anchor close as a tick, the day's low–high as a
 * bar and the live price as a marker. Only values the server sent are drawn.
 */
export function RangeBar({ r }: { r: ExpectedRangeRow }) {
  if (!r.band1 || !r.band2 || !isNum(r.anchor)) return null;
  const vals = [r.band2.low, r.band2.high, r.low, r.high, r.ltp].filter(isNum);
  const pad = (r.band2.high - r.band2.low) * 0.06;
  const lo = Math.min(...vals) - pad;
  const hi = Math.max(...vals) + pad;
  const at = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const span = (a: number, b: number) => ({ left: at(a), width: `${((b - a) / (hi - lo)) * 100}%` });
  return (
    <div className="space-y-1" aria-label={`${r.symbol} expected range`}>
      <div className="relative h-7">
        <div className="absolute inset-y-2 rounded bg-accent/10" style={span(r.band2.low, r.band2.high)} title={`±2σ ${px(r.band2.low)} – ${px(r.band2.high)}`} />
        <div className="absolute inset-y-2 rounded bg-accent/30" style={span(r.band1.low, r.band1.high)} title={`±1σ ${px(r.band1.low)} – ${px(r.band1.high)}`} />
        {isNum(r.low) && isNum(r.high) && <div className="absolute top-3 h-1 rounded bg-ink/60" style={span(r.low, r.high)} title={`Day's range ${px(r.low)} – ${px(r.high)}`} />}
        <div className="absolute inset-y-0.5 w-px bg-muted" style={{ left: at(r.anchor) }} title={`Previous close ${px(r.anchor)}`} />
        {isNum(r.ltp) && (
          <div className="absolute inset-y-0 -ml-1 w-2 rounded-sm border border-panel bg-warn" style={{ left: at(r.ltp) }} title={`LTP ${px(r.ltp)}`} />
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-muted">
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent/30 align-middle" />±1σ</span>
        <span><i className="mr-1 inline-block h-2 w-3 rounded-sm bg-accent/10 align-middle" />±2σ</span>
        <span><i className="mr-1 inline-block h-2.5 w-px bg-muted align-middle" />prev close</span>
        {isNum(r.low) && isNum(r.high) && <span><i className="mr-1 inline-block h-1 w-3 rounded bg-ink/60 align-middle" />day&apos;s high–low</span>}
        {isNum(r.ltp) && <span><i className="mr-1 inline-block h-2.5 w-1.5 rounded-sm bg-warn align-middle" />LTP</span>}
      </div>
    </div>
  );
}

function backCheck(r: ExpectedRangeRow): string | null {
  const h = r.history;
  if (!h.sessions || !isNum(h.closeIn1)) return null;
  return `Close stayed within ±1σ on ${formatFixed(h.closeIn1, 0)}% and within ±2σ on ${formatFixed(h.closeIn2, 0)}% of the last ${h.sessions} sessions (model: 68 % / 95 %)`;
}

function RangeCard({ r, onOpen }: { r: ExpectedRangeRow; onOpen?: () => void }) {
  const pos = r.position ? POSITION[r.position] : null;
  const check = backCheck(r);
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span>{r.symbol}</span>
          <Pill>{r.exchange}</Pill>
        </span>
      }
      actions={onOpen ? <button className="text-xs text-accent hover:underline" onClick={onOpen}>Details</button> : undefined}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <div className="text-2xs text-muted">Expected move · {formatDate(r.date)} session</div>
            <div className="text-xl font-semibold tabular-nums">
              {isNum(r.sigma) ? <>±{formatIndian(r.sigma)} <span className="text-sm text-muted">(±{formatFixed(r.sigmaPct, 2)}%)</span></> : <Dash reason={r.gaps?.iv ?? r.gaps?.anchor ?? 'No ATM IV or previous close'} />}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xs text-muted">LTP</div>
            <div className="text-base font-semibold tabular-nums"><Val value={r.ltp} format={(v) => formatIndian(v)} reason={r.gaps?.ltp ?? 'Not traded yet'} /></div>
            {pos && <Pill tone={pos.tone}>{pos.label}</Pill>}
          </div>
        </div>
        <RangeBar r={r} />
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted">±1σ range (≈ 68 %)</div>
            <div className="font-semibold tabular-nums">{r.band1 ? `${px(r.band1.low)} – ${px(r.band1.high)}` : <Dash reason={r.gaps?.iv ?? r.gaps?.anchor} />}</div>
          </div>
          <div>
            <div className="text-muted">±2σ range (≈ 95 %)</div>
            <div className="font-semibold tabular-nums">{r.band2 ? `${px(r.band2.low)} – ${px(r.band2.high)}` : <Dash reason={r.gaps?.iv ?? r.gaps?.anchor} />}</div>
          </div>
        </div>
        <div className="text-2xs text-muted">
          ATM IV {isNum(r.iv) ? `${formatFixed(r.iv, 2)}%` : '—'}
          {r.expiry ? ` · ${formatExpiry(r.expiry)} expiry` : ''}
          {r.ivSource ? ` · ${SOURCE[r.ivSource]}` : ''} · previous close {px(r.anchor)} ({formatDate(r.anchorDate)})
        </div>
        <div className={cx('text-2xs', check ? 'text-ink' : 'text-muted')}>{check ?? r.gaps?.history ?? 'No past sessions to check the range on'}</div>
      </div>
    </Card>
  );
}

function Detail({ r }: { r: ExpectedRangeRow }) {
  const h = r.history;
  return (
    <div className="space-y-3">
      <RangeCard r={r} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Previous close" value={isNum(r.anchor) ? px(r.anchor) : null} reason={r.gaps?.anchor} sub={formatDate(r.anchorDate, true)} />
        <Stat label="Expected move (1 SD)" value={isNum(r.sigma) ? `±${px(r.sigma)}` : null} reason={r.gaps?.iv ?? r.gaps?.anchor} sub={isNum(r.days) ? `${formatFixed(r.days, 2)} calendar days to the ${formatDate(r.date)} close` : undefined} tone="accent" />
        <Stat
          label="Rest of today (±1 SD)"
          value={r.remaining ? `${px(r.remaining.low)} – ${px(r.remaining.high)}` : null}
          reason={r.ltp === null ? r.gaps?.ltp : 'Shown while the session is open'}
          sub={r.remaining ? `±${px(r.remaining.sigma)} from the LTP to the close` : undefined}
        />
        <Stat
          label="Day's range used"
          value={isNum(r.rangeUsedPct) ? `${formatFixed(r.rangeUsedPct, 0)}%` : null}
          reason={r.ltp === null ? r.gaps?.ltp : 'Needs the day’s high, low and the 1σ move'}
          sub={isNum(r.high) && isNum(r.low) ? `H ${px(r.high)} · L ${px(r.low)} of the ±1 SD width` : undefined}
          tone={isNum(r.rangeUsedPct) && r.rangeUsedPct > 100 ? 'warn' : undefined}
        />
        <Stat label="Close inside ±1 SD" value={isNum(h.closeIn1) ? `${formatFixed(h.closeIn1, 0)}%` : null} reason={r.gaps?.history} sub={h.sessions ? `${h.sessions} past sessions (model 68 %)` : undefined} />
        <Stat label="Close inside ±2 SD" value={isNum(h.closeIn2) ? `${formatFixed(h.closeIn2, 0)}%` : null} reason={r.gaps?.history} sub={h.sessions ? 'model 95 %' : undefined} />
        <Stat label="Whole day inside ±1 SD" value={isNum(h.rangeIn1) ? `${formatFixed(h.rangeIn1, 0)}%` : null} reason={r.gaps?.history} sub="high and low both inside" />
        <Stat label="Avg high − low (14D)" value={isNum(h.avgRange) ? px(h.avgRange) : null} reason="Needs daily highs and lows" sub={isNum(h.avgRange) && isNum(r.sigma) ? `${formatFixed(h.avgRange / r.sigma, 2)} × the 1 SD move` : undefined} />
      </div>
      <Coverage
        text={`Back-check ${h.from && h.to ? `${formatDate(h.from, true)} – ${formatDate(h.to, true)}` : ''}: each past session's band is built the same way from the previous ${r.kind === 'commodity' ? 'recorded MCX' : 'official'} close and that day's end-of-day ATM IV; a session without both is skipped.`}
      />
      <Gaps gaps={r.gaps} />
    </div>
  );
}

export default function ExpectedRange() {
  const q = useLive<ExpectedRangeRow[]>(['expected-range'], '/expected-range', 10000);
  const [tab, setTab] = useState('ALL');
  const rows = q.data ?? [];
  const pick = rows.find((r) => r.symbol === tab);
  return (
    <div className="space-y-3">
      <PageHeader title="Expected Range" subtitle="Daily expected move of the indices and MCX commodities from the option market's ATM IV — ±1σ (≈ 68 %) and ±2σ (≈ 95 %) around the previous close, with how often it held" />
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <Segmented value={pick ? tab : 'ALL'} onChange={setTab} options={[{ value: 'ALL', label: 'All' }, ...rows.map((r) => ({ value: r.symbol, label: r.symbol }))]} />
        </div>
      )}
      <Loadable q={q} hint="The range needs a live (or end-of-day) ATM IV and the previous close of each underlying.">
        {(all) =>
          pick ? (
            <Detail r={pick} />
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {all.map((r) => (
                  <RangeCard key={r.symbol} r={r} onOpen={() => setTab(r.symbol)} />
                ))}
              </div>
              <Coverage text="σ = previous close × ATM IV × √(calendar days to this session's close ÷ 365), the same time basis the IV is solved with (nearest expiry with at least a day left). Under the model the close lands within ±1σ about 68 % of the time and within ±2σ about 95 %; the back-check line shows how often it actually did. Not a forecast of direction; paper trading only." />
            </>
          )
        }
      </Loadable>
    </div>
  );
}
