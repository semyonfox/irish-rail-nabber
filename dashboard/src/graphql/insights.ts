import { gql } from "urql";

export const SERVICE_ALERTS = gql`
  query ServiceAlerts($range: InsightsDates!, $mode: InsightsMode, $category: String, $page: Int) {
    serviceAlerts(range: $range, mode: $mode, category: $category, page: $page) {
      hasNextPage
      alerts {
        mode
        alertKey
        title
        category
        status
        startsAt
        endsAt
        firstSeen
        lastSeen
        revisions
      }
    }
  }
`;

export const SERVICE_ALERT = gql`
  query ServiceAlert($mode: InsightsMode!, $alertKey: String!) {
    serviceAlert(mode: $mode, alertKey: $alertKey) {
      description
      locationCodes
      corridorCodes
      impactEvents
      impactWindowEnd
      impactAvgLate
      baselineAvgLate
      preAvgLate
      preBaselineAvgLate
      routes
      stops
      agencyIds
    }
  }
`;

export const DELAY_STRETCHES = gql`
  query DelayStretches(
    $mode: InsightsMode!
    $range: InsightsDates!
    $hourBand: InsightsHours
    $minTrips: Int
  ) {
    delayStretches(mode: $mode, range: $range, hourBand: $hourBand, minTrips: $minTrips) {
      fromId
      toId
      fromName
      toName
      fromLat
      fromLon
      toLat
      toLon
      trips
      netDelayMinutes
      addedMinutes
      avgGainMinutes
      stddevMinutes
      medianGainLowerS
      medianGainUpperS
      outlierDriven
      overrunPct
      routes
    }
  }
`;

export const RAIL_DWELL_HOTSPOTS = gql`
  query RailDwellHotspots($range: InsightsDates!, $hourBand: InsightsHours, $minTrips: Int) {
    railDwellHotspots(range: $range, hourBand: $hourBand, minTrips: $minTrips) {
      stationCode
      stationName
      trips
      netDelayMinutes
      addedMinutes
      avgGainMinutes
      overrunPct
    }
  }
`;

export type InsightsMode = "RAIL" | "BUS";
export type InsightsRange = { from: string; to: string };

export const statusLabels = {
  ACTIVE: "Active",
  SCHEDULED: "Scheduled",
  BETWEEN_WINDOWS: "Between windows",
  ENDED: "Ended",
  WITHDRAWN_EARLY: "Withdrawn early",
};

export interface AlertSummary {
  mode: InsightsMode;
  alertKey: string;
  title: string;
  category: string;
  status: keyof typeof statusLabels;
  startsAt: string | null;
  endsAt: string | null;
  firstSeen: string;
  lastSeen: string;
  revisions: number;
}

interface AlertDetail {
  description: string;
  locationCodes: string[];
  corridorCodes: string[] | null;
  impactEvents: number | null;
  impactWindowEnd: string | null;
  impactAvgLate: number | null;
  baselineAvgLate: number | null;
  preAvgLate: number | null;
  preBaselineAvgLate: number | null;
  routes: string[];
  stops: string[];
  agencyIds: string[];
}

interface DelayRanking {
  trips: number;
  netDelayMinutes: number;
  addedMinutes: number;
  avgGainMinutes: number;
  overrunPct: number | null;
}

export interface DelayStretch extends DelayRanking {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  fromLat: number | null;
  fromLon: number | null;
  toLat: number | null;
  toLon: number | null;
  stddevMinutes: number;
  medianGainLowerS: number | null;
  medianGainUpperS: number | null;
  outlierDriven: boolean;
  routes: string[];
}

interface DwellHotspot extends DelayRanking {
  stationCode: string;
  stationName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isList<T>(value: unknown, isItem: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(isItem);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDate(value: unknown): value is string {
  return isString(value) && Number.isFinite(Date.parse(value));
}

function isAlert(value: unknown): value is AlertSummary {
  return (
    isRecord(value) &&
    (value.mode === "RAIL" || value.mode === "BUS") &&
    isString(value.alertKey) &&
    isString(value.title) &&
    isString(value.category) &&
    isString(value.status) &&
    Object.hasOwn(statusLabels, value.status) &&
    (value.startsAt === null || isDate(value.startsAt)) &&
    (value.endsAt === null || isDate(value.endsAt)) &&
    isDate(value.firstSeen) &&
    isDate(value.lastSeen) &&
    isNumber(value.revisions)
  );
}

export function readAlerts(data: unknown) {
  if (!isRecord(data) || !isRecord(data.serviceAlerts)) return undefined;
  const { alerts, hasNextPage } = data.serviceAlerts;
  if (isList(alerts, isAlert) && typeof hasNextPage === "boolean") return { alerts, hasNextPage };
}

function isAlertDetail(value: unknown): value is AlertDetail {
  return (
    isRecord(value) &&
    isString(value.description) &&
    isList(value.locationCodes, isString) &&
    (value.corridorCodes === null || isList(value.corridorCodes, isString)) &&
    (value.impactEvents === null || isNumber(value.impactEvents)) &&
    (value.impactWindowEnd === null || isDate(value.impactWindowEnd)) &&
    (value.impactAvgLate === null || isNumber(value.impactAvgLate)) &&
    (value.baselineAvgLate === null || isNumber(value.baselineAvgLate)) &&
    (value.preAvgLate === null || isNumber(value.preAvgLate)) &&
    (value.preBaselineAvgLate === null || isNumber(value.preBaselineAvgLate)) &&
    isList(value.routes, isString) &&
    isList(value.stops, isString) &&
    isList(value.agencyIds, isString)
  );
}

export function readAlertDetail(data: unknown) {
  if (isRecord(data) && (data.serviceAlert === null || isAlertDetail(data.serviceAlert))) {
    return data.serviceAlert;
  }
}

function hasRanking(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DelayRanking {
  return (
    isNumber(value.trips) &&
    isNumber(value.netDelayMinutes) &&
    isNumber(value.addedMinutes) &&
    isNumber(value.avgGainMinutes) &&
    (value.overrunPct === null || isNumber(value.overrunPct))
  );
}

function isStretch(value: unknown): value is DelayStretch {
  return (
    isRecord(value) &&
    hasRanking(value) &&
    isString(value.fromId) &&
    isString(value.toId) &&
    isString(value.fromName) &&
    isString(value.toName) &&
    (value.fromLat === null || isNumber(value.fromLat)) &&
    (value.fromLon === null || isNumber(value.fromLon)) &&
    (value.toLat === null || isNumber(value.toLat)) &&
    (value.toLon === null || isNumber(value.toLon)) &&
    isNumber(value.stddevMinutes) &&
    (value.medianGainLowerS === null || isNumber(value.medianGainLowerS)) &&
    (value.medianGainUpperS === null || isNumber(value.medianGainUpperS)) &&
    typeof value.outlierDriven === "boolean" &&
    isList(value.routes, isString)
  );
}

function isDwell(value: unknown): value is DwellHotspot {
  return (
    isRecord(value) &&
    hasRanking(value) &&
    isString(value.stationCode) &&
    isString(value.stationName)
  );
}

export function readStretches(data: unknown) {
  if (isRecord(data) && isList(data.delayStretches, isStretch)) return data.delayStretches;
}

export function readDwell(data: unknown) {
  if (isRecord(data) && isList(data.railDwellHotspots, isDwell)) return data.railDwellHotspots;
}
