import { describe, expect, test } from "vite-plus/test";

import {
  busShapeCoordinates,
  busShapeRouteLabel,
  decodePolyline,
  gtfsRouteColor,
  type BusRouteShape,
} from "./busShapes";

const shape: BusRouteShape = {
  routeId: "404",
  routeShortName: " 404 ",
  shapeId: "outbound",
  routeColor: "0B6B4D",
  // the worked example from Google's polyline algorithm docs, as the API encodes it
  polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
};

describe("bus route shape display values", () => {
  test("normalizes valid GTFS colors and rejects malformed values", () => {
    expect(gtfsRouteColor(" 0B6B4D ", "#d88a05")).toBe("#0B6B4D");
    expect(gtfsRouteColor("#abcdef", "#d88a05")).toBe("#abcdef");
    expect(gtfsRouteColor("javascript:red", "#d88a05")).toBe("#d88a05");
  });

  test("decodes the API polyline into map coordinates", () => {
    expect(busShapeCoordinates(shape)).toEqual([
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ]);
  });

  test("keeps the valid prefix of a truncated or corrupt polyline", () => {
    expect(decodePolyline("_p~iF~ps|U_ulL")).toEqual([[-120.2, 38.5]]);
    expect(decodePolyline("_p~iF~ps|U\u0000\u0000")).toEqual([[-120.2, 38.5]]);
  });

  test("uses the public route name before the feed's internal id", () => {
    expect(busShapeRouteLabel(shape)).toBe("404");
    expect(busShapeRouteLabel({ ...shape, routeShortName: null, routeId: "route-404" })).toBe(
      "route-404",
    );
  });
});
