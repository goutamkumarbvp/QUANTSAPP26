import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { ErrorBox, Spinner } from './components/ui';
import { ApiError, ensureSession } from './lib/api';
import { useApp } from './lib/store';
import { useLiveConnection } from './lib/ws';

/** Every page's code loader, so the tabs can be fetched ahead of the first click. */
const loaders: Array<() => Promise<unknown>> = [];
function page<T extends ComponentType<object>>(load: () => Promise<{ default: T }>) {
  loaders.push(load);
  return lazy(load);
}

/**
 * Loads every tab's code once the browser is idle after start-up (one chunk at a time), so a tab switch
 * renders at once instead of showing a spinner while its code downloads. Already-loaded chunks cost nothing.
 */
export function preloadPages(): void {
  const idle = (fn: () => void) => ('requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 500));
  const next = (i: number) => {
    if (i >= loaders.length) return;
    loaders[i]()
      .catch(() => undefined)
      .finally(() => idle(() => next(i + 1)));
  };
  idle(() => next(0));
}

const Home = page(() => import('./pages/Home'));
const Tools = page(() => import('./pages/Tools'));
const OptionChainPage = page(() => import('./pages/OptionChain'));
const McxChain = page(() => import('./pages/McxChain'));
const Top10 = page(() => import('./pages/Top10'));
const Watchlist = page(() => import('./pages/Watchlist'));
const FnoMarket = page(() => import('./pages/FnoMarket'));
const FiiDii = page(() => import('./pages/FiiDii'));
const Participants = page(() => import('./pages/Participants'));
const StrikeOI = page(() => import('./pages/oi/StrikeOI'));
const MultiStrike = page(() => import('./pages/oi/MultiStrike'));
const Pcr = page(() => import('./pages/oi/Pcr'));
const MaxPain = page(() => import('./pages/oi/MaxPain'));
const IvChart = page(() => import('./pages/vol/IvChart'));
const IvTable = page(() => import('./pages/vol/IvTable'));
const Skew = page(() => import('./pages/vol/Skew'));
const Surface = page(() => import('./pages/vol/Surface'));
const Cone = page(() => import('./pages/vol/Cone'));
const Builder = page(() => import('./pages/Builder'));
const Templates = page(() => import('./pages/Templates'));
const Optimizer = page(() => import('./pages/Optimizer'));
const Straddle = page(() => import('./pages/Straddle'));
const StrategyChart = page(() => import('./pages/StrategyChart'));
const Recap = page(() => import('./pages/Recap'));
const Positions = page(() => import('./pages/Positions'));
const Strategies = page(() => import('./pages/Strategies'));
const Alerts = page(() => import('./pages/Alerts'));
const Scanners = page(() => import('./pages/Scanners'));
const Unusual = page(() => import('./pages/Unusual'));
const OrderBook = page(() => import('./pages/OrderBook'));
const Orb = page(() => import('./pages/Orb'));
const Algo = page(() => import('./pages/Algo'));
const Calculators = page(() => import('./pages/Calculators'));
const Learn = page(() => import('./pages/Learn'));
const Settings = page(() => import('./pages/Settings'));
const NotFound = page(() => import('./pages/NotFound'));

/** Longest pause between two tries while the server does not answer. */
const SERVER_RETRY_MAX_MS = 10_000;

/** Shown while the server does not answer: what is happening and what to check. Retries by itself. */
export function ServerWaiting({ tries, reason }: { tries: number; reason: string }) {
  return (
    <div className="mx-auto max-w-xl space-y-3 rounded-lg border border-line bg-panel p-4 text-sm" role="status">
      <Spinner label={`Waiting for the Q26 server… (try ${tries})`} />
      <p>The browser cannot reach the Q26 server ({reason}). The page opens by itself as soon as the server answers.</p>
      <ul className="list-disc space-y-1 pl-5 text-muted">
        <li>On the PC: the <b>START-Q26</b> window must be open and show “Q26 Options on :8787”. The first start takes a minute or two.</li>
        <li>If that window closed or shows an error, start <b>START-Q26.bat</b> again (the error text there says what is wrong).</li>
        <li>On a phone: use the PC's address (<code>http://&lt;PC IPv4&gt;:8787</code> from <code>ipconfig</code>), the same Wi-Fi, and allow Node.js through Windows Firewall on private networks.</li>
      </ul>
    </div>
  );
}

export function App() {
  const setUser = useApp((s) => s.setUser);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [waiting, setWaiting] = useState<{ tries: number; reason: string } | null>(null);

  // The server not answering at all (not started yet, stopped, wrong address, firewall) is retried until
  // it answers, then the app opens by itself; an answer that is an error is shown as before.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (tries: number) => {
      ensureSession()
        .then((u) => {
          if (stopped) return;
          setUser(u);
          setWaiting(null);
          setReady(true);
        })
        .catch((e) => {
          if (stopped) return;
          if (e instanceof ApiError) {
            setError(e);
            setWaiting(null);
            setReady(true);
            return;
          }
          setWaiting({ tries, reason: e instanceof Error ? e.message : String(e) });
          timer = setTimeout(() => attempt(tries + 1), Math.min(SERVER_RETRY_MAX_MS, 2000 * 2 ** Math.min(tries, 3)));
        });
    };
    attempt(1);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [setUser]);

  useEffect(() => {
    if (ready) preloadPages();
  }, [ready]);

  useLiveConnection(ready);
  const location = useLocation();

  return (
    <Layout>
      {error ? (
        <div className="mb-3">
          <ErrorBox error={`Could not reach the server: ${error instanceof Error ? error.message : String(error)}`} />
        </div>
      ) : null}
      {waiting ? (
        <ServerWaiting tries={waiting.tries} reason={waiting.reason} />
      ) : !ready ? (
        <Spinner label="Starting…" />
      ) : (
        <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/option-chain" element={<OptionChainPage />} />
            <Route path="/mcx-chain" element={<McxChain />} />
            <Route path="/nifty-top10" element={<Top10 />} />
            <Route path="/watchlist" element={<Watchlist />} />
            <Route path="/fno-market" element={<FnoMarket />} />
            {/* Merged tabs: the old addresses still work. */}
            <Route path="/synopsis" element={<Navigate to="/fno-market?view=heatmap" replace />} />
            <Route path="/fii-dii" element={<FiiDii />} />
            <Route path="/participants" element={<Participants />} />
            <Route path="/oi/strikes" element={<StrikeOI />} />
            <Route path="/oi/multi-strike" element={<MultiStrike />} />
            <Route path="/oi/trend" element={<Navigate to="/oi/pcr" replace />} />
            <Route path="/oi/pcr" element={<Pcr />} />
            <Route path="/oi/max-pain" element={<MaxPain />} />
            <Route path="/oi/futures" element={<Navigate to="/fno-market?view=futures" replace />} />
            <Route path="/oi/breadth" element={<Navigate to="/fno-market?view=breadth" replace />} />
            <Route path="/vol/iv-chart" element={<IvChart />} />
            <Route path="/vol/ivp" element={<IvTable />} />
            <Route path="/vol/skew" element={<Skew />} />
            <Route path="/vol/surface" element={<Surface />} />
            <Route path="/vol/cone" element={<Cone />} />
            <Route path="/builder" element={<Builder />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/optimizer" element={<Optimizer />} />
            <Route path="/straddle" element={<Straddle />} />
            <Route path="/strategy-chart" element={<StrategyChart />} />
            <Route path="/recap" element={<Recap />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/strategies" element={<Strategies />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/scanners" element={<Scanners />} />
            <Route path="/unusual" element={<Unusual />} />
            <Route path="/order-book" element={<OrderBook />} />
            <Route path="/orb" element={<Orb />} />
            <Route path="/order-flow" element={<Navigate to="/order-book" replace />} />
            <Route path="/algo" element={<Algo />} />
            <Route path="/calculators" element={<Calculators />} />
            <Route path="/learn" element={<Learn />} />
            <Route path="/learn/:slug" element={<Learn />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      )}
    </Layout>
  );
}
