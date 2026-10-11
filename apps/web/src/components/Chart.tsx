import { useEffect, useMemo, useRef } from 'react';
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

export function Chart({ option, height = 320, className, onEvents }: { option: EChartsCoreOption; height?: number | string; className?: string; onEvents?: Record<string, (p: unknown) => void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const theme = useApp((s) => s.theme);

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
    inst.current?.setOption(option, { replaceMerge: ['series', 'xAxis', 'yAxis', 'visualMap', 'grid', 'legend'] });
  }, [option, theme]);

  useEffect(() => {
    const chart = inst.current;
    if (!chart || !onEvents) return;
    for (const [ev, fn] of Object.entries(onEvents)) chart.on(ev, fn);
    return () => {
      for (const [ev, fn] of Object.entries(onEvents)) chart.off(ev, fn);
    };
  }, [onEvents, theme]);

  return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}

/**
 * Green-above-zero / red-below-zero colouring for P&L lines.
 * Pieces need finite outer bounds: open-ended pieces yield no gradient stops and
 * ECharts 5.6's line renderer then throws "reading 'coord'".
 */
export function pnlVisualMap(c: ChartColors, seriesIndex = 0): Record<string, unknown> {
  return { show: false, seriesIndex, dimension: 1, pieces: [{ gt: 0, lte: 1e15, color: c.up }, { gte: -1e15, lte: 0, color: c.down }] };
}
