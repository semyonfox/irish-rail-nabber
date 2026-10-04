import { useMemo, useState } from "react";
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
  isBusHistoryData,
  summarizeBusHistory,
  mergeBusHistory,
  type BusHistoryData,
} from "../utils/busHistory";
import { useCachedBusQuery } from "../utils/useCachedBusQuery";
import { CHART, CHART_TOOLTIP_STYLE } from "../utils/format";
import RequestError from "./RequestError";
import { Card, ChartLegend, Empty, Kpi, Segmented } from "./ui";

const publicRanges = [
  { value: 6, label: "6 hours" },
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
];
const paidRanges = [
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
  { value: 8760, label: "1 year" },
  { value: 0, label: "All time" },
];
const dateFormat = new Intl.DateTimeFormat("en-IE", {
  timeZone: "Europe/Dublin",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

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
  const paid = !!user && ["coffee", "pro", "admin"].includes(user.role);
  const [selectedHours, setHours] = useState(24);
  const hours = paid ? selectedHours : Math.min(selectedHours || 72, 72);
  const incremental = useMemo(
    () => ({
      variables: (current: BusHistoryData | undefined) => ({
        since: current?.busDelayHistory.at(-1)?.bucket,
      }),
      merge: (current: BusHistoryData | undefined, incoming: BusHistoryData) =>
        mergeBusHistory(current, incoming, hours),
    }),
    [hours],
  );
  const { data, fetching, error, cached, savedAt, retry } = useCachedBusQuery({
    query: BUS_DELAY_HISTORY,
    variables: { routeId, stopId, feedVersionId, hours },
    incremental,
    validate: isBusHistoryData,
    cacheScope: `${user?.id ?? "anonymous"}:${user?.role ?? "free"}`,
    pollInterval: 60_000,
  });
  const points = data?.busDelayHistory ?? [];
  const summary = summarizeBusHistory(points);
  const bucketMs = (hours === 0 ? 168 : hours > 720 ? 24 : 1) * 60 * 60 * 1000;
  const chartData: {
    time: number;
    average: number | null;
    maximum: number | null;
    p95: number | null;
  }[] = [];
  for (const point of points) {
    const time = Date.parse(point.bucket);
    const previous = chartData.at(-1);
    if (previous && time - previous.time > bucketMs) {
      chartData.push({ time: previous.time + bucketMs, average: null, maximum: null, p95: null });
    }
    chartData.push({
      time,
      average: point.avgDelaySeconds / 60,
      p95: point.p95DelaySeconds / 60,
      maximum: point.maxDelaySeconds / 60,
    });
  }
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Bus history window"
          options={paid ? [...publicRanges, ...paidRanges] : publicRanges}
          value={hours}
          onChange={setHours}
        />
        <span className="text-xs text-muted" role="status">
          {cached ? "Saved on this device" : fetching ? "Updating history…" : "History checked"}
          {savedAt ? ` · checked ${dateFormat.format(savedAt)}` : ""}
        </span>
      </div>
      {error && (
        <RequestError
          error={error}
          onRetry={retry}
          title={data ? "Refresh failed. Showing saved history." : "Bus history unavailable"}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label="Average predicted delay"
          value={
            summary.avgDelaySeconds === null ? "—" : `${(summary.avgDelaySeconds / 60).toFixed(1)}m`
          }
        />
        <Kpi
          label="Within target"
          value={summary.onTimePct === null ? "—" : `${summary.onTimePct.toFixed(1)}%`}
          detail="1 minute early to 5 minutes late"
        />
        <Kpi
          label="Largest predicted delay"
          value={
            summary.maxDelaySeconds === null ? "—" : `${(summary.maxDelaySeconds / 60).toFixed(1)}m`
          }
        />
        <Kpi
          label="Stop observations"
          value={summary.sampleCount.toLocaleString()}
          detail="Includes repeated predictions at each poll"
        />
      </div>
      <Card
        title="Delay history"
        description="Reported predictions, weighted by observations. These are not verified arrival times. Missing periods have no reported data."
      >
        {!data && fetching ? (
          <Empty>Loading bus history…</Empty>
        ) : points.length === 0 ? (
          <Empty>
            History starts with collection. No predictions were recorded for this selection.
          </Empty>
        ) : (
          <div className="card-body">
            <ChartLegend
              items={[
                { label: "Average delay", color: CHART.series1 },
                { label: "Maximum delay", color: CHART.series2 },
                { label: "P95 delay", color: "#8b5cf6" },
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
                  stroke="#8b5cf6"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  dataKey="maximum"
                  name="Maximum"
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
        <Card
          title="History by period"
          description={
            hours === 0
              ? "Weekly summaries, newest first"
              : hours > 720
                ? "Daily summaries, newest first"
                : "Hourly summaries, newest first"
          }
        >
          <div className="overflow-auto max-h-96">
            <table className="data-table min-w-[660px]">
              <thead>
                <tr>
                  <th>Period</th>
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
                {points
                  .slice()
                  .reverse()
                  .map((p) => (
                    <tr key={p.bucket}>
                      <td>{dateFormat.format(Date.parse(p.bucket))}</td>
                      <td className="num">{(p.avgDelaySeconds / 60).toFixed(1)}m</td>
                      <td className="num">{(p.p95DelaySeconds / 60).toFixed(1)}m</td>
                      <td className="num">{(p.maxDelaySeconds / 60).toFixed(1)}m</td>
                      <td className="num">{p.onTimePct.toFixed(1)}%</td>
                      <td className="num">{p.earlyCount.toLocaleString()}</td>
                      <td className="num">{p.lateCount.toLocaleString()}</td>
                      <td className="num">{p.sampleCount.toLocaleString()}</td>
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
