import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented, Spinner } from '../components/ui';

/**
 * F&O Scanners: the pre-built scans and the unusual-option-activity screen are both market-wide scans, so
 * they share one tab; /unusual redirects here (?view=unusual).
 */
const Scanners = lazy(() => import('./Scanners'));
const Unusual = lazy(() => import('./Unusual'));

const VIEWS = [
  { value: 'scans', label: 'Pre-built scans' },
  { value: 'unusual', label: 'Unusual option activity' },
] as const;
type View = (typeof VIEWS)[number]['value'];

export default function ScannersHub() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: View = VIEWS.some((v) => v.value === raw) ? (raw as View) : 'scans';
  return (
    <div className="space-y-2">
      <nav aria-label="F&O Scanners views" className="overflow-x-auto">
        <Segmented value={view} onChange={(v) => setParams({ view: v }, { replace: true })} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
      </nav>
      <Suspense fallback={<Spinner />}>{view === 'scans' ? <Scanners /> : <Unusual />}</Suspense>
    </div>
  );
}
