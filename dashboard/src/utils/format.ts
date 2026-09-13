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

// chart inks as raw hex: SVG presentation attributes can't resolve css vars.
// series pair validated with the dataviz palette checker against #ffffff.
export const CHART = {
  series1: "#2a78d6",
  series2: "#eb6834",
  volume: "#d6d2c7",
  grid: "#eeece6",
  axis: "#8a8f89",
  surface: "#ffffff",
  border: "#e5e2da",
  ink: "#121814",
  ink2: "#3d4540",
} as const;

export const CHART_TOOLTIP_STYLE = {
  backgroundColor: CHART.surface,
  border: `1px solid ${CHART.border}`,
  borderRadius: 12,
  boxShadow: "0 12px 28px -10px rgb(18 24 20 / 0.25)",
  color: CHART.ink,
  fontSize: 12.5,
  padding: "8px 12px",
} as const;
