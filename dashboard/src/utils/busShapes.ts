export interface BusShapePoint {
  latitude: number;
  longitude: number;
  sequence: number;
}

export interface BusRouteShape {
  routeId: string;
  routeShortName: string | null;
  shapeId: string;
  routeColor: string | null;
  points: BusShapePoint[];
}

export function busShapeRouteLabel(shape: BusRouteShape) {
  return shape.routeShortName?.trim() || shape.routeId.trim() || "Bus";
}

export function gtfsRouteColor(value: string | null, fallback: string) {
  const hex = value?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : fallback;
}

export function busShapeCoordinates(shape: BusRouteShape): [number, number][] {
  return [...shape.points]
    .sort((left, right) => left.sequence - right.sequence)
    .filter(
      (point) =>
        Number.isFinite(point.latitude) &&
        Number.isFinite(point.longitude) &&
        point.latitude >= -90 &&
        point.latitude <= 90 &&
        point.longitude >= -180 &&
        point.longitude <= 180,
    )
    .map((point) => [point.longitude, point.latitude]);
}
