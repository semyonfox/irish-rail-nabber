import { describe, expect, test } from "vite-plus/test";
import {
  busHistoryMaxHours,
  busHistoryRanges,
  busHistoryResolution,
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

test("offers longer windows only where the API allows them", () => {
  expect(busHistoryRanges(busHistoryMaxHours(undefined, "delays")).map((r) => r.value)).toEqual([
    6, 24, 72,
  ]);
  expect(busHistoryRanges(busHistoryMaxHours("pro", "delays")).at(-1)?.value).toBe(2160);
  expect(busHistoryRanges(busHistoryMaxHours("pro", "stopRankings")).at(-1)?.value).toBe(72);
  expect(busHistoryRanges(busHistoryMaxHours("pro", "journeys")).at(-1)?.value).toBe(168);
  expect(busHistoryMaxHours("free", "journeys")).toBe(72);
});

test("switches to daily buckets beyond a week", () => {
  expect(busHistoryResolution(168)).toBe("HOUR");
  expect(busHistoryResolution(720)).toBe("DAY");
});

test("encodes NTA identifiers in links", () => {
  expect(busStopPath(4, "8220DB 1/2")).toBe("/buses/stops/4/8220DB%201%2F2");
  expect(busJourneyPath(4, "4205_A", "2026-10-25|trip/1")).toBe(
    "/buses/routes/4/4205_A/journeys/2026-10-25%7Ctrip%2F1",
  );
});
