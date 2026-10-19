import { QueryClient } from '@tanstack/react-query';
import { isClientError, isNoLiveData } from './api';

/**
 * Retry policy for every query: a 503 NO_LIVE_DATA is an answer ("nothing live right now", with the
 * reason) and a 4xx means the request itself is wrong, so neither is retried — pages that poll simply
 * ask again at their normal refetch interval. Anything else (network, 5xx) is retried once.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (isNoLiveData(error) || isClientError(error)) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: false, staleTime: 2000 },
    },
  });
}
