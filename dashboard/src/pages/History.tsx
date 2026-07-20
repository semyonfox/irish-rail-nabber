import { useMemo, useState } from "react";
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
import RequestError from "../components/RequestError";
import { DELAY_HISTORY, STATIONS } from "../graphql/queries";
import { CHART, CHART_TOOLTIP_STYLE, delayColor, formatPct } from "../utils/format";
import { usePollingQuery } from "../utils/usePollingQuery";

type RangeId = "day" | "week" | "month" | "all";
type Bucket = "hour" | "day" | "week";

interface DelayPoint {
  bucket: string;
  avgLateMinutes: number;
  p95LateMinutes: number;
  maxLateMinutes: number;
  onTimePct: number;
  eventCount: number;
}

interface DelayHistoryData {
  delayHistory: DelayPoint[];
}

interface StationData {
  stations: { stationCode: string; stationDesc: string }[];
}

const ranges: { id: RangeId; label: string; hours: number; bucket: Bucket }[] = [
  { id: "day", label: "24 hours", hours: 24, bucket: "hour" },
  { id: "week", label: "7 days", hours: 168, bucket: "hour" },
  { id: "month", label: "30 days", hours: 720, bucket: "day" },
  { id: "all", label: "All history", hours: 0, bucket: "week" },
];

function bucketLabel(value: string, bucket: Bucket) {
  const date = new Date(value);
  if (bucket === "hour") {
    return new Intl.DateTimeFormat("en-IE", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  if (bucket === "week") {
    return `Week of ${new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short" }).format(date)}`;
  }
  return new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short" }).format(date);
}

function ChartFrame({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <section className="term-panel overflow-hidden">
      <div className="term-panel-head">
        {title}
        <small>{detail}</small>
      </div>
      <div className="px-2 py-4">{children}</div>
    </section>
  );
}

export default function History() {
  const [range, setRange] = useState<RangeId>("week");
  const [bucket, setBucket] = useState<Bucket>("hour");
  const [stationCode, setStationCode] = useState("");
  const selectedRange = ranges.find((item) => item.id === range) ?? ranges[1];
  const selectedStation = stationCode || undefined;

  const [{ data, fetching, error }, retry] = usePollingQuery<DelayHistoryData>({
    query: DELAY_HISTORY,
    variables: { stationCode: selectedStation, hours: selectedRange.hours, bucket },
    pollInterval: 300000,
  });
  const [{ data: stationData }] = usePollingQuery<StationData>({ query: STATIONS });

  const chartData = useMemo(
    () =>
      (data?.delayHistory ?? []).map((point) => ({
        ...point,
        label: bucketLabel(point.bucket, bucket),
      })),
    [bucket, data?.delayHistory],
  );
  const avgDelay =
    chartData.length === 0
      ? 0
      : chartData.reduce((total, point) => total + point.avgLateMinutes * point.eventCount, 0) /
        chartData.reduce((total, point) => total + point.eventCount, 0);
  const onTime =
    chartData.length === 0
      ? 0
      : chartData.reduce((total, point) => total + point.onTimePct * point.eventCount, 0) /
        chartData.reduce((total, point) => total + point.eventCount, 0);
  const peak = chartData.reduce<DelayPoint | undefined>(
    (highest, point) =>
      !highest || point.p95LateMinutes > highest.p95LateMinutes ? point : highest,
    undefined,
  );

  function changeRange(next: RangeId) {
    const nextRange = ranges.find((item) => item.id === next) ?? ranges[1];
    setRange(next);
    setBucket(nextRange.bucket);
  }

  if (error && !data) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <RequestError
          error={error}
          title="History unavailable"
          onRetry={() => retry({ requestPolicy: "network-only" })}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-[0.1em] text-[var(--rail-text)]">
              Delay history &amp; trends
            </h1>
            <p className="mt-1 text-xs text-[var(--rail-muted)]">
              Retained board observations by network or station · updates every 5 minutes · on time
              means within 5 minutes
            </p>
          </div>
        </div>

        <section className="term-panel flex flex-wrap items-end gap-4 p-3">
          <div>
            <label className="term-label" htmlFor="history-range">
              Range
            </label>
            <select
              id="history-range"
              value={range}
              onChange={(event) => changeRange(event.target.value as RangeId)}
              className="term-control"
            >
              {ranges.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="term-label" htmlFor="history-bucket">
              Detail
            </label>
            <select
              id="history-bucket"
              value={bucket}
              onChange={(event) => setBucket(event.target.value as Bucket)}
              className="term-control"
            >
              <option value="hour">Hourly</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
            </select>
          </div>
          <div className="min-w-56 flex-1">
            <label className="term-label" htmlFor="history-station">
              Scope
            </label>
            <select
              id="history-station"
              value={stationCode}
              onChange={(event) => setStationCode(event.target.value)}
              className="term-control w-full"
            >
              <option value="">All-Ireland network</option>
              {(stationData?.stations ?? []).map((station) => (
                <option key={station.stationCode} value={station.stationCode}>
                  {station.stationDesc}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="grid gap-2 md:grid-cols-3">
          <div className="stat-tile">
            <div className="stat-tile-label">Weighted average delay</div>
            <div className="stat-tile-value" style={{ color: delayColor(avgDelay) }}>
              +{avgDelay.toFixed(1)}m
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">On-time performance</div>
            <div className="stat-tile-value">{formatPct(onTime)}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-tile-label">Highest p95 delay</div>
            <div
              className="stat-tile-value"
              style={{ color: delayColor(peak?.p95LateMinutes ?? null) }}
            >
              {peak ? `+${peak.p95LateMinutes.toFixed(1)}m` : "-"}
            </div>
          </div>
        </section>

        {fetching && chartData.length === 0 ? (
          <div className="py-16 text-center text-[var(--rail-muted)]">Loading history…</div>
        ) : chartData.length === 0 ? (
          <div className="term-panel py-16 text-center text-[var(--rail-muted)]">
            No delay observations are available for this selection.
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartFrame title="Delay trend" detail="Average delay and disruption spikes">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={chartData}
                  syncId="history-delay"
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                >
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis dataKey="label" hide />
                  <YAxis stroke={CHART.axis} fontSize={11} tickLine={false} unit="m" width={44} />
                  <Tooltip
                    formatter={(value, name) => [`${Number(value).toFixed(1)} min`, name]}
                    contentStyle={CHART_TOOLTIP_STYLE}
                  />
                  <Legend wrapperStyle={{ color: CHART.axis, fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="avgLateMinutes"
                    name="Average delay"
                    stroke={CHART.series1}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="p95LateMinutes"
                    name="p95 delay"
                    stroke={CHART.series2}
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <div className="px-2 pt-1 text-[9px] uppercase tracking-widest text-[var(--rail-muted)]">
                Board observations
              </div>
              <ResponsiveContainer width="100%" height={72}>
                <BarChart
                  data={chartData}
                  syncId="history-delay"
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                >
                  <XAxis
                    dataKey="label"
                    stroke={CHART.axis}
                    fontSize={10}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis hide />
                  <Tooltip
                    formatter={(value) => [Number(value).toLocaleString(), "Observations"]}
                    contentStyle={CHART_TOOLTIP_STYLE}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar
                    dataKey="eventCount"
                    name="Observations"
                    fill={CHART.volume}
                    radius={[2, 2, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame title="Reliability" detail="Share of stops within 5 minutes">
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={CHART.grid} vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke={CHART.axis}
                    fontSize={11}
                    tickLine={false}
                    minTickGap={32}
                  />
                  <YAxis
                    domain={[0, 100]}
                    stroke={CHART.axis}
                    fontSize={11}
                    tickLine={false}
                    unit="%"
                  />
                  <Tooltip
                    formatter={(value) => [`${Number(value).toFixed(1)}%`, "Within 5 minutes"]}
                    contentStyle={CHART_TOOLTIP_STYLE}
                  />
                  <Line
                    type="monotone"
                    dataKey="onTimePct"
                    name="Within 5 minutes"
                    stroke={CHART.series1}
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>
        )}
      </div>
    </div>
  );
}
