export function delayColor(minutes: number | null | undefined): string {
  if (minutes == null) return "#94a3b8";
  if (minutes <= 0) return "#22c55e";
  if (minutes <= 5) return "#eab308";
  if (minutes <= 15) return "#f97316";
  return "#ef4444";
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
