import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerMessage } from '@q26/core';
import { getToken } from './api';
import { useTicks } from './store';

let socket: WebSocket | null = null;
let wanted = new Set<string>();

function sendSubscribe() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribe', symbols: [...wanted] }));
}

/** Single app-wide live connection: ticker quotes, market clock, notifications and order updates. */
export function useLiveConnection(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        retry = 0;
        useTicks.getState().setConnected(true);
        const token = getToken();
        if (token) ws.send(JSON.stringify({ type: 'auth', token }));
        sendSubscribe();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as ServerMessage;
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
        useTicks.getState().setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      socket = null;
    };
  }, [enabled, qc]);
}

/** Ask the live feed to also stream these symbols while the component is mounted. */
export function useSubscribe(symbols: string[]) {
  const key = symbols.join(',');
  useEffect(() => {
    const add = key.split(',').filter(Boolean);
    const before = new Set(wanted);
    add.forEach((s) => wanted.add(s));
    sendSubscribe();
    return () => {
      wanted = before;
      sendSubscribe();
    };
  }, [key]);
}
