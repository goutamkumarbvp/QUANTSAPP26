import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { MetaResponse, OptionChain, SymbolInfo } from '@q26/core';
import { api, qs } from './api';

export function useMeta() {
  return useQuery({ queryKey: ['meta'], queryFn: () => api<MetaResponse>('/meta'), staleTime: 60_000 });
}

export function useSymbolInfo(symbol: string): SymbolInfo | undefined {
  return useMeta().data?.symbols.find((s) => s.symbol === symbol);
}

export function useExpiries(symbol: string) {
  return useQuery({ queryKey: ['expiries', symbol], queryFn: () => api<{ options: string[]; futures: string[] }>(`/expiries/${encodeURIComponent(symbol)}`), staleTime: 30_000 });
}

export function useChain(symbol: string, expiry?: string, opts: { at?: number; refetch?: number | false } = {}) {
  return useQuery({
    queryKey: ['chain', symbol, expiry ?? '', opts.at ?? 'live'],
    queryFn: () => api<OptionChain>(`/chain/${encodeURIComponent(symbol)}${qs({ expiry, at: opts.at })}`),
    refetchInterval: opts.at ? false : opts.refetch ?? 3000,
    placeholderData: keepPreviousData,
  });
}

/** Generic polling query for analytics endpoints. */
export function useLive<T>(key: unknown[], path: string, refetch: number | false = 5000, enabled = true) {
  return useQuery({ queryKey: key, queryFn: () => api<T>(path), refetchInterval: refetch, placeholderData: keepPreviousData, enabled });
}
