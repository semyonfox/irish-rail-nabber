import { useMemo, useState } from "react";
import HistoryCharts from "../components/HistoryCharts";
import RequestError from "../components/RequestError";
import { Card, Empty, Kpi, PageHeader, Segmented } from "../components/ui";
import { STATIONS } from "../graphql/queries";
import { delayTone, formatPct } from "../utils/format";
import { type StoredDelayPoint, useHistorySync } from "../utils/useHistorySync";
import { usePollingQuery } from "../utils/usePollingQuery";

type RangeId = "day" | "week" | "month" | "all";
type Bucket = "hour" | "day" | "week";

interface StationData {
  stations: { stationCode: string; stationDesc: string }[];
}

const ranges: { id: RangeId; label: string; hours: number; bucket: Bucket }[] = [
  { id: "day", label: "24 hours", hours: 24, bucket: "hour" },
  { id: "week", label: "7 days", hours: 168, bucket: "hour" },
  { id: "month", label: "30 days", hours: 720, bucket: "day" },
  { id: "all", label: "All time", hours: 0, bucket: "week" },
];

const buckets: { value: Bucket; label: string }[] = [
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
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

function aggregateHistory(points: StoredDelayPoint[], hours: number, bucket: Bucket) {
  const cutoff = hours === 0 ? 0 : Date.now() - hours * 60 * 60 * 1000;
  const groups = new Map<string, StoredDelayPoint[]>();

  for (const point of points) {
    const date = new Date(point.bucket);
    if (date.getTime() < cutoff) continue;
    if (bucket === "day") date.setUTCHours(0, 0, 0, 0);
    if (bucket === "week") {
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    }
    const key = bucket === "hour" ? point.bucket : date.toISOString().slice(0, 19);
    groups.set(key, [...(groups.get(key) ?? []), point]);
  }

  return [...groups.entries()].map(([groupBucket, values]) => {
    const events = values.reduce((sum, value) => sum + value.eventCount, 0);
    const weighted = (field: "avgLateMinutes" | "p95LateMinutes" | "onTimePct") =>
      events === 0
        ? 0
        : values.reduce((sum, value) => sum + value[field] * value.eventCount, 0) / events;
    return {
      bucket: groupBucket,
      label: bucketLabel(groupBucket, bucket),
      avgLateMinutes: weighted("avgLateMinutes"),
      p95LateMinutes: weighted("p95LateMinutes"),
      maxLateMinutes: Math.max(...values.map((value) => value.maxLateMinutes)),
      onTimePct: weighted("onTimePct"),
      eventCount: events,
    };
  });
}

function kpiTone(minutes: number) {
  const tone = delayTone(minutes);
  return tone === "neutral" || tone === "muted" ? undefined : tone;
}

export default function History() {
  const [range, setRange] = useState<RangeId>("week");
  const [bucket, setBucket] = useState<Bucket>("hour");
  const [stationCode, setStationCode] = useState("");
  const selectedRange = ranges.find((item) => item.id === range) ?? ranges[1];
  const selectedStation = stationCode || undefined;

  const { points, fetching, error, retry } = useHistorySync(selectedStation);
  const [{ data: stationData }] = usePollingQuery<StationData>({ query: STATIONS });

  const chartData = useMemo(
    () => aggregateHistory(points, selectedRange.hours, bucket),
    [bucket, points, selectedRange.hours],
  );
  const totalEvents = chartData.reduce((total, point) => total + point.eventCount, 0);
  const avgDelay =
    totalEvents === 0
      ? 0
      : chartData.reduce((total, point) => total + point.avgLateMinutes * point.eventCount, 0) /
        totalEvents;
  const onTime =
    totalEvents === 0
      ? 0
      : chartData.reduce((total, point) => total + point.onTimePct * point.eventCount, 0) /
        totalEvents;
  const peak = chartData.reduce<(typeof chartData)[number] | undefined>(
    (highest, point) =>
      !highest || point.p95LateMinutes > highest.p95LateMinutes ? point : highest,
    undefined,
  );
  const scopeName =
    stationData?.stations.find((station) => station.stationCode === stationCode)?.stationDesc ??
    "the whole network";

  function changeRange(next: RangeId) {
    const nextRange = ranges.find((item) => item.id === next) ?? ranges[1];
    setRange(next);
    setBucket(nextRange.bucket);
  }

  return (
    <div className="page">
      <div className="page-inner">
        <PageHeader
          eyebrow="History"
          title={
            <>
              Delay <em>history</em> and trends
            </>
          }
          description="Stored Irish Rail board observations, grouped by hour, day or week. Look at the whole network or a single station."
        />

        <Card index={1}>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-4 p-4 sm:px-5">
            <div className="min-w-0">
              <span className="field-label">Range</span>
              <Segmented
                label="Range"
                options={ranges.map((item) => ({ value: item.id, label: item.label }))}
                value={range}
                onChange={changeRange}
              />
            </div>
            <div className="min-w-0">
              <span className="field-label">Detail</span>
              <Segmented label="Detail" options={buckets} value={bucket} onChange={setBucket} />
            </div>
            <div className="w-full min-w-0 sm:min-w-56 sm:flex-1">
              <label className="field-label" htmlFor="history-station">
                Scope
              </label>
              <select
                id="history-station"
                value={stationCode}
                onChange={(event) => setStationCode(event.target.value)}
                className="control w-full"
              >
                <option value="">All-Ireland network</option>
                {(stationData?.stations ?? []).map((station) => (
                  <option key={station.stationCode} value={station.stationCode}>
                    {station.stationDesc}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </Card>

        {error && points.length === 0 ? (
          <RequestError
            error={error}
            title="History unavailable"
            onRetry={() => retry({ requestPolicy: "network-only" })}
          />
        ) : (
          <>
            <section className="grid gap-3 md:grid-cols-3">
              <Kpi
                index={2}
                label="Average delay"
                value={`+${avgDelay.toFixed(1)}m`}
                detail={`Weighted by stops, ${selectedRange.label.toLowerCase()}, ${scopeName}`}
                tone={kpiTone(avgDelay)}
              />
              <Kpi
                index={3}
                label="On-time performance"
                value={formatPct(onTime)}
                detail={`${totalEvents.toLocaleString()} stops within five minutes of schedule`}
                tone="ok"
              />
              <Kpi
                index={4}
                label="Worst 95th percentile"
                value={peak ? `+${peak.p95LateMinutes.toFixed(1)}m` : "-"}
                detail={peak ? peak.label : "No observations yet"}
                tone={peak ? kpiTone(peak.p95LateMinutes) : undefined}
              />
            </section>

            {fetching && chartData.length === 0 ? (
              <Card>
                <Empty className="!min-h-72">Loading history…</Empty>
              </Card>
            ) : chartData.length === 0 ? (
              <Card>
                <Empty className="!min-h-72">
                  No delay observations are available for this selection.
                </Empty>
              </Card>
            ) : (
              <HistoryCharts data={chartData} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
