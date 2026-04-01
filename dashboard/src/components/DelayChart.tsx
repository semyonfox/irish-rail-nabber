import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { HOURLY_DELAYS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";

interface HourlyDelay {
  hour: string;
  stationCode: string | null;
  avgLateMinutes: number | null;
  eventCount: number | null;
}

interface HourlyDelaysData {
  hourlyDelays: HourlyDelay[];
}

interface Props {
  stationCode?: string;
  hours?: number;
}

export default function DelayChart({ stationCode, hours = 24 }: Props) {
  const [{ data, fetching }] = usePollingQuery<HourlyDelaysData>({
    query: HOURLY_DELAYS,
    variables: { stationCode, hours },
    pollInterval: 60000,
  });

  if (fetching && !data) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--rail-muted)]">
        Loading delay data...
      </div>
    );
  }

  // aggregate by hour (across all stations if no stationCode)
  const byHour = new Map<string, { sum: number; count: number }>();
  for (const d of data?.hourlyDelays ?? []) {
    if (d.avgLateMinutes == null) continue;
    const key = d.hour.slice(0, 13); // "YYYY-MM-DDTHH"
    const existing = byHour.get(key) || { sum: 0, count: 0 };
    existing.sum += d.avgLateMinutes;
    existing.count += 1;
    byHour.set(key, existing);
  }

  const chartData = Array.from(byHour.entries())
    .map(([hour, { sum, count }]) => ({
      hour: hour.slice(11, 13) + ":00",
      avgDelay: +(sum / count).toFixed(2),
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  if (chartData.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--rail-muted)]">
        No delay data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="hour" stroke="#94a3b8" fontSize={12} tickLine={false} />
        <YAxis
          stroke="#94a3b8"
          fontSize={12}
          tickLine={false}
          label={{
            value: "Avg delay (min)",
            angle: -90,
            position: "insideLeft",
            style: { fill: "#94a3b8", fontSize: 12 },
          }}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: "8px",
            color: "#f1f5f9",
          }}
        />
        <Line
          type="monotone"
          dataKey="avgDelay"
          stroke="#22c55e"
          strokeWidth={2}
          dot={false}
          name="Avg Delay (min)"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
