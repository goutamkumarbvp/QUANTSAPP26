import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, CandlestickChart, HeatmapChart, LineChart, ScatterChart, TreemapChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import { formatSessionTime } from '../lib/format';
import { useApp } from '../lib/store';
import { cx, NoData } from './ui';

echarts.use([
  LineChart, BarChart, HeatmapChart, TreemapChart, CandlestickChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkLineComponent, MarkAreaComponent, MarkPointComponent, VisualMapComponent, TitleComponent,
  CanvasRenderer,
]);

export interface ChartColors {
  ink: string;
  muted: string;
  line: string;
  panel: string;
  panel2: string;
  accent: string;
  up: string;
  down: string;
  warn: string;
  series: string[];
}

function cssColor(name: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim().split(/\s+/).join(',');
  return alpha === 1 ? `rgb(${v})` : `rgba(${v},${alpha})`;
}

export function useChartColors(): ChartColors {
  const theme = useApp((s) => s.theme);
  return useMemo(() => {
    void theme;
    const dark = document.documentElement.classList.contains('dark');
    return {
      ink: cssColor('ink'),
      muted: cssColor('muted'),
      line: cssColor('line'),
      panel: cssColor('panel'),
      panel2: cssColor('panel2'),
      accent: cssColor('accent'),
      up: cssColor('up'),
      down: cssColor('down'),
      warn: cssColor('warn'),
      series: dark
        ? ['#4f8cff', '#f59e0b', '#22c55e', '#f85149', '#a78bfa', '#22d3ee', '#f472b6', '#facc15']
        : ['#2563eb', '#d97706', '#16a34a', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#ca8a04'],
    };
  }, [theme]);
}

/** Common axis/grid/tooltip styling. */
export function baseOption(c: ChartColors, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    backgroundColor: 'transparent',
    color: c.series,
    textStyle: { color: c.ink, fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { left: 8, right: 12, top: 36, bottom: 8, containLabel: true },
    legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8, type: 'scroll' },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: c.panel,
      borderColor: c.line,
      textStyle: { color: c.ink, fontSize: 12 },
      axisPointer: { type: 'cross', lineStyle: { color: c.muted }, crossStyle: { color: c.muted }, label: { backgroundColor: c.panel2, color: c.ink } },
    },
    ...extra,
  };
}

export function axis(c: ChartColors, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    axisLine: { lineStyle: { color: c.line } },
    axisTick: { show: false },
    axisLabel: { color: c.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: c.line, opacity: 0.6 } },
    ...extra,
  };
}

export function timeAxis(c: ChartColors, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return axis(c, { type: 'time', splitLine: { show: false }, axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatSessionTime(v), hideOverlap: true }, ...extra });
}

/**
 * Line series settings for data that can have holes: a missing point (null) stays a gap in the line — never
 * bridged, never smoothed across, never filled forward. `<Chart>` enforces the same on every line series.
 */
export const LINE_GAPS = { connectNulls: false, smooth: false } as const;

type Series = { type?: string; data?: unknown[]; [k: string]: unknown };

/** Whether a data point holds a real value (the value of `[x, y]`, of `{ value }`, of a tree node's children, or the number itself). */
function pointHasValue(p: unknown): boolean {
  if (p === null || p === undefined) return false;
  if (Array.isArray(p)) return p.length > 0 && pointHasValue(p[p.length - 1]);
  if (typeof p === 'object') {
    const o = p as { value?: unknown; children?: unknown };
    if (Array.isArray(o.children)) return o.children.some(pointHasValue);
    return pointHasValue(o.value);
  }
  return typeof p !== 'number' || Number.isFinite(p);
}

/** True when at least one series of the option has a real point (an option without series data is a blank chart). */
export function hasChartData(option: EChartsCoreOption): boolean {
  const series = (option as { series?: Series | Series[] }).series;
  const list = Array.isArray(series) ? series : series ? [series] : [];
  return list.some((s) => (s.data ?? []).some(pointHasValue));
}

/** Line series: no bridging of missing points (connectNulls off) and no smoothing across a series that has holes. */
function noInvention(option: EChartsCoreOption): EChartsCoreOption {
  const series = (option as { series?: Series | Series[] }).series;
  if (!series) return option;
  const fix = (s: Series): Series => {
    if (s.type !== 'line') return s;
    const holes = (s.data ?? []).some((p) => !pointHasValue(p));
    return { ...s, connectNulls: false, ...(holes ? { smooth: false } : {}) };
  };
  return { ...option, series: Array.isArray(series) ? series.map(fix) : fix(series) } as EChartsCoreOption;
}

/**
 * ECharts canvas. A chart with no real point in any series shows the blank state (`blank` = the reason, or the
 * default text) instead of empty axes; `blank` can also be passed to force it (e.g. the server said 503).
 */
export function Chart({ option, height = 320, className, onEvents, blank }: { option: EChartsCoreOption; height?: number | string; className?: string; onEvents?: Record<string, (p: unknown) => void>; blank?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const theme = useApp((s) => s.theme);
  const forced = blank !== undefined && blank !== null && blank !== false;
  const empty = forced || !hasChartData(option);

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    inst.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, [theme]);

  useEffect(() => {
    inst.current?.setOption(noInvention(option), { replaceMerge: ['series', 'xAxis', 'yAxis', 'visualMap', 'grid', 'legend'] });
  }, [option, theme]);

  useEffect(() => {
    const chart = inst.current;
    if (!chart || !onEvents) return;
    for (const [ev, fn] of Object.entries(onEvents)) chart.on(ev, fn);
    return () => {
      for (const [ev, fn] of Object.entries(onEvents)) chart.off(ev, fn);
    };
  }, [onEvents, theme]);

  // The canvas stays mounted (hidden) so it can draw as soon as data arrives; the blank state is laid over it.
  return (
    <div className={cx('relative', className)} style={{ height, width: '100%' }}>
      <div ref={ref} style={{ height: '100%', width: '100%', visibility: empty ? 'hidden' : 'visible' }} />
      {empty && (
        <div className="absolute inset-0 flex items-center justify-center">
          <NoData compact title="Nothing to chart" reason={forced && blank !== true ? blank : 'No data points are available for this chart.'} className="w-full" />
        </div>
      )}
    </div>
  );
}

/**
 * Green-above-zero / red-below-zero colouring for P&L lines.
 * Pieces need finite outer bounds: open-ended pieces yield no gradient stops and
 * ECharts 5.6's line renderer then throws "reading 'coord'".
 */
export function pnlVisualMap(c: ChartColors, seriesIndex = 0): Record<string, unknown> {
  return { show: false, seriesIndex, dimension: 1, pieces: [{ gt: 0, lte: 1e15, color: c.up }, { gte: -1e15, lte: 0, color: c.down }] };
}
