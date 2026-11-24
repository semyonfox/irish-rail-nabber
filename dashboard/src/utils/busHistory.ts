export interface BusRoute {
  feedVersionId: number;
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  isActive: boolean;
}
export interface BusHistoryPoint {
  bucket: string;
  avgDelaySeconds: number;
  maxDelaySeconds: number;
  p95DelaySeconds: number;
  onTimePct: number;
  earlyCount: number;
  lateCount: number;
  sampleCount: number;
  lastUpdated: string;
}
export interface BusRoutesData {
  busRoutes: BusRoute[];
}
export interface BusHistoryData {
  busDelayHistory: BusHistoryPoint[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function isBusRoutesData(value: unknown): value is BusRoutesData {
  return (
    record(value) &&
    Array.isArray(value.busRoutes) &&
    value.busRoutes.every(
      (r: unknown) =>
        record(r) &&
        Number.isSafeInteger(r.feedVersionId) &&
        typeof r.routeId === "string" &&
        nullableString(r.routeShortName) &&
        nullableString(r.routeLongName) &&
        nullableString(r.operatorName) &&
        typeof r.isActive === "boolean",
    )
  );
}
export function isBusHistoryData(value: unknown): value is BusHistoryData {
  return (
    record(value) &&
    Array.isArray(value.busDelayHistory) &&
    value.busDelayHistory.every(
      (p: unknown) =>
        record(p) &&
        typeof p.bucket === "string" &&
        Number.isFinite(Date.parse(p.bucket)) &&
        typeof p.lastUpdated === "string" &&
        Number.isFinite(Date.parse(p.lastUpdated)) &&
        finite(p.avgDelaySeconds) &&
        finite(p.maxDelaySeconds) &&
        finite(p.p95DelaySeconds) &&
        finite(p.onTimePct) &&
        p.onTimePct >= 0 &&
        p.onTimePct <= 100 &&
        finite(p.sampleCount) &&
        p.sampleCount > 0 &&
        finite(p.earlyCount) &&
        p.earlyCount >= 0 &&
        finite(p.lateCount) &&
        p.lateCount >= 0,
    )
  );
}
export function summarizeBusHistory(points: BusHistoryPoint[]) {
  const sampleCount = points.reduce((sum, p) => sum + p.sampleCount, 0);
  return {
    sampleCount,
    avgDelaySeconds: sampleCount
      ? points.reduce((sum, p) => sum + p.avgDelaySeconds * p.sampleCount, 0) / sampleCount
      : null,
    onTimePct: sampleCount
      ? points.reduce((sum, p) => sum + p.onTimePct * p.sampleCount, 0) / sampleCount
      : null,
    maxDelaySeconds: points.length ? Math.max(...points.map((p) => p.maxDelaySeconds)) : null,
  };
}
export function busRoutePath(route: Pick<BusRoute, "feedVersionId" | "routeId">) {
  return `/buses/routes/${route.feedVersionId}/${encodeURIComponent(route.routeId)}`;
}

export function mergeBusHistory(
  current: BusHistoryData | undefined,
  incoming: BusHistoryData,
  hours: number,
  now = Date.now(),
): BusHistoryData {
  const points = new Map((current?.busDelayHistory ?? []).map((point) => [point.bucket, point]));
  for (const point of incoming.busDelayHistory) points.set(point.bucket, point);
  const cutoff = Math.floor((now - hours * 3_600_000) / 3_600_000) * 3_600_000;
  return {
    busDelayHistory: [...points.values()]
      .filter((point) => hours === 0 || Date.parse(point.bucket) >= cutoff)
      .sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket)),
  };
}

export interface BusStopDelay {
  tripId: string | null;
  tripInstanceKey: string;
  stopId: string | null;
  stopName: string | null;
  stopSequence: number | null;
  headsign: string | null;
  delaySeconds: number | null;
  expectedTime: string | null;
  scheduleRelationship: string | null;
  lastUpdated: string;
}
function isStopDelay(value: unknown): value is BusStopDelay {
  return (
    record(value) &&
    typeof value.tripInstanceKey === "string" &&
    nullableString(value.tripId) &&
    nullableString(value.stopId) &&
    nullableString(value.stopName) &&
    (value.stopSequence === null || Number.isSafeInteger(value.stopSequence)) &&
    nullableString(value.headsign) &&
    (value.delaySeconds === null || finite(value.delaySeconds)) &&
    (value.expectedTime === null ||
      (typeof value.expectedTime === "string" &&
        Number.isFinite(Date.parse(value.expectedTime)))) &&
    nullableString(value.scheduleRelationship) &&
    typeof value.lastUpdated === "string" &&
    Number.isFinite(Date.parse(value.lastUpdated))
  );
}
export function isBusRouteStopData(
  value: unknown,
): value is { busRouteStopDelays: BusStopDelay[] } {
  return (
    record(value) &&
    Array.isArray(value.busRouteStopDelays) &&
    value.busRouteStopDelays.every(isStopDelay)
  );
}
export interface BusJourney {
  feedVersionId: number;
  tripInstanceKey: string;
  tripId: string | null;
  routeId: string | null;
  headsign: string | null;
  firstObserved: string;
  lastObserved: string;
  stopCount: number;
}
export interface BusJourneysData {
  busJourneys: BusJourney[];
}
export function isBusJourneysData(value: unknown): value is BusJourneysData {
  return (
    record(value) &&
    Array.isArray(value.busJourneys) &&
    value.busJourneys.every(
      (j: unknown) =>
        record(j) &&
        Number.isSafeInteger(j.feedVersionId) &&
        typeof j.tripInstanceKey === "string" &&
        nullableString(j.tripId) &&
        nullableString(j.routeId) &&
        nullableString(j.headsign) &&
        typeof j.firstObserved === "string" &&
        Number.isFinite(Date.parse(j.firstObserved)) &&
        typeof j.lastObserved === "string" &&
        Number.isFinite(Date.parse(j.lastObserved)) &&
        finite(j.stopCount),
    )
  );
}
export function isBusJourneyData(
  value: unknown,
): value is BusJourneysData & { busJourneyStops: BusStopDelay[] } {
  return (
    isBusJourneysData(value) &&
    record(value) &&
    Array.isArray(value.busJourneyStops) &&
    value.busJourneyStops.every(isStopDelay)
  );
}
export interface BusStopStats {
  feedVersionId: number;
  stopId: string;
  stopName: string;
  avgDelaySeconds: number;
  p95DelaySeconds: number;
  maxDelaySeconds: number;
  onTimePct: number;
  sampleCount: number;
}
export function isBusStopStatsData(value: unknown): value is { busStopStats: BusStopStats[] } {
  return (
    record(value) &&
    Array.isArray(value.busStopStats) &&
    value.busStopStats.every(
      (s: unknown) =>
        record(s) &&
        Number.isSafeInteger(s.feedVersionId) &&
        typeof s.stopId === "string" &&
        typeof s.stopName === "string" &&
        finite(s.avgDelaySeconds) &&
        finite(s.p95DelaySeconds) &&
        finite(s.maxDelaySeconds) &&
        finite(s.onTimePct) &&
        s.onTimePct >= 0 &&
        s.onTimePct <= 100 &&
        finite(s.sampleCount) &&
        s.sampleCount > 0,
    )
  );
}
export const busStopPath = (version: number, id: string) =>
  `/buses/stops/${version}/${encodeURIComponent(id)}`;
export const busJourneyPath = (version: number, key: string) =>
  `/buses/journeys/${version}/${encodeURIComponent(key)}`;
