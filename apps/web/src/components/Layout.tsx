import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatIndian, formatPct, type Notification } from '@q26/core';
import { api } from '../lib/api';
import { formatDateTime, formatSessionTime } from '../lib/format';
import { MOBILE_TABS, NAV } from '../lib/nav';
import { useApp, useTicks } from '../lib/store';
import { cx } from './ui';

const TICKER = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'BANKEX'];

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
      <img src="/icon.svg" alt="" className="h-7 w-7 rounded-lg" />
      <span className="whitespace-nowrap text-base">
        Q26<span className="hidden text-accent min-[400px]:inline"> Options</span>
      </span>
    </Link>
  );
}

function Ticker() {
  const quotes = useTicks((s) => s.quotes);
  const prev = useTicks((s) => s.prev);
  const navigate = useNavigate();
  const setSymbol = useApp((s) => s.setSymbol);
  return (
    <div className="flex gap-1 overflow-x-auto no-scrollbar">
      {TICKER.map((sym) => {
        const q = quotes[sym];
        const dir = q ? (q.ltp > (prev[sym] ?? q.ltp) ? 'flash-up' : q.ltp < (prev[sym] ?? q.ltp) ? 'flash-down' : '') : '';
        return (
          <button
            key={sym}
            onClick={() => {
              setSymbol(sym);
              navigate('/option-chain');
            }}
            className="flex shrink-0 flex-col rounded-md px-2.5 py-1 text-left hover:bg-panel2"
          >
            <span className="text-2xs font-semibold text-muted">{sym}</span>
            {q ? (
              <span key={q.ltp} className={cx('flex items-baseline gap-1.5 rounded text-xs tabular-nums', dir)}>
                <span className="font-semibold">{formatIndian(q.ltp)}</span>
                <span className={q.change >= 0 ? 'text-up' : 'text-down'}>{formatPct(q.changePct)}</span>
              </span>
            ) : (
              <span className="text-xs text-muted">—</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ClockChip() {
  const clock = useTicks((s) => s.clock);
  const connected = useTicks((s) => s.connected);
  if (!clock) return <span className="chip bg-line text-muted">Connecting…</span>;
  const live = clock.status === 'open';
  return (
    <span className="chip gap-1.5 bg-panel2 text-muted" title={`${clock.mode === 'demo' ? 'Simulated market' : 'Market clock'} · ${formatDateTime(clock.ts)}`}>
      <span className={cx('h-1.5 w-1.5 rounded-full', connected && live ? 'animate-pulse bg-up' : 'bg-warn')} />
      <span className="hidden sm:inline">{clock.mode === 'demo' ? 'SIM' : 'LIVE'}</span>
      <span className="hidden tabular-nums md:inline">{formatDateTime(clock.ts)}</span>
      <span className="tabular-nums md:hidden">{formatSessionTime(clock.ts)}</span>
      <span className={live ? 'text-up' : 'text-warn'}>{clock.status === 'open' ? 'Open' : clock.status === 'pre-open' ? 'Pre-open' : 'Closed'}</span>
    </span>
  );
}

function Bell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const user = useApp((s) => s.user);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api<Notification[]>('/notifications'), enabled: !!user, refetchInterval: 30000 });
  const unread = (q.data ?? []).filter((n) => !n.read).length;
  return (
    <div className="relative">
      <button
        className="btn-ghost relative px-2"
        aria-label="Notifications"
        onClick={async () => {
          setOpen((o) => !o);
          if (!open && unread) {
            await api('/notifications/read', { method: 'POST', body: {} });
            qc.invalidateQueries({ queryKey: ['notifications'] });
          }
        }}
      >
        🔔
        {unread > 0 && <span className="absolute -right-1 -top-1 rounded-full bg-down px-1 text-2xs font-bold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-line bg-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-sm font-semibold">
            Notifications
            <Link to="/alerts" className="text-xs text-accent" onClick={() => setOpen(false)}>
              Manage alerts
            </Link>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(q.data ?? []).slice(0, 30).map((n) => (
              <li key={n.id} className="border-b border-line/60 px-3 py-2">
                <div className="text-sm font-medium">{n.title}</div>
                <div className="text-xs text-muted">{n.body}</div>
                <div className="text-2xs text-muted">{formatDateTime(n.ts)}</div>
              </li>
            ))}
            {!q.data?.length && <li className="px-3 py-6 text-center text-sm text-muted">No notifications yet</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function Toasts() {
  const items = useTicks((s) => s.notifications);
  const dismiss = useTicks((s) => s.dismiss);
  useEffect(() => {
    if (!items.length) return;
    const t = setTimeout(() => dismiss(items[items.length - 1].id), 6000);
    return () => clearTimeout(t);
  }, [items, dismiss]);
  return (
    <div className="pointer-events-none fixed bottom-20 right-3 z-50 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2 lg:bottom-4">
      {items.map((n) => (
        <button key={n.id} onClick={() => dismiss(n.id)} className="card pointer-events-auto px-3 py-2 text-left shadow-xl">
          <div className="text-sm font-semibold">{n.title}</div>
          <div className="text-xs text-muted">{n.body}</div>
        </button>
      ))}
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-4 px-2 py-3 text-sm" aria-label="Main">
      {NAV.map((g) => (
        <div key={g.title}>
          <div className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted">{g.title}</div>
          {g.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.to === '/'}
              onClick={onNavigate}
              className={({ isActive }) => cx('flex items-center gap-2 rounded-md px-2 py-1.5', isActive ? 'bg-accent/15 font-semibold text-accent' : 'text-ink/85 hover:bg-panel2')}
            >
              <span className="w-5 text-center opacity-80">{it.icon}</span>
              {it.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const user = useApp((s) => s.user);
  const loc = useLocation();
  useEffect(() => setDrawer(false), [loc.pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-line bg-panel lg:block">
        <div className="sticky top-0 z-10 border-b border-line bg-panel px-4 py-3">
          <Logo />
        </div>
        <Sidebar />
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 bg-black/50 lg:hidden" onClick={() => setDrawer(false)}>
          <aside className="h-full w-72 max-w-[85vw] overflow-y-auto bg-panel" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <Logo />
              <button className="btn-ghost px-2 py-1" onClick={() => setDrawer(false)} aria-label="Close menu">
                ✕
              </button>
            </div>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-panel/95 backdrop-blur">
          <div className="flex items-center gap-2 px-3 py-2">
            <button className="btn-ghost px-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
              ☰
            </button>
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="hidden min-w-0 flex-1 lg:block">
              <Ticker />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ClockChip />
              <button className="btn-ghost px-2" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme" title="Toggle theme">
                {theme === 'dark' ? '☀' : '☾'}
              </button>
              <Bell />
              <Link to="/settings" className="hidden h-8 w-8 items-center justify-center rounded-full bg-accent/20 text-sm font-bold text-accent sm:flex" title={user?.guest ? 'Guest — create an account in Settings' : user?.name}>
                {(user?.name ?? 'G').slice(0, 1).toUpperCase()}
              </Link>
            </div>
          </div>
          <div className="border-t border-line px-1 lg:hidden">
            <Ticker />
          </div>
        </header>
        <div className="border-b border-warn/30 bg-warn/10 px-3 py-1 text-center text-2xs text-warn">
          Simulated market data for analysis & paper trading — not live exchange prices and not investment advice.
        </div>
        <main className="min-w-0 flex-1 px-3 pb-24 pt-3 sm:px-4 lg:pb-6">{children}</main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Tabs">
        {MOBILE_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} className={({ isActive }) => cx('flex flex-col items-center py-1.5 text-2xs', isActive ? 'text-accent' : 'text-muted')}>
            <span className="text-lg leading-6">{t.icon}</span>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
