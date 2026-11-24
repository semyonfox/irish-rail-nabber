import { expect, test } from "vite-plus/test";
import { isBusRouteMapData } from "./busData";
import { decodeBusSnapshot } from "./busCache";

const data = {
  busRouteMap: {
    feedVersionId: 2,
    routeId: "409",
    shapes: [
      {
        routeId: "409",
        routeShortName: "409",
        shapeId: "outbound",
        routeColor: null,
        points: [
          { latitude: 53.3, longitude: -9, sequence: 1 },
          { latitude: 53.31, longitude: -9.01, sequence: 2 },
        ],
      },
    ],
    stops: [
      { stopId: "1", stopName: "Eyre Square", stopCode: null, latitude: 53.3, longitude: -9 },
    ],
  },
};

test("route geometry and stops survive the persisted cache boundary", () => {
  const now = Date.now();
  expect(decodeBusSnapshot({ data, savedAt: now }, isBusRouteMapData, now)?.data).toEqual(data);
  expect(isBusRouteMapData({ busRouteMap: null })).toBe(true);
});
test("rejects corrupt geometry and stop records before rendering a saved map", () => {
  expect(isBusRouteMapData({ busRouteMap: { ...data.busRouteMap, feedVersionId: "2" } })).toBe(
    false,
  );
  expect(
    isBusRouteMapData({
      busRouteMap: {
        ...data.busRouteMap,
        stops: [{ ...data.busRouteMap.stops[0], latitude: "53.3" }],
      },
    }),
  ).toBe(false);
  expect(
    isBusRouteMapData({
      busRouteMap: {
        ...data.busRouteMap,
        shapes: [
          {
            ...data.busRouteMap.shapes[0],
            points: [{ latitude: NaN, longitude: -9, sequence: 1 }],
          },
        ],
      },
    }),
  ).toBe(false);
});
