import type { ReactNode } from 'react';
import type { FeedStatus as FeedInfo, MarketClockInfo } from '@q26/core';
import type { FeedView } from '../lib/feed';
import { DASH, formatAge, formatDate, formatDateTime, formatSessionTime } from '../lib/format';
import { cx } from './ui';

export const FEED_TONE: Record<FeedView['state'], { dot: string; text: string }> = {
  LIVE: { dot: 'animate-pulse bg-up', text: 'text-up' },
  CONNECTING: { dot: 'animate-pulse bg-warn', text: 'text-warn' },
  OFFLINE: { dot: 'bg-down', text: 'text-down' },
};

/** The staleness-aware dot colour: a connected feed with no recent tick is amber, not green. */
export function feedTone(view: FeedView) {
  return view.state === 'LIVE' && view.stale ? { dot: 'bg-warn', text: 'text-warn' } : FEED_TONE[view.state];
}

const EOD_SOURCES: [keyof FeedInfo['eod'], string][] = [
  ['fo', 'F&O bhavcopy'],
  ['cm', 'Cash bhavcopy'],
  ['index', 'Index closes'],
  ['participants', 'Participant OI / volume'],
  ['fiidii', 'FII / DII'],
];

const yesNo = (v: boolean, yes: string, no: string) => <span className={v ? 'text-up' : 'text-warn'}>{v ? yes : no}</span>;

/** Connection and data health, as the server last reported it (clock.feed): no credentials, ever. */
export function FeedDetails({ clock, view, appConnected, className }: { clock: MarketClockInfo | null; view: FeedView; appConnected: boolean; className?: string }) {
  const f = clock?.feed;
  const rows: [string, ReactNode][] = [
    ['This browser ↔ server', yesNo(appConnected, 'connected', 'not connected')],
  ];
  if (f) {
    rows.push(
      ['Kotak Neo login', yesNo(f.loggedIn, 'logged in', 'not logged in')],
      ['Market-data feed', yesNo(f.connected, 'connected', 'not connected')],
      ['Last live tick', f.lastTickTs === null ? 'none yet' : `${formatSessionTime(f.lastTickTs, true)} (${formatAge(view.lastTickAgeMs)} ago)`],
      ['Instruments streamed', f.subscribed],
      ['Instrument master', yesNo(f.refdataReady, 'loaded', 'not loaded yet')],
      ['Intraday recording since', f.recordingSince ? formatDate(f.recordingSince, true) : 'not recording yet'],
    );
  }
  return (
    <div className={className}>
      <div className={cx('text-sm font-semibold', feedTone(view).text)}>
        {view.state}
        {view.state === 'LIVE' && view.stale ? ' · stale' : ''}
      </div>
      <p className="mt-0.5 text-xs text-muted">{view.reason}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="text-right tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {f && (
        <>
          <div className="mt-2 text-2xs font-semibold uppercase tracking-wide text-muted">Official files loaded up to</div>
          <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {EOD_SOURCES.map(([k, label]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{label}</dt>
                <dd className="text-right tabular-nums">{f.eod[k] ? formatDate(f.eod[k], true) : DASH}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {clock && <div className="mt-2 text-2xs text-muted">Market clock (IST): {formatDateTime(clock.ts)} · {clock.status}</div>}
    </div>
  );
}
