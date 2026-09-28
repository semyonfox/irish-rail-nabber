import { describe, expect, test } from "vite-plus/test";

import { transportLinks, transportModeForPath, transportModePath } from "./transportNavigation";

describe("transport navigation", () => {
  test.each(["/", "/stations", "/analytics", "/history", "/chat"])(
    "treats %s as Rail",
    (pathname) => {
      expect(transportModeForPath(pathname)).toBe("rail");
    },
  );

  test("keeps the bus deep link in Bus mode", () => {
    expect(transportModeForPath("/buses")).toBe("bus");
    expect(transportLinks.bus.map((link) => link.label)).toEqual(["Live", "Stops", "Network"]);
  });

  test.each(["/pricing", "/account", "/login"])(
    "leaves global route %s outside either transport mode",
    (pathname) => {
      expect(transportModeForPath(pathname)).toBeNull();
    },
  );
});

test.each([
  ["/", "bus", "/buses"],
  ["/buses", "rail", "/"],
  ["/stations", "bus", "/buses/stops"],
  ["/buses/stops", "rail", "/stations"],
  ["/analytics", "bus", "/buses/network"],
  ["/buses/network", "rail", "/analytics"],
  ["/history", "bus", "/buses"],
] as const)("switches %s to %s at %s", (path, mode, expected) => {
  expect(transportModePath(path, mode)).toBe(expected);
  expect(transportModeForPath(expected)).toBe(mode);
});
