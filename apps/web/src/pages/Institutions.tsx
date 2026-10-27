import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented, Spinner } from '../components/ui';

/**
 * Institutional Activity: the official NSE end-of-day institutional files in one tab — FII / DII cash
 * flows and the participant-wise F&O positions (client, DII, FII, pro). They were two tabs of the same
 * kind of data; old addresses (/fii-dii, /participants) redirect here.
 */
const FiiDii = lazy(() => import('./FiiDii'));
const Participants = lazy(() => import('./Participants'));

const VIEWS = [
  { value: 'fii-dii', label: 'FII / DII cash flows' },
  { value: 'participants', label: 'Participant-wise OI' },
] as const;
type View = (typeof VIEWS)[number]['value'];

export default function Institutions() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('view');
  const view: View = VIEWS.some((v) => v.value === raw) ? (raw as View) : 'fii-dii';
  return (
    <div className="space-y-2">
      <nav aria-label="Institutional Activity views" className="overflow-x-auto">
        <Segmented value={view} onChange={(v) => setParams({ view: v }, { replace: true })} options={VIEWS.map((v) => ({ value: v.value, label: v.label }))} />
      </nav>
      <Suspense fallback={<Spinner />}>{view === 'fii-dii' ? <FiiDii /> : <Participants />}</Suspense>
    </div>
  );
}
