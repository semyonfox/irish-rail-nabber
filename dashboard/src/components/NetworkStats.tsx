import { NETWORK_SUMMARY } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { formatPct } from "../utils/format";

interface NetworkSummaryData {
  networkSummary: {
    activeTrains: number;
    totalStations: number;
    avgDelayMinutes: number;
    onTimePct: number;
    lastUpdated: string | null;
  };
}

export default function NetworkStats() {
  const [{ data }] = usePollingQuery<NetworkSummaryData>({
    query: NETWORK_SUMMARY,
    pollInterval: 10000,
  });

  const s = data?.networkSummary;
  if (!s) return null;

  const cards = [
    { label: "Active Trains", value: s.activeTrains },
    { label: "Avg Delay", value: `${s.avgDelayMinutes.toFixed(1)} min` },
    { label: "On Time", value: formatPct(s.onTimePct) },
    { label: "Stations", value: s.totalStations },
  ];

  return (
    <div className="pointer-events-auto flex gap-3">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg bg-[var(--rail-surface)]/90 px-4 py-2 backdrop-blur"
        >
          <div className="text-xs text-[var(--rail-muted)]">{c.label}</div>
          <div className="text-lg font-semibold text-white">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
