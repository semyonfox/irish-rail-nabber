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

// matches the API's history window, paid plans get a week
export function busHistoryMaxHours(role: string | undefined) {
  return role === "coffee" || role === "pro" || role === "admin" ? 168 : 72;
}

export function busHistoryRanges(maxHours: number) {
  return [
    { value: 6, label: "6 hours" },
    { value: 24, label: "24 hours" },
    { value: 72, label: "3 days" },
    { value: 168, label: "7 days" },
  ].filter((range) => range.value <= maxHours);
}

// weights each bucket by its observations so quiet hours don't skew the totals
export function summarizeBusHistory(points: BusHistoryPoint[]) {
  const sampleCount = points.reduce((sum, point) => sum + point.sampleCount, 0);
  if (sampleCount === 0) {
    return { sampleCount, avgDelaySeconds: null, onTimePct: null, maxDelaySeconds: null };
  }
  return {
    sampleCount,
    avgDelaySeconds:
      points.reduce((sum, point) => sum + point.avgDelaySeconds * point.sampleCount, 0) /
      sampleCount,
    onTimePct:
      points.reduce((sum, point) => sum + point.onTimePct * point.sampleCount, 0) / sampleCount,
    maxDelaySeconds: Math.max(...points.map((point) => point.maxDelaySeconds)),
  };
}

export function busRoutePath(feedVersionId: number, routeId: string) {
  return `/buses/routes/${feedVersionId}/${encodeURIComponent(routeId)}`;
}

export function busStopPath(feedVersionId: number, stopId: string) {
  return `/buses/stops/${feedVersionId}/${encodeURIComponent(stopId)}`;
}

// the route is part of the link because the archive is only searchable by route
export function busJourneyPath(feedVersionId: number, routeId: string, tripInstanceKey: string) {
  return `${busRoutePath(feedVersionId, routeId)}/journeys/${encodeURIComponent(tripInstanceKey)}`;
}
