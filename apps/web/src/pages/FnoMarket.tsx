import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/ui';

/**
 * F&O Market: the whole F&O universe from one data set (each near-month future's live price and OI change
 * vs the previous session), seen three ways — a heat-map, the build-up table and the sector breadth.
 * One tab instead of three, so the same rows are not repeated across the menu.
 */
const Synopsis = lazy(() => import('./Synopsis'));
const FuturesOI = lazy(() => import('./oi/FuturesOI'));
const Breadth = lazy(() => import('./oi/Breadth'));

/** The views; the menu's sub-tabs select one with ?view=. */
const VIEWS = ['heatmap', 'futures', 'breadth'] as const;
type View = (typeof VIEWS)[number];

export default function FnoMarket() {
  const [params] = useSearchParams();
  const raw = params.get('view');
  const view: View = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as View) : 'heatmap';
  return (
    <div className="space-y-2">
      <Suspense fallback={<Spinner />}>{view === 'heatmap' ? <Synopsis /> : view === 'futures' ? <FuturesOI /> : <Breadth />}</Suspense>
    </div>
  );
}
