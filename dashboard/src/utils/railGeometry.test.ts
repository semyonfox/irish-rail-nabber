import { describe, expect, test } from "vite-plus/test";

import railNetworkRaw from "../assets/rail-network.geojson?raw";
import {
  railLinesFromCollection,
  trackPathBetween,
  trackPathThrough,
  type RailCoordinate,
  type RailFeatureCollection,
} from "./railGeometry";

const METERS_PER_DEGREE = 111_320;

function distanceMeters(from: RailCoordinate, to: RailCoordinate) {
  const latitude = ((from[1] + to[1]) / 2) * (Math.PI / 180);
  return Math.hypot(
    (to[0] - from[0]) * METERS_PER_DEGREE * Math.cos(latitude),
    (to[1] - from[1]) * METERS_PER_DEGREE,
  );
}

function pathLength(path: RailCoordinate[]) {
  return path
    .slice(1)
    .reduce((total, coordinate, index) => total + distanceMeters(path[index], coordinate), 0);
}

describe("rail geometry routing", () => {
  const lines: RailCoordinate[][] = [
    [
      [-8, 53],
      [-7.9, 53.05],
      [-7.8, 53.1],
    ],
    [
      [-7.8, 53.1],
      [-7.7, 53.2],
      [-7.6, 53.25],
    ],
  ];

  test("routes across connected line features", () => {
    expect(trackPathBetween(lines, [-8, 53], [-7.6, 53.25])).toEqual([
      [-8, 53],
      [-7.9, 53.05],
      [-7.8, 53.1],
      [-7.7, 53.2],
      [-7.6, 53.25],
    ]);
  });

  test("does not draw a straight line when no track route exists", () => {
    const disconnected: RailCoordinate[][] = [
      [
        [-8, 53],
        [-7.9, 53.05],
      ],
      [
        [-7, 54],
        [-6.9, 54.05],
      ],
    ];

    expect(trackPathBetween(disconnected, [-8, 53], [-7, 54])).toEqual([]);
    expect(trackPathBetween(disconnected, [-8, 53], [-7, 54], true)).toEqual([
      [-8, 53],
      [-7, 54],
    ]);
    expect(
      trackPathThrough(disconnected, [
        [-8, 53],
        [-7, 54],
      ]),
    ).toEqual([]);
  });
});

describe("generated Irish rail geometry", () => {
  const collection = JSON.parse(railNetworkRaw) as RailFeatureCollection;
  const lines = railLinesFromCollection(collection);

  test("keeps the detailed source compact enough for the browser", () => {
    const vertices = lines.reduce((total, line) => total + line.length, 0);

    expect(collection.metadata?.outputCrs).toBe("EPSG:4326");
    expect(lines.length).toBeGreaterThan(5_000);
    expect(vertices).toBeGreaterThan(15_000);
    expect(vertices).toBeLessThan(30_000);
    expect(railNetworkRaw.length).toBeLessThan(600_000);
  });

  test("follows the M3 Parkway branch instead of collapsing its stops", () => {
    const stops: RailCoordinate[] = [
      [-6.46898, 53.4349], // M3 Parkway
      [-6.46483, 53.4175], // Dunboyne
      [-6.44205, 53.3853], // Hansfield
      [-6.4242, 53.3831], // Clonsilla
    ];
    const path = trackPathThrough(lines, stops);

    expect(path.length).toBeGreaterThan(5);
    expect(distanceMeters(path[0], stops[0])).toBeLessThan(100);
    expect(distanceMeters(path.at(-1)!, stops.at(-1)!)).toBeLessThan(100);
    expect(pathLength(path)).toBeGreaterThan(5_000);
    expect(pathLength(path)).toBeLessThan(15_000);
  });

  test("routes through the detailed Kilkenny line", () => {
    const kilkenny: RailCoordinate = [-7.24498, 52.655];
    const muineBheag: RailCoordinate = [-6.95213, 52.699];
    const path = trackPathBetween(lines, kilkenny, muineBheag);

    expect(path.length).toBeGreaterThan(5);
    expect(distanceMeters(path[0], kilkenny)).toBeLessThan(100);
    expect(distanceMeters(path.at(-1)!, muineBheag)).toBeLessThan(100);
    expect(pathLength(path)).toBeGreaterThan(15_000);
    expect(pathLength(path)).toBeLessThan(30_000);
  });

  test("rejects the upstream Adamstown coordinate instead of snapping kilometres away", () => {
    expect(trackPathBetween(lines, [-7, 53.3353], [-6.45233, 53.3353])).toEqual([]);
  });
});
