import { describe, expect, test } from "vite-plus/test";

import {
  busVehicleKey,
  busVehicleRoute,
  humanizeGtfsValue,
  speedKmh,
  type BusVehicle,
} from "./busVehicles";

const vehicle: BusVehicle = {
  entityId: "entity-7",
  vehicleId: "vehicle-7",
  vehicleLabel: "Fleet 7",
  tripId: "trip-7",
  routeId: "route-404",
  routeShortName: "404",
  routeLongName: "Oranmore to Eyre Square",
  operatorName: "Bus Éireann",
  headsign: "Eyre Square",
  latitude: 53.27,
  longitude: -9.05,
  bearing: 90,
  speedMetersPerSecond: 10,
  currentStopSequence: 12,
  stopId: "stop-12",
  currentStatus: "IN_TRANSIT_TO",
  occupancyStatus: "MANY_SEATS_AVAILABLE",
  sourceTimestamp: "2026-09-13T11:30:00Z",
  fetchedAt: "2026-09-13T11:30:01Z",
};

describe("bus vehicle display values", () => {
  test("uses feed identities before a coordinate fallback", () => {
    expect(busVehicleKey(vehicle)).toBe("vehicle-7");
    expect(busVehicleKey({ ...vehicle, vehicleId: null })).toBe("entity-7");
    expect(busVehicleKey({ ...vehicle, vehicleId: null, entityId: null, tripId: null })).toBe(
      "route-404:53.270000:-9.050000",
    );
  });

  test("formats route, state and speed for riders", () => {
    expect(busVehicleRoute(vehicle)).toBe("404");
    expect(humanizeGtfsValue(vehicle.currentStatus)).toBe("In transit to");
    expect(humanizeGtfsValue(vehicle.occupancyStatus)).toBe("Many seats available");
    expect(speedKmh(vehicle.speedMetersPerSecond)).toBe(36);
  });
});
