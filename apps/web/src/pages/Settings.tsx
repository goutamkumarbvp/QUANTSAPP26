import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, SecondsStatus, UserProfile, UserSettings } from '@q26/core';
import { FeedDetails } from '../components/FeedStatus';
import { SymbolSelect } from '../components/pickers';
import { Card, cx, ErrorBox, Field, Loadable, PageHeader, Pill, Segmented, Toggle } from '../components/ui';
import { api, ensureSession, setToken } from '../lib/api';
import { formatDate } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useFeed } from '../lib/feed';
import { useApp, useTicks } from '../lib/store';

interface InstallEvent extends Event {
  prompt: () => Promise<void>;
}

function Account() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const qc = useQueryClient();
  const [mode, setMode] = useState<'register' | 'login'>(user?.guest ? 'register' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setError(null);
    try {
      const r = await api<AuthResponse>(`/auth/${mode}`, { body: mode === 'register' ? { name, email, password } : { email, password } });
      setToken(r.token);
      setUser(r.user);
      qc.invalidateQueries();
    } catch (e) {
      setError(e);
    }
  };
  const logout = async () => {
    setToken(null);
    setUser(await ensureSession());
    qc.invalidateQueries();
  };
  if (user && !user.guest) {
    return (
      <Card title="Account">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-semibold">{user.name}</div>
            <div className="text-sm text-muted">{user.email}</div>
          </div>
          <button className="btn-ghost" onClick={logout}>Sign out</button>
        </div>
      </Card>
    );
  }
  return (
    <Card title={<span>Account <Pill tone="warn">Guest</Pill></span>}>
      <p className="mb-3 text-sm text-muted">You are using a guest account — your watchlists, strategies and paper trades are kept on this server under a guest ID. Create an account to keep them (your guest data is carried over) or sign in to an existing one.</p>
      <Segmented value={mode} onChange={setMode} options={[{ value: 'register', label: 'Create account' }, { value: 'login', label: 'Sign in' }]} />
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {mode === 'register' && <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
        <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
        <Field label="Password (min 6)"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} /></Field>
      </div>
      {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
      <button className="btn-primary mt-3" onClick={submit} disabled={!email || password.length < 6}>{mode === 'register' ? 'Create account' : 'Sign in'}</button>
    </Card>
  );
}

export default function Settings() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const setSymbol = useApp((s) => s.setSymbol);
  const clock = useTicks((s) => s.clock);
  const connected = useTicks((s) => s.connected);
  const feed = useFeed();
  const [installEvt, setInstallEvt] = useState<InstallEvent | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const h = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as InstallEvent);
    };
    window.addEventListener('beforeinstallprompt', h);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const update = async (patch: Partial<UserSettings>) => {
    setError(null);
    try {
      setUser(await api<UserProfile>('/settings', { method: 'PUT', body: patch }));
    } catch (e) {
      setError(e);
    }
  };
  const s = user?.settings;
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader title="Settings" />
      <Account />
      {s && (
        <Card title="Preferences">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Theme"><Segmented value={theme} onChange={(t) => { setTheme(t); update({ theme: t }); }} options={[{ value: 'dark', label: '☾ Dark' }, { value: 'light', label: '☀ Light' }]} /></Field>
            <Field label="Default symbol"><SymbolSelect value={s.defaultSymbol} onChange={(v) => { setSymbol(v); update({ defaultSymbol: v }); }} /></Field>
            <Field label="Option chain strikes around ATM">
              <Segmented value={s.strikesAround} onChange={(v) => update({ strikesAround: v })} options={[10, 15, 20, 25].map((n) => ({ value: n, label: `±${n}` }))} />
            </Field>
            <Field label="Show OI in"><Segmented value={s.oiUnit} onChange={(v) => update({ oiUnit: v })} options={[{ value: 'qty', label: 'Quantity' }, { value: 'lots', label: 'Lots' }]} /></Field>
            <Field label="Option chain Greeks"><Toggle checked={s.showGreeks} onChange={(v) => update({ showGreeks: v })} label="Show Greeks by default" /></Field>
          </div>
          {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
        </Card>
      )}
      <Card title="Install app">
        <p className="text-sm text-muted">Q26 Options is a progressive web app — install it on Android, iOS (Share → Add to Home Screen) or desktop for a full-screen, app-like experience.</p>
        {installEvt && <button className="btn-primary mt-2" onClick={() => installEvt.prompt()}>Install</button>}
      </Card>
      <SecondsCard />
      <Card title="Data sources">
        <div className="space-y-2 text-sm text-muted">
          <p>
            The app runs <b className="text-ink">only on live data</b>. Where a live or official value is not available it is left blank (<span className="text-ink">—</span>) and the reason is shown; nothing is filled in with a default, a zero or a modelled number.
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>
              <b className="text-ink">Live market data</b> — prices, bid/ask, volume and open interest come from the Kotak Neo market-data feed and REST API, through the server's own broker login (credentials never reach the browser).
            </li>
            <li>
              <b className="text-ink">Official end-of-day files</b> — daily history (closes, futures and option settlement prices, index closes, participant-wise OI and volume, FII/DII flows) comes from the data NSE and BSE publish, loaded each evening once it is out.
            </li>
            <li>
              <b className="text-ink">Derived values</b> — computed by the app from those inputs and labelled as such: IV and Greeks solved from live premiums, PCR, max pain, build-up, opening-range trend, strategy payoff and probability of profit, and the SPAN-style margin <i>estimate</i>. Order-flow buy/sell is <i>estimated from live ticks (quote rule)</i>: a trade at or above the ask counts as a buy, at or below the bid as a sell, anything else stays unclassified.
            </li>
            <li>
              <b className="text-ink">Intraday history</b> (OI trend, order flow, opening range, straddle and strategy charts, Trade Recap, algo backtests) is built from the minutes this server has recorded since it started recording, plus Kotak 1-minute history for contracts still trading. Before that, the screen says so.
            </li>
          </ul>
          <p>Paper trading only: orders are never sent to an exchange or broker. Market orders fill at the live bid/ask and are rejected when there is none. Nothing here is investment advice.</p>
        </div>
      </Card>
      <Card title="Live feed status">
        <FeedDetails clock={clock} view={feed} appConnected={connected} />
      </Card>
    </div>
  );
}

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 2 : 1)} GB`;

/** One-second snapshot store: space used against its cap, days held, free disk, a pause for a full disk. */
export function SecondsCard() {
  const q = useLive<SecondsStatus>(['seconds-status'], '/seconds/status', 60_000);
  return (
    <Card title="1-second data (backtests)">
      <Loadable q={q} compact>
        {(s) =>
          !s.enabled ? (
            <p className="text-sm text-muted">One-second recording is off (SECONDS_RECORD=false in .env). Backtests use the one-minute recording.</p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span>
                  <b>{gb(s.bytes)}</b> <span className="text-muted">of {gb(s.maxBytes)} · {s.days} day{s.days === 1 ? '' : 's'}{s.oldest ? ` (${formatDate(s.oldest, true)} – ${formatDate(s.newest, true)})` : ''}</span>
                </span>
                <span className="text-xs text-muted">kept {s.retentionDays} days or {gb(s.maxBytes)}, oldest removed first</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={Math.round((s.bytes / s.maxBytes) * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="1-second data space used">
                <div className={cx('h-full', s.bytes / s.maxBytes > 0.9 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, (s.bytes / s.maxBytes) * 100)}%` }} />
              </div>
              <div className="text-xs text-muted">
                Free disk: {s.freeBytes === null ? 'not reported by this system' : gb(s.freeBytes)}. Recorded from the live feed while the market is open (every streamed instrument, one row per second it ticked); finished days are compressed.
              </div>
              {s.paused && <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn" role="status">{s.paused}</div>}
              {s.freeBytes !== null && s.freeBytes < s.maxBytes - s.bytes && !s.paused && (
                <div className="text-xs text-warn">The disk has less free space ({gb(s.freeBytes)}) than the rest of the {gb(s.maxBytes)} limit: recording pauses when under 2 GB are free.</div>
              )}
            </div>
          )
        }
      </Loadable>
    </Card>
  );
}
