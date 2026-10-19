import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MarketClockInfo } from '@q26/core';
import { hasChartData } from '../src/components/Chart';
import { DataTable } from '../src/components/DataTable';
import { FeedDetails } from '../src/components/FeedStatus';
import { BuildUpBadge, Chg, Coverage, Dash, ErrorState, Gaps, Loadable, NoData, Stat, Val } from '../src/components/ui';
import { ApiError } from '../src/lib/api';
import { feedView } from '../src/lib/feed';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noLive = new ApiError('No live NIFTY price: the feed is not connected', 503, 'NO_LIVE_DATA');

describe('Val / Dash / Chg / Stat / BuildUpBadge are null-safe', () => {
  it('Val shows the formatted number, or a dash with the reason as tooltip', () => {
    expect(html(<Val value={12.3456} format={(x) => x.toFixed(2)} />)).toContain('12.35');
    const blank = html(<Val value={null} reason="No live premium" />);
    expect(blank).toContain('—');
    expect(blank).toContain('title="No live premium"');
    for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = html(<Val value={v} />);
      expect(out).toContain('—');
      expect(out).not.toMatch(/NaN|Infinity|undefined|null|>0</);
    }
    expect(html(<Val value={0} />)).toContain('0.00'); // a real zero stays a zero
    expect(html(<Val value="ABC" />)).toContain('ABC');
    expect(html(<Val value="" />)).toContain('—');
  });

  it('Chg', () => {
    expect(html(<Chg value={null} reason="Needs the previous close" />)).toContain('title="Needs the previous close"');
    expect(html(<Chg value={undefined} pct />)).toContain('—');
    expect(html(<Chg value={1.5} pct />)).toContain('+1.50%');
    expect(html(<Chg value={-2} />)).toContain('text-down');
    expect(html(<Chg value={Number.NaN} />)).not.toContain('NaN');
  });

  it('Stat shows a muted dash and the reason when the value is missing', () => {
    const out = html(<Stat label="PCR" value={null} reason="No strike has OI on both sides" tone="up" />);
    expect(out).toContain('—');
    expect(out).toContain('No strike has OI on both sides');
    expect(out).not.toContain('text-up');
    expect(html(<Stat label="PCR" value={Number.NaN} />)).toContain('—');
    expect(html(<Stat label="Lots" value="12" tone="up" />)).toContain('text-up');
  });

  it('BuildUpBadge', () => {
    expect(html(<BuildUpBadge value={null} reason="Needs the previous OI" />)).toContain('Needs the previous OI');
    expect(html(<BuildUpBadge value="Long Build-up" short />)).toContain('LB');
  });

  it('Dash without a reason has no tooltip', () => {
    expect(html(<Dash />)).not.toContain('title=');
  });
});

describe('NoData / Gaps / Coverage', () => {
  it('NoData shows the reason and the hint', () => {
    const out = html(<NoData title="No recording" reason="Nothing recorded for 2026-10-12" hint="Recording started 2026-10-13" />);
    expect(out).toContain('Nothing recorded for 2026-10-12');
    expect(out).toContain('Recording started 2026-10-13');
    expect(out).toContain('role="status"');
  });

  it('Gaps lists section → reason, can filter, and truncates long lists', () => {
    const gaps = { carry: 'pre-open print not used until the session opens', atmIv: 'no live premium', skew: 'x' };
    const out = html(<Gaps gaps={gaps} omit={['skew']} />);
    expect(out).toContain('carry');
    expect(out).toContain('pre-open print not used until the session opens');
    expect(out).toContain('atmIv');
    expect(out).not.toContain('skew');
    expect(html(<Gaps gaps={gaps} only={['atmIv']} />)).not.toContain('carry');
    expect(html(<Gaps gaps={undefined} />)).toBe('');
    expect(html(<Gaps gaps={{}} />)).toBe('');
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`s${i}`, `why ${i}`]));
    expect(html(<Gaps gaps={many} max={3} />)).toContain('+7 more');
  });

  it('Coverage renders nothing without a note', () => {
    expect(html(<Coverage text={null} />)).toBe('');
    expect(html(<Coverage text="PCR over strikes with OI on both sides" label="Coverage" />)).toContain('PCR over strikes with OI on both sides');
  });
});

describe('Loadable / ErrorState', () => {
  const body = (d: string) => <span>{d}</span>;
  it('a NO_LIVE_DATA answer renders the blank state with the server reason, not the red box', () => {
    const out = html(<Loadable q={{ isLoading: false, error: noLive }}>{body}</Loadable>);
    expect(out).toContain('No live NIFTY price: the feed is not connected');
    expect(out).toContain('role="status"');
    expect(out).not.toContain('text-down');
  });
  it('NO_LIVE_DATA replaces older data on screen', () => {
    const out = html(<Loadable q={{ data: 'STALE-VALUE', isLoading: false, error: noLive }}>{body}</Loadable>);
    expect(out).not.toContain('STALE-VALUE');
  });
  it('another error keeps the red ErrorBox; after a failed refresh the last answer stays with a note', () => {
    expect(html(<Loadable q={{ isLoading: false, error: new ApiError('boom', 500) }}>{body}</Loadable>)).toContain('text-down');
    const out = html(<Loadable q={{ data: 'last', isLoading: false, error: new ApiError('boom', 500) }}>{body}</Loadable>);
    expect(out).toContain('last');
    expect(out).toContain('Could not refresh');
  });
  it('spinner while loading, children when loaded; hint passes through', () => {
    expect(html(<Loadable q={{ isLoading: true, error: null }}>{body}</Loadable>)).toContain('Loading');
    expect(html(<Loadable q={{ data: 'ready', isLoading: false, error: null }}>{body}</Loadable>)).toContain('ready');
    expect(html(<Loadable q={{ isLoading: false, error: noLive }} hint="Recording started 2026-10-13">{body}</Loadable>)).toContain('Recording started 2026-10-13');
  });
  it('ErrorState', () => {
    expect(html(<ErrorState error={noLive} />)).toContain('role="status"');
    expect(html(<ErrorState error={new Error('x')} />)).toContain('text-down');
  });
});

describe('DataTable', () => {
  const rows = [{ n: 'a', v: 5 }, { n: 'b', v: null as number | null }, { n: 'c', v: 9 }];
  it('shows a dash for a missing value and keeps missing rows last', () => {
    const out = html(<DataTable rows={rows} rowKey={(r) => r.n} columns={[{ key: 'n', label: 'N', value: (r) => r.n }, { key: 'v', label: 'V', value: (r) => r.v, num: true }]} initialSort={{ key: 'v', dir: 'desc' }} />);
    expect(out).not.toMatch(/null|NaN|undefined/);
    expect(out.indexOf('>c<')).toBeLessThan(out.indexOf('>a<'));
    expect(out.indexOf('>a<')).toBeLessThan(out.indexOf('>b<'));
    const asc = html(<DataTable rows={rows} rowKey={(r) => r.n} columns={[{ key: 'n', label: 'N', value: (r) => r.n }, { key: 'v', label: 'V', value: (r) => r.v }]} initialSort={{ key: 'v', dir: 'asc' }} />);
    expect(asc.indexOf('>a<')).toBeLessThan(asc.indexOf('>c<'));
    expect(asc.indexOf('>c<')).toBeLessThan(asc.indexOf('>b<'));
    expect(out).toContain('—');
  });
});

describe('hasChartData (a chart with nothing to draw shows the blank state)', () => {
  it('is false for empty series, all-null series or no series', () => {
    expect(hasChartData({ series: [] })).toBe(false);
    expect(hasChartData({})).toBe(false);
    expect(hasChartData({ series: [{ type: 'line', data: [] }] })).toBe(false);
    expect(hasChartData({ series: [{ type: 'line', data: [null, [1, null], [2, Number.NaN]] }] })).toBe(false);
  });
  it('is true when any series has a real point', () => {
    expect(hasChartData({ series: [{ type: 'line', data: [[1, null], [2, 3]] }] })).toBe(true);
    expect(hasChartData({ series: [{ type: 'bar', data: [0] }] })).toBe(true);
    expect(hasChartData({ series: [{ type: 'line', data: [] }, { type: 'bar', data: [{ value: 2 }] }] })).toBe(true);
    expect(hasChartData({ series: [{ type: 'treemap', data: [{ name: 'IT', children: [{ name: 'TCS', value: 5 }] }] }] })).toBe(true);
    expect(hasChartData({ series: [{ type: 'treemap', data: [{ name: 'IT', children: [] }] }] })).toBe(false);
  });
});

describe('FeedDetails', () => {
  const clock: MarketClockInfo = {
    ts: Date.UTC(2026, 9, 19, 5, 0, 0), date: '2026-10-19', time: '10:30:00', status: 'open', sessionMinute: 75,
    feed: { loggedIn: false, connected: false, lastTickTs: null, subscribed: 0, error: 'Kotak TOTP login failed: invalid code', refdataReady: false, recordingSince: null, eod: { fo: '2026-10-16', cm: null, index: null, participants: null, fiidii: null } },
  };
  it('shows the state, the reason and what is loaded', () => {
    const out = html(<FeedDetails clock={clock} view={feedView(clock, true)} appConnected />);
    expect(out).toContain('OFFLINE');
    expect(out).toContain('Kotak TOTP login failed: invalid code');
    expect(out).toContain('not logged in');
    expect(out).toContain('none yet');
    expect(out).toContain('16 Oct 2026');
    expect(out).toContain('not recording yet');
    expect(out).not.toMatch(/NaN|undefined|null/);
  });
  it('renders before any status arrives', () => {
    expect(html(<FeedDetails clock={null} view={feedView(null, false)} appConnected={false} />)).toContain('CONNECTING');
  });
});
