import type { AuthResponse, UserProfile } from '@q26/core';

const TOKEN_KEY = 'q26-token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * A failed API call. `code` is the server's machine-readable code from the JSON body
 * (`NO_LIVE_DATA` for HTTP 503 "the live/official data for this answer is not available": the message
 * then is the reason to show).
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** The server has no live/official data for this answer (HTTP 503 `{ error: <reason>, code: 'NO_LIVE_DATA' }`). */
export function isNoLiveData(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'NO_LIVE_DATA';
}

/** A request the server rejected as wrong (HTTP 4xx): retrying the same request cannot help. */
export function isClientError(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/** The text to show for an error: the server's reason for an ApiError, the message otherwise. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  // A non-JSON body (a proxy's HTML error page, an empty 502) must not hide the HTTP status.
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new ApiError('The server sent a response that is not valid JSON', res.status);
  }
  if (!res.ok) {
    const body = (data && typeof data === 'object' ? data : {}) as { error?: unknown; code?: unknown };
    const message = typeof body.error === 'string' && body.error ? body.error : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(message, res.status, typeof body.code === 'string' ? body.code : undefined);
  }
  return data as T;
}

/** Resume the stored session, or start a guest session so every feature works immediately. */
export async function ensureSession(): Promise<UserProfile> {
  if (getToken()) {
    try {
      return await api<UserProfile>('/auth/me');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
    }
  }
  const r = await api<AuthResponse>('/auth/guest', { method: 'POST', body: {} });
  setToken(r.token);
  return r.user;
}

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}` : '';
}
