import { useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
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
import { formatPct } from "../utils/format";
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
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)]">
      <div className="border-b border-[var(--rail-border)] px-4 py-3">
        <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">{eyebrow}</p>
        <h2 className="text-lg font-semibold text-white">{title}</h2>
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
    (highest, point) => (!highest || point.p95LateMinutes > highest.p95LateMinutes ? point : highest),
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
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">Historical analysis</p>
            <h1 className="text-2xl font-semibold text-white">Delay history & trends</h1>
            <p className="mt-1 text-sm text-[var(--rail-muted)]">
              Explore retained Irish Rail board observations by network or station.
            </p>
          </div>
          <div className="text-xs text-[var(--rail-muted)]">
            Updates every 5 minutes · On time means within 5 minutes
          </div>
        </div>

        <section className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]" htmlFor="history-range">
              Range
            </label>
            <select
              id="history-range"
              value={range}
              onChange={(event) => changeRange(event.target.value as RangeId)}
              className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-sm text-white"
            >
              {ranges.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]" htmlFor="history-bucket">
              Detail
            </label>
            <select
              id="history-bucket"
              value={bucket}
              onChange={(event) => setBucket(event.target.value as Bucket)}
              className="rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-sm text-white"
            >
              <option value="hour">Hourly</option>
              <option value="day">Daily</option>
              <option value="week">Weekly</option>
            </select>
          </div>
          <div className="min-w-56 flex-1">
            <label className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]" htmlFor="history-station">
              Scope
            </label>
            <select
              id="history-station"
              value={stationCode}
              onChange={(event) => setStationCode(event.target.value)}
              className="w-full rounded border border-[var(--rail-border)] bg-[var(--rail-bg)] px-3 py-2 text-sm text-white"
            >
              <option value="">All-Ireland network</option>
              {(stationData?.stations ?? []).map((station) => (
                <option key={station.stationCode} value={station.stationCode}>{station.stationDesc}</option>
              ))}
            </select>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">Weighted average delay</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-yellow)]">+{avgDelay.toFixed(1)}m</div>
          </div>
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">On-time performance</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-green)]">{formatPct(onTime)}</div>
          </div>
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">Highest p95 delay</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-orange)]">{peak ? `+${peak.p95LateMinutes.toFixed(1)}m` : "-"}</div>
          </div>
        </section>

        {fetching && chartData.length === 0 ? (
          <div className="py-16 text-center text-[var(--rail-muted)]">Loading history…</div>
        ) : chartData.length === 0 ? (
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] py-16 text-center text-[var(--rail-muted)]">
            No delay observations are available for this selection.
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-2">
            <ChartFrame eyebrow="Delay trend" title="Average delay and disruption spikes">
              <ResponsiveContainer width="100%" height={340}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} minTickGap={32} />
                  <YAxis yAxisId="delay" stroke="#94a3b8" fontSize={12} tickLine={false} unit="m" />
                  <YAxis yAxisId="events" orientation="right" stroke="#64748b" fontSize={12} tickLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "8px" }} />
                  <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: 12 }} />
                  <Bar yAxisId="events" dataKey="eventCount" name="Board observations" fill="#334155" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="delay" type="monotone" dataKey="avgLateMinutes" name="Average delay" stroke="#22c55e" strokeWidth={2} dot={false} />
                  <Line yAxisId="delay" type="monotone" dataKey="p95LateMinutes" name="p95 delay" stroke="#f97316" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartFrame>

            <ChartFrame eyebrow="Reliability" title="On-time performance over time">
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 8, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} minTickGap={32} />
                  <YAxis domain={[0, 100]} stroke="#94a3b8" fontSize={12} tickLine={false} unit="%" />
                  <Tooltip contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "8px" }} />
                  <Line type="monotone" dataKey="onTimePct" name="Within 5 minutes" stroke="#22c55e" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartFrame>
          </div>
        )}
      </div>
    </div>
  );
}
