import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HOURLY_DELAYS } from "../graphql/queries";
import { usePollingQuery } from "../utils/usePollingQuery";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";

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

  const tooltipLabel = (_: unknown, payload?: readonly { payload?: { hour?: string } }[]) =>
    payload?.[0]?.payload?.hour?.replace("T", " ") ?? "";

  return (
    <div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart
          data={chartData}
          syncId="delay-load"
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" hide />
          <YAxis stroke={CHART.axis} fontSize={11} tickLine={false} unit="m" width={44} />
          <Tooltip
            labelFormatter={tooltipLabel}
            formatter={(value, name) => [`${Number(value).toFixed(1)} min`, name]}
            contentStyle={CHART_TOOLTIP_STYLE}
          />
          <Legend wrapperStyle={{ color: CHART.axis, fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="avgDelay"
            stroke={CHART.series1}
            strokeWidth={2}
            dot={false}
            name="Weighted avg delay"
          />
          <Line
            type="monotone"
            dataKey="maxDelay"
            stroke={CHART.series2}
            strokeWidth={2}
            strokeDasharray="4 4"
            dot={false}
            name="Worst stop"
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="px-2 pt-1 text-[9px] uppercase tracking-widest text-[var(--rail-muted)]">
        Board observations / hr
      </div>
      <ResponsiveContainer width="100%" height={72}>
        <BarChart
          data={chartData}
          syncId="delay-load"
          margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
        >
          <XAxis dataKey="label" stroke={CHART.axis} fontSize={10} tickLine={false} />
          <YAxis hide />
          <Tooltip
            labelFormatter={tooltipLabel}
            formatter={(value) => [Number(value).toLocaleString(), "Observations"]}
            contentStyle={CHART_TOOLTIP_STYLE}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          <Bar dataKey="events" name="Observations" fill={CHART.volume} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
