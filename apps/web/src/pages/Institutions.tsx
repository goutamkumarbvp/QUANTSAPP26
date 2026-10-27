import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Spinner } from '../components/ui';

/**
 * Institutional Activity: the official NSE end-of-day institutional files in one tab — FII / DII cash
 * flows and the participant-wise F&O positions (client, DII, FII, pro). They were two tabs of the same
 * kind of data; old addresses (/fii-dii, /participants) redirect here.
 */
const FiiDii = lazy(() => import('./FiiDii'));
const Participants = lazy(() => import('./Participants'));

/** The views; the menu's sub-tabs select one with ?view=. */
const VIEWS = ['fii-dii', 'participants'] as const;
type View = (typeof VIEWS)[number];

export default function Institutions() {
  const [params] = useSearchParams();
  const raw = params.get('view');
  const view: View = (VIEWS as readonly string[]).includes(raw ?? '') ? (raw as View) : 'fii-dii';
  return (
    <div className="space-y-2">
      <Suspense fallback={<Spinner />}>{view === 'fii-dii' ? <FiiDii /> : <Participants />}</Suspense>
    </div>
  );
}
