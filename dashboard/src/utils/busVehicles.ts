export interface BusVehicle {
  entityId: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;
  tripId: string | null;
  routeId: string | null;
  routeShortName: string | null;
  routeLongName: string | null;
  operatorName: string | null;
  headsign: string | null;
  latitude: number;
  longitude: number;
  bearing: number | null;
  speedMetersPerSecond: number | null;
  currentStopSequence: number | null;
  stopId: string | null;
  currentStatus: string | null;
  occupancyStatus: string | null;
  sourceTimestamp: string | null;
  fetchedAt: string;
}

export function busVehicleKey(vehicle: BusVehicle) {
  return (
    vehicle.vehicleId?.trim() ||
    vehicle.entityId?.trim() ||
    vehicle.tripId?.trim() ||
    `${vehicle.routeId ?? "bus"}:${vehicle.latitude.toFixed(6)}:${vehicle.longitude.toFixed(6)}`
  );
}

export function busVehicleRoute(vehicle: BusVehicle) {
  return vehicle.routeShortName?.trim() || vehicle.routeId?.trim() || "Bus";
}

export function humanizeGtfsValue(value: string | null) {
  if (!value) return null;
  const words = value.toLowerCase().split("_").filter(Boolean);
  if (words.length === 0) return null;
  return `${words[0][0]?.toUpperCase() ?? ""}${words[0].slice(1)}${words
    .slice(1)
    .map((word) => ` ${word}`)
    .join("")}`;
}

export function speedKmh(metersPerSecond: number | null) {
  return metersPerSecond == null ? null : Math.max(0, Math.round(metersPerSecond * 3.6));
}
