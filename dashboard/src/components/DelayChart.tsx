import {
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from "recharts";
import { HOURLY_DELAYS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";

interface HourlyDelay {
  hour: string;
  stationCode: string | null;
  avgLateMinutes: number | null;
  maxLateMinutes: number | null;
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

  const byHour = new Map<
    string,
    { weightedDelay: number; events: number; maxDelay: number | null }
  >();
  for (const d of data?.hourlyDelays ?? []) {
    if (d.avgLateMinutes == null) continue;
    const key = d.hour.slice(0, 13);
    const eventCount = Math.max(d.eventCount ?? 1, 1);
    const existing = byHour.get(key) || { weightedDelay: 0, events: 0, maxDelay: null };
    existing.weightedDelay += d.avgLateMinutes * eventCount;
    existing.events += eventCount;
    if (d.maxLateMinutes != null) {
      existing.maxDelay = Math.max(existing.maxDelay ?? d.maxLateMinutes, d.maxLateMinutes);
    }
    byHour.set(key, existing);
  }

  const chartData = Array.from(byHour.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, { weightedDelay, events, maxDelay }]) => ({
      hour,
      label: hour.slice(11, 13) + ":00",
      avgDelay: +(weightedDelay / events).toFixed(2),
      maxDelay,
      events,
    }))
    .slice(-hours);

  if (chartData.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-[var(--rail-muted)]">
        No delay data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
        <XAxis dataKey="label" stroke="#94a3b8" fontSize={12} tickLine={false} />
        <YAxis
          yAxisId="delay"
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
        <YAxis
          yAxisId="events"
          orientation="right"
          stroke="#64748b"
          fontSize={12}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          labelFormatter={(_, payload) => payload?.[0]?.payload?.hour?.replace("T", " ") ?? ""}
          formatter={(value, name) => {
            if (name === "Train-stops") return [Number(value).toLocaleString(), name];
            return [`${Number(value).toFixed(1)} min`, name];
          }}
          contentStyle={{
            backgroundColor: "#1e293b",
            border: "1px solid #334155",
            borderRadius: "8px",
            color: "#f1f5f9",
          }}
        />
        <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
        <Bar
          yAxisId="events"
          dataKey="events"
          name="Train-stops"
          fill="#334155"
          radius={[3, 3, 0, 0]}
        />
        <Line
          yAxisId="delay"
          type="monotone"
          dataKey="avgDelay"
          stroke="#22c55e"
          strokeWidth={2}
          dot={false}
          name="Weighted avg delay"
        />
        <Line
          yAxisId="delay"
          type="monotone"
          dataKey="maxDelay"
          stroke="#f97316"
          strokeWidth={2}
          strokeDasharray="4 4"
          dot={false}
          name="Worst stop"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
