import { describe, expect, test } from "vite-plus/test";

import { busFeedState } from "./busRealtime";

describe("bus realtime presentation", () => {
  test("distinguishes loading, live, static-only and stale feeds", () => {
    expect(busFeedState(null, true).badge).toBe("Checking realtime");
    expect(busFeedState(null, false).badge).toBe("Status unavailable");
    expect(
      busFeedState({ isLive: true, lastSuccessAt: "2026-09-13T12:45:00Z" }, false),
    ).toMatchObject({ badge: "60 second live feed", isLive: true });
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
