import { expect, test } from "vite-plus/test";
import {
  defaultPublishedMetric,
  publishedContractPath,
  publishedRouteSearchPath,
  type BusPublishedPoint,
} from "./busPublished";

const row: BusPublishedPoint = {
  operatorName: "Bus Éireann DAC",
  routeShortName: "409",
  reportYear: 2025,
  reportPeriod: 1,
  onTimePct: null,
  earlyPct: null,
  latePct: null,
  actualDepartures: null,
  excessWaitMinutes: null,
  plannedKm: 73205,
  actualKm: 71170,
  lostKm: 2034,
  contractualLostKm: 1695,
};

test("charts the metric the NTA actually published for a route", () => {
  expect(defaultPublishedMetric([row, { ...row, onTimePct: 81 }])).toBe("onTimePct");
  expect(defaultPublishedMetric([{ ...row, excessWaitMinutes: 1.26 }])).toBe("excessWaitMinutes");
  expect(defaultPublishedMetric([row])).toBe("lostKm");
  // zero is a published value, not a missing one
  expect(defaultPublishedMetric([{ ...row, onTimePct: 0 }])).toBe("onTimePct");
});

test("encodes contract names in published links", () => {
  expect(publishedContractPath("Bus Éireann DAC", "409")).toBe(
    "/buses/published?operator=Bus+%C3%89ireann+DAC&route=409",
  );
  expect(publishedRouteSearchPath("4&5")).toBe("/buses/published?q=4%265");
});
