export type DelayTone = "ok" | "neutral" | "warn" | "bad" | "muted";

// status ramp: color only when something is wrong.
// <=5 min counts as running to time (matches the "within 5m" copy).
export function delayTone(minutes: number | null | undefined): DelayTone {
  if (minutes == null) return "muted";
  if (minutes <= 0) return "ok";
  if (minutes <= 5) return "neutral";
  if (minutes <= 15) return "warn";
  return "bad";
}

const toneColor: Record<DelayTone, string> = {
  ok: "var(--color-ok)",
  neutral: "var(--color-ink-2)",
  warn: "var(--color-warn)",
  bad: "var(--color-bad)",
  muted: "var(--color-muted)",
};

export function delayColor(minutes: number | null | undefined): string {
  return toneColor[delayTone(minutes)];
}

export function delayLabel(minutes: number | null | undefined): string {
  if (minutes == null) return "N/A";
  if (minutes <= 0) return "On time";
  return `${minutes} min late`;
}

export function shortDelay(minutes: number | null | undefined, precise = false): string {
  if (minutes == null) return "—";
  if (minutes <= 0) return "On time";
  return `+${precise ? minutes.toFixed(1) : Math.round(minutes)}m`;
}

export function formatTime(time: string | null | undefined): string {
  if (!time) return "-";
  // "HH:MM:SS" -> "HH:MM"
  return time.slice(0, 5);
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return "-";
  return `${value.toFixed(1)}%`;
}

// CSS custom properties keep SVG charts and HTML tooltips in the active theme.
export const CHART = {
  series1: "var(--chart-series-1)",
  series2: "var(--chart-series-2)",
  volume: "var(--chart-volume)",
  grid: "var(--chart-grid)",
  axis: "var(--chart-axis)",
  surface: "var(--chart-surface)",
  border: "var(--chart-border)",
  ink: "var(--chart-ink)",
  ink2: "var(--chart-ink-2)",
} as const;

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: CHART.surface,
  border: `1px solid ${CHART.border}`,
  borderRadius: 12,
  boxShadow: "var(--chart-tooltip-shadow)",
  color: CHART.ink,
  fontSize: 12.5,
  padding: "8px 12px",
} as const;
