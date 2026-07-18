import proj4 from "proj4";

import railNetworkUrl from "../assets/rail-network.geojson?url";

export type RailCoordinate = [number, number];

interface RailFeatureCollection {
  features: Array<{
    geometry: {
      type: "LineString" | "MultiLineString";
      coordinates: number[][] | number[][][];
    } | null;
  }>;
}

const IRISH_GRID =
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m +no_defs";
const MAX_SNAP_DISTANCE_SQUARED = 0.055 ** 2;

let railLinesPromise: Promise<RailCoordinate[][]> | null = null;

function distanceSquared(a: RailCoordinate, b: RailCoordinate) {
  const latitudeScale = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dx = (a[0] - b[0]) * latitudeScale;
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function closestVertex(line: RailCoordinate[], point: RailCoordinate) {
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;

  for (let candidate = 0; candidate < line.length; candidate += 1) {
    const candidateDistance = distanceSquared(line[candidate], point);
    if (candidateDistance < distance) {
      index = candidate;
      distance = candidateDistance;
    }
  }

  return { index, distance };
}

function convertLine(coordinates: number[][]): RailCoordinate[] {
  return coordinates.map(
    ([east, north]) => proj4(IRISH_GRID, "EPSG:4326", [east, north]) as RailCoordinate,
  );
}

function collectionLines(collection: RailFeatureCollection) {
  return collection.features.flatMap((feature) => {
    if (!feature.geometry) return [];
    if (feature.geometry.type === "LineString") {
      return [convertLine(feature.geometry.coordinates as number[][])];
    }
    return (feature.geometry.coordinates as number[][][]).map(convertLine);
  });
}

export function loadRailLines() {
  railLinesPromise ??= fetch(railNetworkUrl).then(async (response) => {
    if (!response.ok) throw new Error("Rail geometry could not be loaded");
    return collectionLines((await response.json()) as RailFeatureCollection);
  });

  return railLinesPromise;
}

export function trackPathBetween(
  lines: RailCoordinate[][],
  from: RailCoordinate,
  to: RailCoordinate,
  allowFallback = true,
): RailCoordinate[] {
  let best: { line: RailCoordinate[]; fromIndex: number; toIndex: number; score: number } | null =
    null;

  for (const line of lines) {
    if (line.length < 2) continue;
    const fromMatch = closestVertex(line, from);
    const toMatch = closestVertex(line, to);
    const score = fromMatch.distance + toMatch.distance;
    if (!best || score < best.score) {
      best = { line, fromIndex: fromMatch.index, toIndex: toMatch.index, score };
    }
  }

  if (!best || best.score > MAX_SNAP_DISTANCE_SQUARED * 2) {
    return allowFallback ? [from, to] : [];
  }

  const start = Math.min(best.fromIndex, best.toIndex);
  const end = Math.max(best.fromIndex, best.toIndex);
  const trackSection = best.line.slice(start, end + 1);
  if (best.fromIndex > best.toIndex) trackSection.reverse();

  return [from, ...trackSection, to];
}

export function trackPathThrough(lines: RailCoordinate[][], stops: RailCoordinate[]) {
  if (stops.length < 2) return stops;

  return stops.slice(1).reduce<RailCoordinate[]>(
    (path, stop, index) => {
      const section = trackPathBetween(lines, stops[index], stop);
      return [...path, ...section.slice(1)];
    },
    [stops[0]],
  );
}
