export interface BusPublishedDataset {
  importId: string;
  importedAt: string;
  sourceUpdatedAt: string | null;
  recordCount: number;
  firstYear: number;
  lastYear: number;
  routeCount: number;
  operators: string[];
  years: number[];
}

export interface BusPublishedPoint {
  operatorName: string;
  routeShortName: string;
  reportYear: number;
  reportPeriod: number;
  onTimePct: number | null;
  earlyPct: number | null;
  latePct: number | null;
  actualDepartures: number | null;
  excessWaitMinutes: number | null;
  plannedKm: number | null;
  actualKm: number | null;
  lostKm: number | null;
  contractualLostKm: number | null;
}

export const NTA_PUBLISHED_DASHBOARD_URL =
  "https://www.nationaltransport.ie/public-transport-services/public-transport-contracts/operator-performance/pso-bus-performance-dashboard/pso-bus-performance-dashboard/";

export type PublishedMetric = "onTimePct" | "excessWaitMinutes" | "lostKm";

// NTA publishes punctuality for low-frequency routes and excess waiting time for
// high-frequency ones, so pick whichever this route actually has
export function defaultPublishedMetric(rows: BusPublishedPoint[]): PublishedMetric {
  if (rows.some((row) => row.onTimePct !== null)) return "onTimePct";
  if (rows.some((row) => row.excessWaitMinutes !== null)) return "excessWaitMinutes";
  return "lostKm";
}

// operator names differ between the published contracts and GTFS agencies, so
// route pages link by search rather than by contract
export function publishedRouteSearchPath(routeShortName: string) {
  return `/buses/published?${new URLSearchParams({ q: routeShortName })}`;
}

export function publishedContractPath(operatorName: string, routeShortName: string) {
  return `/buses/published?${new URLSearchParams({ operator: operatorName, route: routeShortName })}`;
}
