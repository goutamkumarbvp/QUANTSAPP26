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

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError((data && data.error) || res.statusText, res.status);
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
