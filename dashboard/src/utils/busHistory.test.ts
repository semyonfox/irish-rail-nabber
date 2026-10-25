import { describe, expect, test } from "vite-plus/test";
import {
  busHistoryRanges,
  busJourneyPath,
  busStopPath,
  summarizeBusHistory,
  type BusHistoryPoint,
} from "./busHistory";

function point(avgDelaySeconds: number, onTimePct: number, sampleCount: number): BusHistoryPoint {
  return {
    bucket: "2026-10-25T10:00:00Z",
    avgDelaySeconds,
    maxDelaySeconds: avgDelaySeconds * 2,
    p95DelaySeconds: avgDelaySeconds,
    onTimePct,
    earlyCount: 0,
    lateCount: 0,
    sampleCount,
    lastUpdated: "2026-10-25T10:59:00Z",
  };
}

describe("bus history summary", () => {
  test("weights each hour by its observations", () => {
    const summary = summarizeBusHistory([point(60, 100, 3), point(600, 0, 1)]);
    expect(summary.avgDelaySeconds).toBe(195);
    expect(summary.onTimePct).toBe(75);
    expect(summary.maxDelaySeconds).toBe(1200);
    expect(summary.sampleCount).toBe(4);
  });

  test("has no averages without observations", () => {
    expect(summarizeBusHistory([])).toEqual({
      sampleCount: 0,
      avgDelaySeconds: null,
      onTimePct: null,
      maxDelaySeconds: null,
    });
  });
});

test("offers the week only to plans the API allows it for", () => {
  expect(busHistoryRanges(72).map((range) => range.value)).toEqual([6, 24, 72]);
  expect(busHistoryRanges(168).at(-1)?.value).toBe(168);
});

test("encodes NTA identifiers in links", () => {
  expect(busStopPath(4, "8220DB 1/2")).toBe("/buses/stops/4/8220DB%201%2F2");
  expect(busJourneyPath(4, "4205_A", "2026-10-25|trip/1")).toBe(
    "/buses/routes/4/4205_A/journeys/2026-10-25%7Ctrip%2F1",
  );
});
