import { describe, expect, test } from "vite-plus/test";

import {
  busShapeCoordinates,
  busShapeRouteLabel,
  gtfsRouteColor,
  type BusRouteShape,
} from "./busShapes";

const shape: BusRouteShape = {
  routeId: "404",
  routeShortName: " 404 ",
  shapeId: "outbound",
  routeColor: "0B6B4D",
  points: [
    { latitude: 53.2, longitude: -8.8, sequence: 8 },
    { latitude: 53.0, longitude: -9.0, sequence: 0 },
    { latitude: Number.NaN, longitude: -8.9, sequence: 4 },
  ],
};

describe("bus route shape display values", () => {
  test("normalizes valid GTFS colors and rejects malformed values", () => {
    expect(gtfsRouteColor(" 0B6B4D ", "#d88a05")).toBe("#0B6B4D");
    expect(gtfsRouteColor("#abcdef", "#d88a05")).toBe("#abcdef");
    expect(gtfsRouteColor("javascript:red", "#d88a05")).toBe("#d88a05");
  });

  test("orders coordinates by GTFS sequence and drops invalid points", () => {
    expect(busShapeCoordinates(shape)).toEqual([
      [-9.0, 53.0],
      [-8.8, 53.2],
    ]);
  });

  test("uses the public route name before the feed's internal id", () => {
    expect(busShapeRouteLabel(shape)).toBe("404");
    expect(busShapeRouteLabel({ ...shape, routeShortName: null, routeId: "route-404" })).toBe(
      "route-404",
    );
  });
});
