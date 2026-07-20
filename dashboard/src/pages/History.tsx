import { useMemo, useState } from "react";
import HistoryCharts from "../components/HistoryCharts";
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
            <p className="text-xs font-semibold uppercase text-[var(--rail-green)]">
              Historical analysis
            </p>
            <h1 className="text-2xl font-semibold text-white">Delay history & trends</h1>
            <p className="mt-1 text-sm text-[var(--rail-muted)]">
              Explore retained Irish Rail board observations by network or station.
            </p>
          </div>
        </div>

        <section className="term-panel flex flex-wrap items-end gap-4 p-3">
          <div>
            <label
              className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]"
              htmlFor="history-range"
            >
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
            <label
              className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]"
              htmlFor="history-bucket"
            >
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
            <label
              className="mb-2 block text-xs font-semibold uppercase text-[var(--rail-muted)]"
              htmlFor="history-station"
            >
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

        <section className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">Weighted average delay</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-yellow)]">
              +{avgDelay.toFixed(1)}m
            </div>
          </div>
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">On-time performance</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-green)]">
              {formatPct(onTime)}
            </div>
          </div>
          <div className="rounded-lg border border-[var(--rail-border)] bg-[var(--rail-surface)] p-4">
            <div className="text-xs uppercase text-[var(--rail-muted)]">Highest p95 delay</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--rail-orange)]">
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
          <HistoryCharts data={chartData} />
        )}
      </div>
    </div>
  );
}
