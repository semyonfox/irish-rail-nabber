import {
  Bar,
  BarChart,
  CartesianGrid,
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
import { ChartLegend, Empty } from "./ui";

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

const AXIS_WIDTH = 44;
const axisProps = {
  stroke: CHART.axis,
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;
const activeDot = { r: 4, strokeWidth: 2, stroke: CHART.surface };

export default function DelayChart({ stationCode, hours = 24 }: Props) {
  const [{ data, fetching }] = usePollingQuery<HourlyDelaysData>({
    query: HOURLY_DELAYS,
    variables: { stationCode, hours },
    pollInterval: 60000,
  });

  if (fetching && !data) {
    return <Empty className="!min-h-64">Loading delay data…</Empty>;
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
    return <Empty className="!min-h-64">No delay data available</Empty>;
  }

  const tooltipLabel = (_: unknown, payload?: readonly { payload?: { hour?: string } }[]) =>
    payload?.[0]?.payload?.hour?.replace("T", " ") ?? "";

  return (
    <div>
      <ChartLegend
        items={[
          { label: "Weighted average", color: CHART.series1 },
          { label: "Worst stop", color: CHART.series2 },
        ]}
      />
      <ResponsiveContainer width="100%" height={236}>
        <LineChart
          data={chartData}
          syncId="delay-load"
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        >
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="label" hide />
          <YAxis {...axisProps} unit="m" width={AXIS_WIDTH} />
          <Tooltip
            labelFormatter={tooltipLabel}
            formatter={(value, name) => [`${Number(value).toFixed(1)} min`, name]}
            contentStyle={CHART_TOOLTIP_STYLE}
            cursor={{ stroke: CHART.axis, strokeWidth: 1 }}
          />
          <Line
            type="monotone"
            dataKey="avgDelay"
            stroke={CHART.series1}
            strokeWidth={2}
            dot={false}
            activeDot={activeDot}
            name="Weighted average"
          />
          <Line
            type="monotone"
            dataKey="maxDelay"
            stroke={CHART.series2}
            strokeWidth={2}
            dot={false}
            activeDot={activeDot}
            name="Worst stop"
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-3 text-[12px] font-medium text-muted">Board observations per hour</div>
      <ResponsiveContainer width="100%" height={76}>
        <BarChart
          data={chartData}
          syncId="delay-load"
          margin={{ top: 4, right: 8, left: AXIS_WIDTH, bottom: 0 }}
        >
          <XAxis dataKey="label" {...axisProps} fontSize={11} minTickGap={16} />
          <YAxis hide />
          <Tooltip
            labelFormatter={tooltipLabel}
            formatter={(value) => [Number(value).toLocaleString(), "Observations"]}
            contentStyle={CHART_TOOLTIP_STYLE}
            cursor={{ fill: "rgb(18 24 20 / 0.04)" }}
          />
          <Bar
            dataKey="events"
            name="Observations"
            fill={CHART.volume}
            radius={[3, 3, 0, 0]}
            maxBarSize={24}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
