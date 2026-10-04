export interface BusPublishedDataset {
  importId: string;
  sourceUrl: string;
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function metric(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function percentage(value: unknown): value is number | null {
  return metric(value) && (value === null || (value >= 0 && value <= 100));
}
export function isBusPublishedDatasetData(
  value: unknown,
): value is { busPublishedDataset: BusPublishedDataset | null } {
  if (!record(value)) return false;
  const d = value.busPublishedDataset;
  return (
    d === null ||
    (record(d) &&
      typeof d.importId === "string" &&
      /^[0-9a-f]{64}$/.test(d.importId) &&
      typeof d.sourceUrl === "string" &&
      d.sourceUrl.startsWith("https://www.nationaltransport.ie/") &&
      date(d.importedAt) &&
      (d.sourceUpdatedAt === null || date(d.sourceUpdatedAt)) &&
      integer(d.recordCount) &&
      d.recordCount > 0 &&
      integer(d.firstYear) &&
      integer(d.lastYear) &&
      integer(d.routeCount) &&
      Array.isArray(d.operators) &&
      d.operators.every((s: unknown) => typeof s === "string") &&
      Array.isArray(d.years) &&
      d.years.every(integer))
  );
}
export function isBusPublishedPageData(
  value: unknown,
): value is { busPublishedPerformance: { totalCount: number; rows: BusPublishedPoint[] } } {
  if (!record(value) || !record(value.busPublishedPerformance)) return false;
  const page = value.busPublishedPerformance;
  return (
    integer(page.totalCount) &&
    page.totalCount >= 0 &&
    Array.isArray(page.rows) &&
    page.rows.every(
      (p: unknown) =>
        record(p) &&
        typeof p.operatorName === "string" &&
        typeof p.routeShortName === "string" &&
        integer(p.reportYear) &&
        integer(p.reportPeriod) &&
        p.reportPeriod >= 1 &&
        p.reportPeriod <= 13 &&
        percentage(p.onTimePct) &&
        percentage(p.earlyPct) &&
        percentage(p.latePct) &&
        (p.actualDepartures === null || (integer(p.actualDepartures) && p.actualDepartures >= 0)) &&
        metric(p.excessWaitMinutes) &&
        metric(p.plannedKm) &&
        metric(p.actualKm) &&
        metric(p.lostKm) &&
        metric(p.contractualLostKm),
    )
  );
}
export function publishedRoutePath(operator: string, route: string) {
  return "/buses/published?" + new URLSearchParams({ operator, route }).toString();
}
