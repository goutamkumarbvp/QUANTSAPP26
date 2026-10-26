import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented, Spinner } from '../components/ui';

/**
 * F&O Market: the whole F&O universe from one data set (each near-month future's live price and OI change
 * vs the previous session), seen three ways — a heat-map, the build-up table and the sector breadth.
 * One tab instead of three, so the same rows are not repeated across the menu.
 */
const Synopsis = lazy(() => import('./Synopsis'));
const FuturesOI = lazy(() => import('./oi/FuturesOI'));
const Breadth = lazy(() => import('./oi/Breadth'));

const VIEWS = [
  { value: 'heatmap', label: 'Heat-map' },
  { value: 'futures', label: 'Futures build-up' },
  { value: 'breadth', label: 'Breadth by sector' },
] as const;
type View = (typeof VIEWS)[number]['value'];

export default function FnoMarket() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: View = VIEWS.some((v) => v.value === raw) ? (raw as View) : 'heatmap';
  return (
    <div className="space-y-2">
      <nav aria-label="F&O Market views">
        <Segmented value={view} onChange={(v) => setParams({ view: v }, { replace: true })} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
      </nav>
      <Suspense fallback={<Spinner />}>{view === 'heatmap' ? <Synopsis /> : view === 'futures' ? <FuturesOI /> : <Breadth />}</Suspense>
    </div>
  );
}
