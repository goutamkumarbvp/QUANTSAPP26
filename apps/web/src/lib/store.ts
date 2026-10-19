import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Leg, MarketClockInfo, Notification, Quote, UserProfile } from '@q26/core';

/* ------------------------------- session ------------------------------- */

interface AppState {
  user: UserProfile | null;
  theme: 'dark' | 'light';
  symbol: string;
  setUser: (u: UserProfile | null) => void;
  setTheme: (t: 'dark' | 'light') => void;
  setSymbol: (s: string) => void;
}

function applyTheme(t: 'dark' | 'light') {
  document.documentElement.classList.toggle('dark', t === 'dark');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0b1220' : '#f3f6fb');
  try {
    localStorage.setItem('q26-theme', t);
  } catch {
    /* ignore */
  }
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      theme: 'dark',
      symbol: 'NIFTY',
      setUser: (user) => set({ user }),
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },
      setSymbol: (symbol) => set({ symbol }),
    }),
    { name: 'q26-app', partialize: (s) => ({ theme: s.theme, symbol: s.symbol }), onRehydrateStorage: () => (s) => s && applyTheme(s.theme) },
  ),
);

/* --------------------------- strategy builder --------------------------- */

export interface BuilderLeg extends Leg {
  id: string;
  symbol?: string;
}

interface BuilderState {
  symbol: string;
  legs: BuilderLeg[];
  setSymbol: (s: string) => void;
  add: (leg: Omit<BuilderLeg, 'id'> & { id?: string }) => void;
  update: (id: string, patch: Partial<BuilderLeg>) => void;
  remove: (id: string) => void;
  setLegs: (symbol: string, legs: Leg[]) => void;
  clear: () => void;
}

let legSeq = 0;
const newId = () => `L${Date.now().toString(36)}${(legSeq++).toString(36)}`;

export const useBuilder = create<BuilderState>()(
  persist(
    (set, get) => ({
      symbol: 'NIFTY',
      legs: [],
      setSymbol: (symbol) => set({ symbol, legs: get().symbol === symbol ? get().legs : [] }),
      add: (leg) => {
        // Legs of a different underlying start a fresh strategy.
        const symbol = leg.symbol ?? get().symbol;
        const legs = get().symbol === symbol ? get().legs : [];
        set({ symbol, legs: [...legs, { ...leg, id: leg.id ?? newId(), active: leg.active ?? true }] });
      },
      update: (id, patch) => set({ legs: get().legs.map((l) => (l.id === id ? { ...l, ...patch } : l)) }),
      remove: (id) => set({ legs: get().legs.filter((l) => l.id !== id) }),
      setLegs: (symbol, legs) => set({ symbol, legs: legs.map((l) => ({ ...l, id: newId(), active: l.active ?? true })) }),
      clear: () => set({ legs: [] }),
    }),
    { name: 'q26-builder' },
  ),
);

/* ------------------------------- live ticks ------------------------------- */

interface TickState {
  quotes: Record<string, Quote>;
  prev: Record<string, number>;
  clock: MarketClockInfo | null;
  connected: boolean;
  notifications: Notification[];
  setTicks: (clock: MarketClockInfo, quotes: Quote[]) => void;
  setConnected: (c: boolean) => void;
  pushNotification: (n: Notification) => void;
  dismiss: (id: string) => void;
}

export const useTicks = create<TickState>()((set, get) => ({
  quotes: {},
  prev: {},
  clock: null,
  connected: false,
  notifications: [],
  setTicks: (clock, quotes) => {
    // A batch without quotes is the periodic clock / feed-status heartbeat: keep the last flash direction.
    if (!quotes.length) {
      set({ clock });
      return;
    }
    const prev: Record<string, number> = {};
    const cur = get().quotes;
    for (const q of quotes) prev[q.symbol] = cur[q.symbol]?.ltp ?? q.ltp;
    const next = { ...cur };
    for (const q of quotes) next[q.symbol] = q;
    set({ clock, quotes: next, prev });
  },
  setConnected: (connected) => set({ connected }),
  pushNotification: (n) => set({ notifications: [n, ...get().notifications].slice(0, 5) }),
  dismiss: (id) => set({ notifications: get().notifications.filter((n) => n.id !== id) }),
}));
