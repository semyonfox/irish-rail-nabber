// status ramp: color only when something is wrong.
// <=5 min counts as running to time (matches the "within 5m" copy).
export function delayColor(minutes: number | null | undefined): string {
  if (minutes == null) return "var(--rail-muted)";
  if (minutes <= 0) return "var(--rail-green)";
  if (minutes <= 5) return "var(--rail-text)";
  if (minutes <= 15) return "var(--rail-warn)";
  return "var(--rail-red)";
}

export function delayLabel(minutes: number | null | undefined): string {
  if (minutes == null) return "N/A";
  if (minutes <= 0) return "On time";
  return `${minutes} min late`;
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

// chart inks as raw hex: SVG presentation attributes can't resolve css vars.
// series pair validated with the dataviz palette checker against #101312.
export const CHART = {
  series1: "#3987e5",
  series2: "#008300",
  volume: "#5d6862",
  grid: "#202623",
  axis: "#8b958e",
  surface: "#101312",
  border: "#262c29",
  ink: "#d8ded9",
} as const;

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: CHART.surface,
  border: `1px solid ${CHART.border}`,
  borderRadius: 0,
  color: CHART.ink,
  fontSize: 12,
} as const;
