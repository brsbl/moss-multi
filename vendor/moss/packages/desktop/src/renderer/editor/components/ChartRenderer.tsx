// ported-from: packages/desktop/src/renderer/editor/components/ChartRenderer.tsx @ 762abb777
import type { JSX } from 'react';
import type { NodeKey } from 'lexical';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Cell
} from 'recharts';
import { chartColors } from '@moss/shared';
import type { ChartConfig, ChartDataPoint, ChartPalette, ChartSeries } from '../utils/chartDefaults';
import {
  getChartColor,
  DEFAULT_CHART_OPTIONS,
  DEFAULT_PALETTE,
  CHART_PALETTES,
  getSafePalette
} from '../utils/chartDefaults';
import { EDITOR_CHROME_COLORS } from '../colors';

// ---------------------------------------------------------------------------
// Shared chart constants
// ---------------------------------------------------------------------------

const CHART_MONO_FONT_FAMILY = 'JetBrains Mono Variable, monospace';
const AXIS_TICK = { fill: chartColors.tick, fontFamily: CHART_MONO_FONT_FAMILY, fontSize: 11 };
const AXIS_TICK_LINE = { stroke: chartColors.grid };
const AXIS_TICK_MARGIN = 8;
const LEGEND_STYLE: React.CSSProperties = { fontFamily: CHART_MONO_FONT_FAMILY, fontSize: 11 };

const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--surface-raised-card)',
  border: `1px solid ${chartColors.grid}`,
  borderRadius: '6px',
  backdropFilter: 'blur(4px)',
  padding: '4px 10px',
  fontFamily: CHART_MONO_FONT_FAMILY,
  fontSize: 11,
  textAlign: 'center'
};

/** Single-series tooltip: "Label  Value" on one line */
function SingleSeriesTooltip({ active, payload, label }: any): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={TOOLTIP_STYLE}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <span style={{ marginLeft: 8 }}>{Number(payload[0].value).toLocaleString()}</span>
    </div>
  );
}

/** Multi-series tooltip: label on top, each series name + value below */
function MultiSeriesTooltip({ active, payload, label }: any): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{ ...TOOLTIP_STYLE, textAlign: 'left' }}>
      <div style={{ fontWeight: 500, marginBottom: 2 }}>{label}</div>
      {payload.map((entry: { name: string; value: number; color: string }) => (
        <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: entry.color, flexShrink: 0 }} />
          <span>{entry.name}</span>
          <span style={{ marginLeft: 'auto', fontWeight: 500 }}>{Number(entry.value).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-series data utilities
// ---------------------------------------------------------------------------

interface FlattenedData {
  rows: Record<string, string | number>[];
  seriesNames: string[];
}

/**
 * Transforms ChartSeries[] into Recharts' flat row format.
 * Each row has a `label` key plus one key per series name.
 * Missing values across series are filled with 0.
 */
function flattenSeries(series: ChartSeries[]): FlattenedData {
  const seriesNames = series.map((s) => s.name);
  // Collect all unique labels in order of first appearance
  const labelSet = new Set<string>();
  for (const s of series) {
    for (const d of s.data) {
      labelSet.add(d.label);
    }
  }
  const labels = Array.from(labelSet);

  // Build rows: { label, seriesA: val, seriesB: val, ... }
  const rows: Record<string, string | number>[] = labels.map((label) => {
    const row: Record<string, string | number> = { label };
    for (const s of series) {
      const point = s.data.find((d) => d.label === label);
      row[s.name] = point ? point.value : 0;
    }
    return row;
  });

  return { rows, seriesNames };
}

// ---------------------------------------------------------------------------
// Chart renderer props
// ---------------------------------------------------------------------------

interface ChartRendererProps {
  config: ChartConfig;
  nodeKey: NodeKey;
  showTitle?: boolean;
}

const isPdfExportSurface = (): boolean => {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('pdfExportSessionId');
};

// ---------------------------------------------------------------------------
// Bar Chart
// ---------------------------------------------------------------------------

function BarChartRenderer({
  data,
  series,
  options,
  palette
}: {
  data: ChartDataPoint[];
  series?: ChartSeries[];
  options: ChartConfig['options'];
  palette: ChartPalette;
}): JSX.Element {
  const opts = { ...DEFAULT_CHART_OPTIONS, ...options };
  const safePalette = getSafePalette(palette);
  const isAnimationActive = !isPdfExportSurface();

  if (series && series.length > 0) {
    const { rows, seriesNames } = flattenSeries(series);
    return (
      <ResponsiveContainer width="100%" height={opts.height}>
        <BarChart data={rows} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
          {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <Tooltip content={<MultiSeriesTooltip />} cursor={{ fill: 'var(--ink-fn-rgba000003)' }} />
          {opts.showLegend && seriesNames.length > 1 && <Legend iconSize={8} wrapperStyle={LEGEND_STYLE} />}
          {seriesNames.map((name, i) => (
            <Bar key={name} dataKey={name} fill={series[i].color ?? getChartColor(i, safePalette)} isAnimationActive={isAnimationActive} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={opts.height}>
      <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
        {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <Tooltip content={<SingleSeriesTooltip />} cursor={{ fill: 'var(--ink-fn-rgba000003)' }} />
        <Bar dataKey="value" isAnimationActive={isAnimationActive}>
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={getChartColor(index, palette, entry.color)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Line Chart
// ---------------------------------------------------------------------------

function LineChartRenderer({
  data,
  series,
  options,
  palette
}: {
  data: ChartDataPoint[];
  series?: ChartSeries[];
  options: ChartConfig['options'];
  palette: ChartPalette;
}): JSX.Element {
  const opts = { ...DEFAULT_CHART_OPTIONS, ...options };
  const safePalette = getSafePalette(palette);
  const isAnimationActive = !isPdfExportSurface();

  if (series && series.length > 0) {
    const { rows, seriesNames } = flattenSeries(series);
    return (
      <ResponsiveContainer width="100%" height={opts.height}>
        <LineChart data={rows} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
          {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <Tooltip content={<MultiSeriesTooltip />} cursor={{ stroke: chartColors.grid }} />
          {opts.showLegend && seriesNames.length > 1 && <Legend iconSize={8} wrapperStyle={LEGEND_STYLE} />}
          {seriesNames.map((name, i) => {
            const color = series[i].color ?? getChartColor(i, safePalette);
            return (
              <Line key={name} type="monotone" dataKey={name} stroke={color} strokeWidth={2.5} dot={{ fill: color, strokeWidth: 2 }} activeDot={{ r: 6, fill: color }} isAnimationActive={isAnimationActive} />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  const lineColor = CHART_PALETTES[safePalette].colors[0];
  return (
    <ResponsiveContainer width="100%" height={opts.height}>
      <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
        {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <Tooltip content={<SingleSeriesTooltip />} />
        <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={2.5} dot={{ fill: lineColor, strokeWidth: 2 }} activeDot={{ r: 6, fill: lineColor }} isAnimationActive={isAnimationActive} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Stacked Bar (replaces Donut — part-to-whole visualization)
// ---------------------------------------------------------------------------

function StackedBarTooltip({ active, payload }: any): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{ ...TOOLTIP_STYLE, textAlign: 'left' as const }}>
      {[...payload].sort((a: any, b: any) => b.value - a.value).map((entry: any, i: number) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: entry.color, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{entry.name}</span>
          <span style={{ fontWeight: 500, marginLeft: 12 }}>{Number(entry.value).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

function StackedBarLegend({ data, palette }: { data: ChartDataPoint[]; palette: ChartPalette }): JSX.Element {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <div style={{ ...LEGEND_STYLE, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '4px 16px', paddingTop: 8 }}>
      {data.map((d, i) => {
        const pct = total > 0 ? ((d.value / total) * 100).toFixed(0) : '0';
        return (
          <span
            key={d.label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: EDITOR_CHROME_COLORS.chartLegendText }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: getChartColor(i, palette, d.color), flexShrink: 0 }} />
            {d.label}
            <span style={{ opacity: 0.7 }}>{pct}%</span>
          </span>
        );
      })}
    </div>
  );
}

function StackedBarRenderer({
  data,
  options,
  palette
}: {
  data: ChartDataPoint[];
  options: ChartConfig['options'];
  palette: ChartPalette;
}): JSX.Element {
  const height = options?.height ?? 120;
  const opts = { ...DEFAULT_CHART_OPTIONS, ...options, height };
  const isAnimationActive = !isPdfExportSurface();

  // Sort by value descending so largest segment is first in bar and legend
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, d) => sum + d.value, 0);

  // Reshape: single row with each label as a key
  const row: Record<string, string | number> = { _category: 'values', _total: total };
  for (const d of sorted) {
    row[d.label] = d.value;
  }

  return (
    <ResponsiveContainer width="100%" height={opts.height}>
      <BarChart layout="vertical" data={[row]} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="_category" hide />
        <Tooltip content={<StackedBarTooltip />} cursor={false} wrapperStyle={{ zIndex: 10 }} />
        {opts.showLegend && (
          <Legend content={<StackedBarLegend data={sorted} palette={palette} />} />
        )}
        {sorted.map((d, i) => (
          <Bar key={d.label} dataKey={d.label} stackId="stack" fill={getChartColor(i, palette, d.color)} isAnimationActive={isAnimationActive} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Area Chart
// ---------------------------------------------------------------------------

function AreaChartRenderer({
  data,
  series,
  options,
  palette
}: {
  data: ChartDataPoint[];
  series?: ChartSeries[];
  options: ChartConfig['options'];
  palette: ChartPalette;
}): JSX.Element {
  const opts = { ...DEFAULT_CHART_OPTIONS, ...options };
  const safePalette = getSafePalette(palette);
  const isAnimationActive = !isPdfExportSurface();

  if (series && series.length > 0) {
    const { rows, seriesNames } = flattenSeries(series);
    return (
      <ResponsiveContainer width="100%" height={opts.height}>
        <AreaChart data={rows} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
          {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
          <Tooltip content={<MultiSeriesTooltip />} />
          {opts.showLegend && seriesNames.length > 1 && <Legend iconSize={8} wrapperStyle={LEGEND_STYLE} />}
          {seriesNames.map((name, i) => {
            const color = series[i].color ?? getChartColor(i, safePalette);
            return (
              <Area key={name} type="monotone" dataKey={name} stackId="stack" stroke={color} fill={color} fillOpacity={0.25} isAnimationActive={isAnimationActive} />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  const areaColor = CHART_PALETTES[safePalette].colors[0];
  return (
    <ResponsiveContainer width="100%" height={opts.height}>
      <AreaChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
        {opts.showGrid && <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />}
        <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <YAxis tick={AXIS_TICK} tickLine={AXIS_TICK_LINE} tickMargin={AXIS_TICK_MARGIN} />
        <Tooltip content={<SingleSeriesTooltip />} />
        <Area type="monotone" dataKey="value" stroke={areaColor} fill={areaColor} fillOpacity={0.25} isAnimationActive={isAnimationActive} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

export default function ChartRenderer({ config, nodeKey, showTitle = true }: ChartRendererProps): JSX.Element {
  const { type, title, data, series, options } = config;
  const palette = options?.palette ?? DEFAULT_PALETTE;

  return (
    <div data-chart-node-key={nodeKey}>
      {showTitle && title && (
        <h4 className="mb-2 text-center text-sm font-medium text-ink-accent">{title}</h4>
      )}
      {type === 'bar' && <BarChartRenderer data={data} series={series} options={options} palette={palette} />}
      {type === 'line' && <LineChartRenderer data={data} series={series} options={options} palette={palette} />}
      {type === 'stacked-bar' && <StackedBarRenderer data={data} options={options} palette={palette} />}
      {type === 'area' && <AreaChartRenderer data={data} series={series} options={options} palette={palette} />}
    </div>
  );
}
