import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, UserProfile, UserSettings } from '@q26/core';
import { SymbolSelect } from '../components/pickers';
import { Card, ErrorBox, Field, PageHeader, Pill, Segmented, Toggle } from '../components/ui';
import { api, ensureSession, setToken } from '../lib/api';
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
      <Card title="About the data">
        <div className="space-y-2 text-sm text-muted">
          <p>
            Market data is produced by a deterministic simulator modelled on NSE/BSE F&O conventions (lot sizes, strike steps, Tuesday/Thursday expiries, SPAN-style margins). Every price, IV and OI value is reproducible, which powers historical replay. It is <b className="text-ink">not live exchange data</b> and nothing here is investment advice.
          </p>
          {clock && <p>Market clock: <b className="text-ink">{clock.mode === 'demo' ? `simulated session (${clock.speed}× speed)` : 'real IST clock'}</b> · {clock.date} {clock.time}</p>}
          <p>Paper trades use simulated fills at the bid/ask. No real orders are ever sent to an exchange or broker.</p>
        </div>
      </Card>
    </div>
  );
}
