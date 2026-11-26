export type MapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  detail: string;
};

export type Viewport = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

export type VehicleMapProps = {
  points: MapPoint[];
  mode: "rail" | "bus";
  onSelect: (id: string) => void;
};

export const ireland: Viewport = {
  latitude: 53.45,
  longitude: -8,
  latitudeDelta: 4.2,
  longitudeDelta: 6.2,
};

// buses at a terminus often report the same position, which would stack the
// pins. fan those out in a ring wide enough that neighbouring 44pt targets
// don't overlap. 320 is the shortest map, so the ring is never too small
const MIN_MAP_HEIGHT = 320;
function spread(points: MapPoint[], latitudeDelta: number) {
  const byPosition = new Map<string, MapPoint[]>();
  for (const point of points) {
    const key = `${point.latitude.toFixed(5)}:${point.longitude.toFixed(5)}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), point]);
  }
  return Array.from(byPosition.values()).flatMap((same) => {
    if (same.length === 1) return same;
    const pixels = 23 / Math.sin(Math.PI / same.length);
    const radius = (latitudeDelta * pixels) / MIN_MAP_HEIGHT;
    return same.map((point, index) => {
      const angle = (2 * Math.PI * index) / same.length;
      return {
        ...point,
        latitude: point.latitude + radius * Math.sin(angle),
        longitude:
          point.longitude +
          (radius * Math.cos(angle)) /
            Math.cos((point.latitude * Math.PI) / 180),
      };
    });
  });
}

export function mapGroups(points: MapPoint[], view: Viewport) {
  const { latitude, longitude, latitudeDelta, longitudeDelta } = view;
  const south = latitude - latitudeDelta / 2;
  const west = longitude - longitudeDelta / 2;
  const groups = new Map<string, MapPoint[]>();

  for (const point of points) {
    const x = (point.longitude - west) / longitudeDelta;
    const y = (point.latitude - south) / latitudeDelta;
    if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const cell = `cell:${Math.floor(x * 8)}:${Math.floor(y * 8)}`;
    const group = groups.get(cell);
    if (group) group.push(point);
    else groups.set(cell, [point]);
  }

  // close in, every vehicle gets its own pin. spread across the whole view,
  // not per cell, so coincident pins either side of a cell edge still fan out
  if (latitudeDelta < 0.012) {
    return spread(Array.from(groups.values()).flat(), latitudeDelta).map(
      (point) => ({ ...point, key: point.id, count: 1 }),
    );
  }

  return Array.from(groups).flatMap(([cell, group]) => {
    if (group.length === 1) {
      return group.map((point) => ({ ...point, key: point.id, count: 1 }));
    }
    // key clusters by grid cell so they don't remount when vehicles reorder
    const first = group[0];
    return [
      {
        ...first,
        key: cell,
        latitude:
          group.reduce((sum, point) => sum + point.latitude, 0) / group.length,
        longitude:
          group.reduce((sum, point) => sum + point.longitude, 0) / group.length,
        count: group.length,
      },
    ];
  });
}
