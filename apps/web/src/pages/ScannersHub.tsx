import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/ui';

/**
 * F&O Scanners: the pre-built scans and the unusual-option-activity screen are both market-wide scans, so
 * they share one tab; /unusual redirects here (?view=unusual).
 */
const Scanners = lazy(() => import('./Scanners'));
const Unusual = lazy(() => import('./Unusual'));

/** The views; the menu's sub-tabs select one with ?view=. */
const VIEWS = ['scans', 'unusual'] as const;
type View = (typeof VIEWS)[number];

export default function ScannersHub() {
  const [params] = useSearchParams();
  const raw = params.get('view');
  const view: View = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as View) : 'scans';
  return (
    <div className="space-y-2">
      <Suspense fallback={<Spinner />}>{view === 'scans' ? <Scanners /> : <Unusual />}</Suspense>
    </div>
  );
}
