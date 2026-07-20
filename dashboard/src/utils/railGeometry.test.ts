import { describe, expect, test } from "vite-plus/test";

import { trackPathBetween, trackPathThrough, type RailCoordinate } from "./railGeometry";

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
    expect(trackPathThrough(disconnected, [[-8, 53], [-7, 54]])).toEqual([]);
  });
});
