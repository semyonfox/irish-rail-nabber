import type { BusRealtimeStatus } from "./busRealtime";
import type { BusRouteShape } from "./busShapes";
import type { BusVehicle } from "./busVehicles";

export interface BusStop {
  stopId: string;
  stopCode: string | null;
  stopName: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface BusDeparture {
  entityId: string | null;
  tripId: string | null;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  headsign: string | null;
  serviceDate: string | null;
  scheduledTime: string | null;
  expectedTime: string | null;
  delaySeconds: number | null;
  scheduleRelationship: string | null;
  fetchedAt: string;
}

export interface BusRouteDelay {
  feedVersionId: number;
  routeId: string;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  avgDelaySeconds: number;
  onTimePct: number;
  sampleCount: number;
  lastUpdated: string | null;
}

export interface BusStopsData {
  busStops: BusStop[];
}

export interface BusLiveOverviewData {
  busRealtimeStatus: BusRealtimeStatus;
  busStopBoard?: BusDeparture[];
  busVehicles?: BusVehicle[];
  busLiveRouteShapes?: BusRouteShape[];
  busRouteDelays?: BusRouteDelay[];
}

export interface BusScheduledRouteShapesData {
  busScheduledRouteShapes: BusRouteShape[];
}

export interface BusRouteDelaysData {
  busRouteDelays: BusRouteDelay[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
function text(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function optionalNumber(value: unknown) {
  return value === null || number(value);
}
function strings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => text(value[key]));
}
function list<T>(value: unknown, validate: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(validate);
}
function isStop(v: unknown): v is BusStop {
  return (
    record(v) &&
    typeof v.stopId === "string" &&
    strings(v, ["stopCode", "stopName"]) &&
    optionalNumber(v.latitude) &&
    optionalNumber(v.longitude)
  );
}
function isDeparture(v: unknown): v is BusDeparture {
  return (
    record(v) &&
    strings(v, [
      "entityId",
      "tripId",
      "routeId",
      "routeShortName",
      "routeLongName",
      "operatorName",
      "headsign",
      "serviceDate",
      "scheduledTime",
      "expectedTime",
      "scheduleRelationship",
    ]) &&
    typeof v.fetchedAt === "string" &&
    optionalNumber(v.delaySeconds)
  );
}
function isRouteDelay(v: unknown): v is BusRouteDelay {
  return (
    record(v) &&
    Number.isSafeInteger(v.feedVersionId) &&
    typeof v.routeId === "string" &&
    strings(v, ["routeShortName", "routeLongName", "operatorName", "lastUpdated"]) &&
    number(v.avgDelaySeconds) &&
    number(v.onTimePct) &&
    number(v.sampleCount)
  );
}
function isVehicle(v: unknown): v is BusVehicle {
  return (
    record(v) &&
    strings(v, [
      "entityId",
      "vehicleId",
      "vehicleLabel",
      "tripId",
      "shapeId",
      "routeId",
      "routeShortName",
      "routeLongName",
      "operatorName",
      "headsign",
      "stopId",
      "currentStatus",
      "occupancyStatus",
      "sourceTimestamp",
    ]) &&
    typeof v.fetchedAt === "string" &&
    number(v.latitude) &&
    number(v.longitude) &&
    optionalNumber(v.bearing) &&
    optionalNumber(v.speedMetersPerSecond) &&
    optionalNumber(v.currentStopSequence)
  );
}
function isShape(v: unknown): v is BusRouteShape {
  return (
    record(v) &&
    typeof v.routeId === "string" &&
    typeof v.shapeId === "string" &&
    strings(v, ["routeShortName", "routeColor"]) &&
    Array.isArray(v.points) &&
    v.points.every(
      (p: unknown) => record(p) && number(p.latitude) && number(p.longitude) && number(p.sequence),
    )
  );
}
export function isBusStopsData(v: unknown): v is BusStopsData {
  return record(v) && list(v.busStops, isStop);
}
export function isBusRouteDelaysData(v: unknown): v is BusRouteDelaysData {
  return record(v) && list(v.busRouteDelays, isRouteDelay);
}
export function isBusScheduledRouteShapesData(v: unknown): v is BusScheduledRouteShapesData {
  return record(v) && list(v.busScheduledRouteShapes, isShape);
}
export function isBusLiveOverviewData(v: unknown): v is BusLiveOverviewData {
  if (!record(v) || !record(v.busRealtimeStatus)) return false;
  const status = v.busRealtimeStatus;
  return (
    typeof status.isLive === "boolean" &&
    strings(status, ["lastSuccessAt", "vehiclesLastSuccessAt", "tripUpdatesLastSuccessAt"]) &&
    (v.busStopBoard === undefined || list(v.busStopBoard, isDeparture)) &&
    (v.busVehicles === undefined || list(v.busVehicles, isVehicle)) &&
    (v.busLiveRouteShapes === undefined || list(v.busLiveRouteShapes, isShape)) &&
    (v.busRouteDelays === undefined || list(v.busRouteDelays, isRouteDelay))
  );
}

export interface BusRouteMapData {
  busRouteMap: {
    feedVersionId: number;
    routeId: string;
    shapes: BusRouteShape[];
    stops: BusStop[];
  } | null;
}
export function isBusRouteMapData(v: unknown): v is BusRouteMapData {
  return (
    record(v) &&
    (v.busRouteMap === null ||
      (record(v.busRouteMap) &&
        Number.isSafeInteger(v.busRouteMap.feedVersionId) &&
        typeof v.busRouteMap.routeId === "string" &&
        list(v.busRouteMap.shapes, isShape) &&
        list(v.busRouteMap.stops, isStop)))
  );
}
