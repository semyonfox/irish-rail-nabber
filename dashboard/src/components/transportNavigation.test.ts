import { describe, expect, test } from "vite-plus/test";

import { transportLinks, transportModeForPath } from "./transportNavigation";

describe("transport navigation", () => {
  test.each(["/", "/stations", "/analytics", "/history", "/chat"])(
    "treats %s as Rail",
    (pathname) => {
      expect(transportModeForPath(pathname)).toBe("rail");
    },
  );

  test("keeps the bus deep link in Bus mode", () => {
    expect(transportModeForPath("/buses")).toBe("bus");
    expect(transportLinks.bus).toEqual([{ to: "/buses", label: "Departures", icon: "bus" }]);
  });

  test.each(["/pricing", "/account", "/login"])(
    "leaves global route %s outside either transport mode",
    (pathname) => {
      expect(transportModeForPath(pathname)).toBeNull();
    },
  );
});
