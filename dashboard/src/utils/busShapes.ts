export interface BusRouteShape {
  routeId: string;
  routeShortName: string | null;
  shapeId: string;
  routeColor: string | null;
  /** Google encoded polyline at five decimal places */
  polyline: string;
}

export function busShapeRouteLabel(shape: BusRouteShape) {
  return shape.routeShortName?.trim() || shape.routeId.trim() || "Bus";
}

export function gtfsRouteColor(value: string | null, fallback: string) {
  const hex = value?.trim().replace(/^#/, "") ?? "";
  return /^[0-9a-f]{6}$/i.test(hex) ? `#${hex}` : fallback;
}

/** decodes to [longitude, latitude] pairs, stopping at the first malformed value */
export function decodePolyline(encoded: string): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const next = () => {
    let result = 0;
    let shift = 0;
    while (index < encoded.length) {
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (byte < 0x20) return result & 1 ? ~(result >> 1) : result >> 1;
    }
    return null;
  };

  while (index < encoded.length) {
    const latitudeDelta = next();
    const longitudeDelta = next();
    if (latitudeDelta == null || longitudeDelta == null) break;
    latitude += latitudeDelta;
    longitude += longitudeDelta;
    const point: [number, number] = [longitude / 1e5, latitude / 1e5];
    if (Math.abs(point[1]) > 90 || Math.abs(point[0]) > 180) break;
    coordinates.push(point);
  }
  return coordinates;
}

export function busShapeCoordinates(shape: BusRouteShape): [number, number][] {
  return decodePolyline(shape.polyline);
}
