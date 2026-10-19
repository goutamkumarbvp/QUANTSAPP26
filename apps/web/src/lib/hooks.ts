import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MetaResponse, OptionChain, SymbolInfo } from '@q26/core';
import { api, qs } from './api';

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
  return useQuery({
    queryKey: ['chain', symbol, expiry ?? '', opts.at ?? 'live'],
    queryFn: () => api<OptionChain>(`/chain/${encodeURIComponent(symbol)}${qs({ expiry, at: opts.at })}`),
    refetchInterval: opts.at ? false : opts.refetch ?? 3000,
    placeholderData: keepPreviousData,
    enabled: (opts.enabled ?? true) && !!symbol,
  });
}

/**
 * Generic polling query for analytics endpoints. Send `?at=` only to the as-of routes (quotes, indices,
 * expiries, chain, futures, candles, strike OI): a past `at` on any other route is a 503.
 */
export function useLive<T>(key: unknown[], path: string, refetch: number | false = 5000, enabled = true) {
  return useQuery({ queryKey: key, queryFn: () => api<T>(path), refetchInterval: refetch, placeholderData: keepPreviousData, enabled });
}
