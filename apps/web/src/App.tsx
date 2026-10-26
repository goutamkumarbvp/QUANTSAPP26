import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Layout } from './components/Layout';
import { ErrorBox, Spinner } from './components/ui';
import { ensureSession } from './lib/api';
import { useApp } from './lib/store';
import { useLiveConnection } from './lib/ws';

const Home = lazy(() => import('./pages/Home'));
const Tools = lazy(() => import('./pages/Tools'));
const OptionChainPage = lazy(() => import('./pages/OptionChain'));
const McxChain = lazy(() => import('./pages/McxChain'));
const Watchlist = lazy(() => import('./pages/Watchlist'));
const FnoMarket = lazy(() => import('./pages/FnoMarket'));
const FiiDii = lazy(() => import('./pages/FiiDii'));
const Participants = lazy(() => import('./pages/Participants'));
const StrikeOI = lazy(() => import('./pages/oi/StrikeOI'));
const MultiStrike = lazy(() => import('./pages/oi/MultiStrike'));
const Pcr = lazy(() => import('./pages/oi/Pcr'));
const MaxPain = lazy(() => import('./pages/oi/MaxPain'));
const IvChart = lazy(() => import('./pages/vol/IvChart'));
const IvTable = lazy(() => import('./pages/vol/IvTable'));
const Skew = lazy(() => import('./pages/vol/Skew'));
const Surface = lazy(() => import('./pages/vol/Surface'));
const Cone = lazy(() => import('./pages/vol/Cone'));
const Builder = lazy(() => import('./pages/Builder'));
const Templates = lazy(() => import('./pages/Templates'));
const Optimizer = lazy(() => import('./pages/Optimizer'));
const Straddle = lazy(() => import('./pages/Straddle'));
const StrategyChart = lazy(() => import('./pages/StrategyChart'));
const Recap = lazy(() => import('./pages/Recap'));
const Positions = lazy(() => import('./pages/Positions'));
const Strategies = lazy(() => import('./pages/Strategies'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Scanners = lazy(() => import('./pages/Scanners'));
const Unusual = lazy(() => import('./pages/Unusual'));
const OrderBook = lazy(() => import('./pages/OrderBook'));
const Orb = lazy(() => import('./pages/Orb'));
const Algo = lazy(() => import('./pages/Algo'));
const Calculators = lazy(() => import('./pages/Calculators'));
const Learn = lazy(() => import('./pages/Learn'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));

export function App() {
  const setUser = useApp((s) => s.setUser);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    ensureSession()
      .then((u) => setUser(u))
      .catch((e) => setError(e))
      .finally(() => setReady(true));
  }, [setUser]);

  useLiveConnection(ready);
  const location = useLocation();

  return (
    <Layout>
      {error ? (
        <div className="mb-3">
          <ErrorBox error={`Could not reach the server: ${error instanceof Error ? error.message : String(error)}`} />
        </div>
      ) : null}
      {!ready ? (
        <Spinner label="Starting…" />
      ) : (
        <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/tools" element={<Tools />} />
            <Route path="/option-chain" element={<OptionChainPage />} />
            <Route path="/mcx-chain" element={<McxChain />} />
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
