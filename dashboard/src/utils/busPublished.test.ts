import { expect, test } from "vite-plus/test";
import {
  isBusPublishedDatasetData,
  isBusPublishedPageData,
  publishedRoutePath,
} from "./busPublished";

test("validates cached public aggregates without converting missing values to zero", () => {
  const point = {
    operatorName: "Bus Éireann DAC",
    routeShortName: "409",
    reportYear: 2025,
    reportPeriod: 1,
    onTimePct: null,
    earlyPct: null,
    latePct: null,
    actualDepartures: null,
    excessWaitMinutes: 1.26,
    plannedKm: 73205.009,
    actualKm: 71170.827,
    lostKm: 2034.182,
    contractualLostKm: 1695.213,
  };
  const response = { busPublishedPerformance: { totalCount: 1, rows: [point] } };
  expect(isBusPublishedPageData(response)).toBe(true);
  expect(
    isBusPublishedPageData({
      busPublishedPerformance: { totalCount: 1, rows: [{ ...point, onTimePct: 101 }] },
    }),
  ).toBe(false);
  expect(
    isBusPublishedPageData({
      busPublishedPerformance: { totalCount: 1, rows: [{ ...point, excessWaitMinutes: "1.26" }] },
    }),
  ).toBe(false);
  expect(
    isBusPublishedPageData({
      busPublishedPerformance: { totalCount: 1, rows: [{ ...point, reportPeriod: 14 }] },
    }),
  ).toBe(false);
});
test("scopes published links by contract and validates source links", () => {
  expect(publishedRoutePath("Bus Éireann DAC", "409")).toBe(
    "/buses/published?operator=Bus+%C3%89ireann+DAC&route=409",
  );
  const dataset = {
    importId: "a".repeat(64),
    sourceUrl: "https://www.nationaltransport.ie/public/",
    importedAt: "2026-09-14T00:00:00Z",
    sourceUpdatedAt: null,
    recordCount: 10,
    firstYear: 2024,
    lastYear: 2026,
    routeCount: 3,
    operators: ["Dublin Bus"],
    years: [2026, 2025, 2024],
  };
  expect(isBusPublishedDatasetData({ busPublishedDataset: dataset })).toBe(true);
  expect(
    isBusPublishedDatasetData({
      busPublishedDataset: { ...dataset, sourceUrl: "javascript:alert(1)" },
    }),
  ).toBe(false);
  expect(isBusPublishedDatasetData({ busPublishedDataset: null })).toBe(true);
});
