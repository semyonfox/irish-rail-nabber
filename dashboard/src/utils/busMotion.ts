import type { BusVehicle } from "./busVehicles";

type Coordinate = [number, number];

function distance(a: Coordinate, b: Coordinate) {
  const scale = Math.cos(((a[1] + b[1]) * Math.PI) / 360);
  return Math.hypot((b[0] - a[0]) * scale, b[1] - a[1]) * 111_195;
}

function project(point: Coordinate, line: Coordinate[]) {
  let closest = { distance: Infinity, progress: 0, index: 0, coordinate: point };
  let progress = 0;
  for (let index = 0; index < line.length - 1; index++) {
    const a = line[index];
    const b = line[index + 1];
    const scale = Math.cos((point[1] * Math.PI) / 180);
    const dx = (b[0] - a[0]) * scale;
    const dy = b[1] - a[1];
    const length = distance(a, b);
    const fraction = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy) || 0,
      ),
    );
    const coordinate: Coordinate = [a[0] + (b[0] - a[0]) * fraction, a[1] + dy * fraction];
    const offset = distance(point, coordinate);
    if (offset < closest.distance) {
      closest = { distance: offset, progress: progress + length * fraction, index, coordinate };
    }
    progress += length;
  }
  return closest;
}

// Animate only between two reports on the same trip's exact shape. Never predict
// travel from a compass bearing or pick another direction's representative route.
export function busMotionPath(
  previous: BusVehicle | undefined,
  current: BusVehicle,
  line: Coordinate[] | undefined,
  now = Date.now(),
): Coordinate[] | null {
  if (
    !previous ||
    !line ||
    line.length < 2 ||
    !current.tripId ||
    !current.shapeId ||
    previous.tripId !== current.tripId ||
    previous.shapeId !== current.shapeId
  )
    return null;
  const before = Date.parse(previous.sourceTimestamp ?? previous.fetchedAt);
  const after = Date.parse(current.sourceTimestamp ?? current.fetchedAt);
  const elapsed = (after - before) / 1_000;
  if (
    !Number.isFinite(elapsed) ||
    elapsed <= 0 ||
    elapsed > 300 ||
    now < after ||
    now - after >= 180_000
  )
    return null;
  const from: Coordinate = [previous.longitude, previous.latitude];
  const to: Coordinate = [current.longitude, current.latitude];
  if (distance(from, to) < 2) return null;
  const start = project(from, line);
  const end = project(to, line);
  const travel = end.progress - start.progress;
  // Large offsets, backward progress and implausible jumps indicate a diversion,
  // ambiguous loop, poor GPS or a changed trip. Display the report directly.
  if (start.distance > 100 || end.distance > 100 || travel <= 0 || travel > elapsed * 40)
    return null;
  return [
    from,
    start.coordinate,
    ...line.slice(start.index + 1, end.index + 1),
    end.coordinate,
    to,
  ];
}

export function busMotionPosition(path: Coordinate[], fraction: number): Coordinate {
  if (fraction <= 0) return path[0];
  if (fraction >= 1) return path[path.length - 1];
  const lengths = path.slice(1).map((point, index) => distance(path[index], point));
  let remaining = lengths.reduce((sum, length) => sum + length, 0) * fraction;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (length > 0 && remaining <= length) {
      const a = path[index];
      const b = path[index + 1];
      return [
        a[0] + ((b[0] - a[0]) * remaining) / length,
        a[1] + ((b[1] - a[1]) * remaining) / length,
      ];
    }
    remaining -= length;
  }
  return path[path.length - 1];
}
