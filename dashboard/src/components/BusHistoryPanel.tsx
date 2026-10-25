import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useAuth } from "../auth/useAuth";
import { BUS_DELAY_HISTORY } from "../graphql/queries";
import {
  busHistoryMaxHours,
  busHistoryRanges,
  summarizeBusHistory,
  type BusHistoryPoint,
} from "../utils/busHistory";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";
import { usePollingQuery } from "../utils/usePollingQuery";
import RequestError from "./RequestError";
import { Card, ChartLegend, Empty, Kpi, Segmented } from "./ui";

const HOUR_MS = 3_600_000;

const dateFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function minutes(seconds: number | null) {
  return seconds === null ? "—" : `${(seconds / 60).toFixed(1)}m`;
}

export default function BusHistoryPanel({
  routeId,
  stopId,
  feedVersionId,
}: {
  routeId?: string;
  stopId?: string;
  feedVersionId?: number;
}) {
  const { user } = useAuth();
  const maxHours = busHistoryMaxHours(user?.role);
  const [selectedHours, setHours] = useState(24);
  const hours = Math.min(selectedHours, maxHours);
  const [{ data, fetching, error }, retry] = usePollingQuery<{
    busDelayHistory: BusHistoryPoint[];
  }>({
    query: BUS_DELAY_HISTORY,
    variables: { routeId, stopId, feedVersionId, hours },
    pollInterval: 60_000,
  });
  const points = data?.busDelayHistory ?? [];
  const summary = summarizeBusHistory(points);

  // a gap marker keeps the line from bridging hours with no reported data
  const chartData: { time: number; average: number | null; p95: number | null }[] = [];
  for (const point of points) {
    const time = Date.parse(point.bucket);
    const previous = chartData.at(-1);
    if (previous && time - previous.time > HOUR_MS) {
      chartData.push({ time: previous.time + HOUR_MS, average: null, p95: null });
    }
    chartData.push({
      time,
      average: point.avgDelaySeconds / 60,
      p95: point.p95DelaySeconds / 60,
    });
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Bus history window"
          options={busHistoryRanges(maxHours)}
          value={hours}
          onChange={setHours}
        />
        <span className="text-xs text-muted" role="status">
          {fetching ? "Updating history…" : ""}
        </span>
      </div>
      {error && (
        <RequestError
          error={error}
          onRetry={() => retry({ requestPolicy: "network-only" })}
          title={
            data ? "History refresh failed. Showing last loaded data." : "Bus history unavailable"
          }
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Average predicted delay" value={minutes(summary.avgDelaySeconds)} index={0} />
        <Kpi
          label="Within target"
          value={summary.onTimePct === null ? "—" : `${summary.onTimePct.toFixed(1)}%`}
          detail="1 minute early to 5 minutes late"
          index={1}
        />
        <Kpi label="Largest predicted delay" value={minutes(summary.maxDelaySeconds)} index={2} />
        <Kpi
          label="Stop observations"
          value={summary.sampleCount.toLocaleString()}
          detail="Each prediction counted once per poll"
          index={3}
        />
      </div>
      <Card
        title="Delay history"
        description="Reported predictions weighted by observations. These are not confirmed arrival times. Gaps mean no data was reported."
      >
        {!data && fetching ? (
          <Empty>Loading bus history…</Empty>
        ) : points.length === 0 ? (
          <Empty>No predictions were recorded for this selection.</Empty>
        ) : (
          <div className="card-body">
            <ChartLegend
              items={[
                { label: "Average delay", color: CHART.series1 },
                { label: "P95 delay", color: CHART.series2 },
              ]}
            />
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis
                  dataKey="time"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  stroke={CHART.axis}
                  fontSize={11}
                  tickFormatter={(value: number) => dateFormat.format(value)}
                  minTickGap={70}
                />
                <YAxis unit="m" stroke={CHART.axis} fontSize={12} />
                <Tooltip
                  contentStyle={CHART_TOOLTIP_STYLE}
                  labelFormatter={(value) => dateFormat.format(Number(value))}
                  formatter={(value) => `${Number(value).toFixed(1)} min`}
                />
                <Line
                  dataKey="average"
                  name="Average"
                  stroke={CHART.series1}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="p95"
                  name="P95"
                  stroke={CHART.series2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
      {points.length > 0 && (
        <Card title="History by hour" description="Newest first">
          <div className="max-h-96 overflow-auto">
            <table className="data-table min-w-[660px]">
              <thead>
                <tr>
                  <th>Hour</th>
                  <th className="num">Average</th>
                  <th className="num">P95</th>
                  <th className="num">Maximum</th>
                  <th className="num">Within target</th>
                  <th className="num">Early</th>
                  <th className="num">Late</th>
                  <th className="num">Observations</th>
                </tr>
              </thead>
              <tbody>
                {points.toReversed().map((point) => (
                  <tr key={point.bucket}>
                    <td className="whitespace-nowrap">
                      {dateFormat.format(Date.parse(point.bucket))}
                    </td>
                    <td className="num">{minutes(point.avgDelaySeconds)}</td>
                    <td className="num">{minutes(point.p95DelaySeconds)}</td>
                    <td className="num">{minutes(point.maxDelaySeconds)}</td>
                    <td className="num">{point.onTimePct.toFixed(1)}%</td>
                    <td className="num">{point.earlyCount.toLocaleString()}</td>
                    <td className="num">{point.lateCount.toLocaleString()}</td>
                    <td className="num">{point.sampleCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
