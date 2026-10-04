import { describe, expect, test } from "vite-plus/test";
import { decodeBusSnapshot } from "./busCache";
import {
  mergeBusHistory,
  busRoutePath,
  isBusHistoryData,
  isBusRoutesData,
  summarizeBusHistory,
} from "./busHistory";

const point = {
  bucket: "2026-09-14T10:00:00Z",
  lastUpdated: "2026-09-14T10:30:00Z",
  avgDelaySeconds: 60,
  maxDelaySeconds: 300,
  p95DelaySeconds: 240,
  onTimePct: 90,
  earlyCount: 1,
  lateCount: 9,
  sampleCount: 100,
};
describe("bus snapshots", () => {
  test("accepts valid persisted history and rejects expired or corrupt data", () => {
    const now = Date.parse(point.lastUpdated);
    const data = { busDelayHistory: [point] };
    expect(decodeBusSnapshot({ savedAt: now, data }, isBusHistoryData, now)?.data).toEqual(data);
    expect(
      decodeBusSnapshot({ savedAt: now - 8 * 86400000, data }, isBusHistoryData, now),
    ).toBeUndefined();
    expect(decodeBusSnapshot({ savedAt: now + 1, data }, isBusHistoryData, now)).toBeUndefined();
    expect(
      decodeBusSnapshot(
        { savedAt: now, data: { busDelayHistory: [{ ...point, sampleCount: "100" }] } },
        isBusHistoryData,
        now,
      ),
    ).toBeUndefined();
    expect(isBusHistoryData({ busDelayHistory: [{ ...point, bucket: "invalid" }] })).toBe(false);
    expect(isBusHistoryData({ busDelayHistory: [{ ...point, onTimePct: Infinity }] })).toBe(false);
  });
  test("weights summaries by observations and distinguishes no data from zero delay", () => {
    const summary = summarizeBusHistory([
      point,
      { ...point, sampleCount: 10, avgDelaySeconds: 600, onTimePct: 0 },
    ]);
    expect(summary.avgDelaySeconds).toBeCloseTo(12000 / 110);
    expect(summary.onTimePct).toBeCloseTo(9000 / 110);
    expect(summarizeBusHistory([]).avgDelaySeconds).toBeNull();
    expect(summarizeBusHistory([{ ...point, avgDelaySeconds: 0 }]).avgDelaySeconds).toBe(0);
  });
  test("retains exact route identity and validates route snapshots", () => {
    const route = {
      feedVersionId: 7,
      routeId: "a/b ?",
      routeShortName: "409",
      routeLongName: null,
      operatorName: "Bus Éireann",
      isActive: true,
    };
    expect(isBusRoutesData({ busRoutes: [route] })).toBe(true);
    expect(isBusRoutesData({ busRoutes: [{ ...route, feedVersionId: "7" }] })).toBe(false);
    expect(busRoutePath(route)).toBe("/buses/routes/7/a%2Fb%20%3F");
  });
});

test("incremental history replaces mutable buckets, preserves gaps and drops expired periods", () => {
  const current = {
    busDelayHistory: [
      { ...point, bucket: "2026-09-10T10:00:00Z" },
      { ...point, bucket: "2026-09-14T08:00:00Z" },
      point,
    ],
  };
  const updated = { ...point, sampleCount: 150, p95DelaySeconds: 270 };
  const next = { ...point, bucket: "2026-09-14T12:00:00Z" };
  const result = mergeBusHistory(
    current,
    { busDelayHistory: [next, updated] },
    24,
    Date.parse("2026-09-14T12:30:00Z"),
  );
  expect(result.busDelayHistory).toEqual([current.busDelayHistory[1], updated, next]);
  expect(mergeBusHistory(current, { busDelayHistory: [] }, 0).busDelayHistory).toHaveLength(3);
});
