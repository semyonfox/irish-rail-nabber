import { describe, expect, test } from "vite-plus/test";
import { busMotionPath, busMotionPosition } from "./busMotion";
import type { BusVehicle } from "./busVehicles";

const now = Date.parse("2026-09-14T12:02:00Z");
const line: [number, number][] = [
  [-9, 53],
  [-8.999, 53],
  [-8.999, 53.001],
];
const previous: BusVehicle = {
  entityId: "e",
  vehicleId: "v",
  vehicleLabel: null,
  tripId: "t",
  shapeId: "s",
  routeId: "r",
  routeShortName: "404",
  routeLongName: null,
  operatorName: null,
  headsign: null,
  longitude: -9,
  latitude: 53,
  bearing: null,
  speedMetersPerSecond: null,
  currentStopSequence: null,
  stopId: null,
  currentStatus: null,
  occupancyStatus: null,
  sourceTimestamp: "2026-09-14T12:00:00Z",
  fetchedAt: "2026-09-14T12:00:01Z",
};
const current: BusVehicle = {
  ...previous,
  longitude: -8.999,
  latitude: 53.001,
  sourceTimestamp: "2026-09-14T12:02:00Z",
  fetchedAt: "2026-09-14T12:02:01Z",
};

describe("bus report animation", () => {
  test("follows the trip's bend and ends exactly at the reported position", () => {
    const path = busMotionPath(previous, current, line, now);
    expect(path).not.toBeNull();
    if (!path) throw new Error("Expected path");
    expect(busMotionPosition(path, 0)).toEqual(line[0]);
    const middle = busMotionPosition(path, 0.5);
    expect(middle[0]).toBe(-8.999);
    expect(middle[1]).toBeGreaterThan(53);
    expect(busMotionPosition(path, 1)).toEqual(line[2]);
    expect(busMotionPosition(path, 2)).toEqual(line[2]);
  });

  test("does not invent motion without a matching shape or across trips", () => {
    expect(busMotionPath(undefined, current, line, now)).toBeNull();
    expect(busMotionPath(previous, current, undefined, now)).toBeNull();
    expect(busMotionPath(previous, { ...current, tripId: "new" }, line, now)).toBeNull();
    expect(busMotionPath(previous, { ...current, shapeId: "opposite" }, line, now)).toBeNull();
  });

  test("rejects stale reports, repeated timestamps, backward travel and diversions", () => {
    expect(busMotionPath(previous, current, line, now + 180_000)).toBeNull();
    expect(
      busMotionPath(previous, { ...current, sourceTimestamp: previous.sourceTimestamp }, line, now),
    ).toBeNull();
    expect(busMotionPath(previous, current, [...line].reverse(), now)).toBeNull();
    expect(busMotionPath(previous, { ...current, latitude: 54 }, line, now)).toBeNull();
    expect(
      busMotionPath(previous, { ...current, sourceTimestamp: "2026-09-14T12:00:01Z" }, line, now),
    ).toBeNull();
  });
});
