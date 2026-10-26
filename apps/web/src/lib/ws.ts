import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerMessage } from '@q26/core';
import { getToken } from './api';
import { useTicks } from './store';

let socket: WebSocket | null = null;
/** Symbols wanted by the mounted components, counted: one component leaving never drops another's symbol. */
const wanted = new Map<string, number>();

/** The server sends at least a heartbeat every 5 s: this long without any message means the link is dead. */
export const WS_SILENCE_MS = 20_000;

function sendSubscribe() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribe', symbols: [...wanted.keys()] }));
}

/** Adds (+1) or releases (-1) symbols; returns the symbols now wanted. */
export function trackSymbols(symbols: readonly string[], delta: 1 | -1): string[] {
  for (const s of symbols) {
    const n = (wanted.get(s) ?? 0) + delta;
    if (n > 0) wanted.set(s, n);
    else wanted.delete(s);
  }
  return [...wanted.keys()];
}

/**
 * Single app-wide live connection: ticker quotes, market clock, notifications and order updates.
 * Reconnects with back-off (1 s … 15 s); at once when the network comes back or the tab is shown again;
 * and drops a socket that has been silent for WS_SILENCE_MS (a half-open link after Wi-Fi / sleep never
 * reports a close by itself, and the ticker would freeze).
 */
export function useLiveConnection(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastMsg = Date.now();
    const connect = () => {
      clearTimeout(timer);
      timer = undefined;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      socket = ws;
      lastMsg = Date.now();
      ws.onopen = () => {
        retry = 0;
        lastMsg = Date.now();
        useTicks.getState().setConnected(true);
        const token = getToken();
        if (token) ws.send(JSON.stringify({ type: 'auth', token }));
        sendSubscribe();
      };
      ws.onmessage = (ev) => {
        lastMsg = Date.now();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return; // a malformed frame is skipped, never fatal
        }
        const st = useTicks.getState();
        if (msg.type === 'ticks') st.setTicks(msg.clock, msg.quotes);
        else if (msg.type === 'hello') st.setTicks(msg.clock, []);
        else if (msg.type === 'notification') {
          st.pushNotification(msg.notification);
          qc.invalidateQueries({ queryKey: ['notifications'] });
          qc.invalidateQueries({ queryKey: ['alerts'] });
        } else if (msg.type === 'order') {
          qc.invalidateQueries({ queryKey: ['broker'] });
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return; // an older socket replaced by a reconnect
        socket = null;
        useTicks.getState().setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    /** Reconnect now (network back, tab shown) unless a socket is already open or opening. */
    const kick = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      const st = socket?.readyState;
      if (st === WebSocket.OPEN || st === WebSocket.CONNECTING) return;
      retry = 0;
      connect();
    };
    const onVisible = () => kick();
    const silence = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastMsg > WS_SILENCE_MS) socket.close();
    }, 5000);
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(silence);
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisible);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, [enabled, qc]);
}

/** Ask the live feed to also stream these symbols while the component is mounted. */
export function useSubscribe(symbols: string[]) {
  const key = symbols.join(',');
  useEffect(() => {
    const add = key.split(',').filter(Boolean);
    trackSymbols(add, 1);
    sendSubscribe();
    return () => {
      trackSymbols(add, -1);
      sendSubscribe();
    };
  }, [key]);
}
