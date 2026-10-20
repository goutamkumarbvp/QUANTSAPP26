import { useMemo } from 'react';
import { FEED_STALE_MS, type MarketClockInfo } from '@q26/core';
import { formatAge } from './format';
import { useTicks } from './store';

export type FeedState = 'LIVE' | 'CONNECTING' | 'OFFLINE';

/**
 * A connected feed with no tick for this long while the market is open is flagged as stale: the one
 * threshold of the server (FEED_STALE_MS in @q26/core), so the header and the Operations panel agree.
 */
export const STALE_TICK_MS = FEED_STALE_MS;

export interface FeedView {
  state: FeedState;
  /** Why the state is what it is (one sentence, shown in the tooltip / popover). */
  reason: string;
  /** Connected, market open, but no recent tick. */
  stale: boolean;
  /** Server time minus the last live tick; null before any tick. */
  lastTickAgeMs: number | null;
}

/**
 * LIVE / CONNECTING / OFFLINE from the websocket heartbeat (`clock.feed`) and from whether this
 * browser is connected to the server at all. The browser can only vouch for what the server last told it.
 */
export function feedView(clock: MarketClockInfo | null, appConnected: boolean): FeedView {
  if (!clock) {
    return { state: 'CONNECTING', reason: appConnected ? 'Waiting for the first status from the server' : 'Connecting to the server…', stale: false, lastTickAgeMs: null };
  }
  if (!appConnected) {
    return { state: 'OFFLINE', reason: 'Connection to the server lost — reconnecting. Values on screen may be old.', stale: false, lastTickAgeMs: null };
  }
  const f = clock.feed;
  if (!f) return { state: 'CONNECTING', reason: 'The server has not reported the live-feed status yet', stale: false, lastTickAgeMs: null };
  const lastTickAgeMs = f.lastTickTs === null ? null : Math.max(0, clock.ts - f.lastTickTs);
  if (!f.connected) {
    if (f.error) return { state: 'OFFLINE', reason: f.error, stale: false, lastTickAgeMs };
    return { state: 'CONNECTING', reason: f.loggedIn ? 'Connecting to the Kotak Neo market-data feed…' : 'Logging in to Kotak Neo…', stale: false, lastTickAgeMs };
  }
  const open = clock.status === 'open';
  const stale = open && (lastTickAgeMs === null || lastTickAgeMs > FEED_STALE_MS);
  const reason = stale
    ? lastTickAgeMs === null
      ? 'Connected, but no live tick has arrived yet this session'
      : `Connected, but the last live tick was ${formatAge(lastTickAgeMs)} ago`
    : (f.error ?? (open ? 'Receiving live ticks from Kotak Neo' : 'Connected to Kotak Neo (the market is not open)'));
  return { state: 'LIVE', reason, stale, lastTickAgeMs };
}

export function useFeed(): FeedView {
  const clock = useTicks((s) => s.clock);
  const connected = useTicks((s) => s.connected);
  return useMemo(() => feedView(clock, connected), [clock, connected]);
}

/** The server's clock (epoch ms) as of its last heartbeat — the base for "as of" ages — or the browser's before the first one. */
export function useServerNow(): number {
  return useTicks((s) => s.clock?.ts) ?? Date.now();
}
