import { describe, expect, test } from "vite-plus/test";

import { busFeedState, busSourceStatus, busUpdateAge } from "./busRealtime";

describe("bus realtime presentation", () => {
  test("distinguishes loading, live, static-only and stale feeds", () => {
    expect(busFeedState(null, true).badge).toBe("Checking realtime");
    expect(busFeedState(null, false).badge).toBe("Status unavailable");
    expect(
      busFeedState({ isLive: true, lastSuccessAt: "2026-09-13T12:45:00Z" }, false),
    ).toMatchObject({ badge: "Live NTA feed", isLive: true });
    expect(busFeedState({ isLive: false, lastSuccessAt: null }, false).badge).toBe(
      "Static feed only",
    );
    expect(
      busFeedState({ isLive: false, lastSuccessAt: "2026-09-13T10:00:00Z" }, false).badge,
    ).toBe("Realtime offline");
  });

  test("does not claim departures work without a current realtime feed", () => {
    const offline = busFeedState({ isLive: false, lastSuccessAt: null }, false);

    expect(offline.emptyDescription).toContain("Stop search remains available");
    expect(offline.emptyDescription).toContain("Departures and vehicle tracking need");
  });
});

describe("independent bus feed freshness", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  const status = {
    isLive: true,
    lastSuccessAt: "2026-09-14T11:59:55Z",
    tripUpdatesLastSuccessAt: "2026-09-14T11:59:55Z",
    vehiclesLastSuccessAt: "2026-09-14T11:56:00Z",
  };

  test("successful predictions cannot revive stale vehicles", () => {
    expect(busSourceStatus(status, "vehicles", now)?.isLive).toBe(false);
    expect(busSourceStatus(status, "tripUpdates", now)?.isLive).toBe(true);
    expect(busSourceStatus(status, "tripUpdates", now + 180_000)?.isLive).toBe(false);
  });

  test("missing, invalid and future timestamps do not claim a live feed", () => {
    expect(busSourceStatus(null, "vehicles", now)).toBeNull();
    for (const timestamp of [null, "bad", "2026-09-14T12:01:00Z"]) {
      expect(
        busSourceStatus({ ...status, vehiclesLastSuccessAt: timestamp }, "vehicles", now)?.isLive,
      ).toBe(false);
    }
  });

  test("displays update ages without treating a missing timestamp as now", () => {
    expect(busUpdateAge(status.tripUpdatesLastSuccessAt, now)).toBe("5s ago");
    expect(busUpdateAge(status.vehiclesLastSuccessAt, now)).toBe("4m 0s ago");
    expect(busUpdateAge("2026-09-14T06:00:00Z", now)).toBe("6h 0m ago");
    expect(busUpdateAge("2026-09-12T11:00:00Z", now)).toBe("2d 1h ago");
    expect(busUpdateAge(null, now)).toBe("No successful update");
    expect(busUpdateAge("bad", now)).toBe("Time unavailable");
  });
});
