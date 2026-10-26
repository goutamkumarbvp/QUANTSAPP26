import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MetaResponse, OptionChain, SymbolInfo } from '@q26/core';
import { api, isNoLiveData, qs } from './api';

/** Slowest poll while the server says the data is not live (503 NO_LIVE_DATA): a blank answer is asked again, gently. */
export const NO_LIVE_POLL_MS = 15_000;

/**
 * Adaptive polling: the page's interval while answers arrive; while the last answer was "no live data"
 * the interval stretches to NO_LIVE_POLL_MS (never shorter than the page's own), so a closed market or a
 * contract outside the stream does not hammer the server with requests that cannot succeed. The first
 * live answer brings the normal interval back.
 */
export function adaptivePoll(refetch: number | false) {
  return (q: { state: { error: unknown; data: unknown } }): number | false => {
    if (refetch === false) return false;
    return isNoLiveData(q.state.error) ? Math.max(refetch, NO_LIVE_POLL_MS) : refetch;
  };
}

/**
 * Query hooks. Failures go through the app-wide retry policy (lib/query.ts): a 503 NO_LIVE_DATA or a 4xx
 * is not retried, and polling queries keep asking at their normal interval, so data that arrives later
 * shows up on its own. `isNoLiveData(q.error)` tells a blank answer (show the reason) from a real failure.
 */

export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: () => api<MetaResponse>('/meta'),
    staleTime: 60_000,
    // The symbol list is empty (with gaps.symbols) until the instrument master loads: ask again soon.
    refetchInterval: (q) => (q.state.data && q.state.data.symbols.length === 0 ? 10_000 : false),
  });
}

export function useSymbolInfo(symbol: string): SymbolInfo | undefined {
  return useMeta().data?.symbols.find((s) => s.symbol === symbol);
}

export interface ExpiriesResponse {
  options: string[];
  futures: string[];
}

/** Listed (unexpired) expiries; with `at`, the expiries that were recorded at that time. */
export function useExpiries(symbol: string, opts: { at?: number } = {}) {
  return useQuery({
    queryKey: ['expiries', symbol, opts.at ?? 'live'],
    queryFn: () => api<ExpiriesResponse>(`/expiries/${encodeURIComponent(symbol)}${qs({ at: opts.at })}`),
    staleTime: 30_000,
    enabled: !!symbol,
  });
}

/**
 * Option chain of `symbol`/`expiry` (nearest expiry when omitted). Live chains poll every `refetch` ms;
 * an as-of chain (`at`) is a recorded answer and is fetched once.
 */
export function useChain(symbol: string, expiry?: string, opts: { at?: number; refetch?: number | false; enabled?: boolean } = {}) {
  // Without an expiry the server answers the nearest one: resolve it here first, so "nearest" and the
  // same expiry picked by name share one cache entry (one request, not two, when the page then names it).
  const exp = useExpiries(symbol, { at: opts.at });
  const eff = expiry ?? exp.data?.options[0];
  const resolved = expiry !== undefined || exp.isFetched || exp.isError;
  return useQuery({
    queryKey: ['chain', symbol, eff ?? '', opts.at ?? 'live'],
    queryFn: () => api<OptionChain>(`/chain/${encodeURIComponent(symbol)}${qs({ expiry: eff, at: opts.at })}`),
    refetchInterval: adaptivePoll(opts.at ? false : opts.refetch ?? 3000),
    placeholderData: keepPreviousData,
    enabled: (opts.enabled ?? true) && !!symbol && resolved,
  });
}

/**
 * Generic polling query for analytics endpoints. Send `?at=` only to the as-of routes (quotes, indices,
 * expiries, chain, futures, candles, strike OI): a past `at` on any other route is a 503.
 */
export function useLive<T>(key: unknown[], path: string, refetch: number | false = 5000, enabled = true) {
  return useQuery({ queryKey: key, queryFn: () => api<T>(path), refetchInterval: adaptivePoll(refetch), placeholderData: keepPreviousData, enabled });
}
