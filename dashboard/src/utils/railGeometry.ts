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
const COORDINATE_PRECISION = 6;

let railLinesPromise: Promise<RailCoordinate[][]> | null = null;

interface RailGraph {
  coordinates: RailCoordinate[];
  edges: Array<Array<{ node: number; distance: number }>>;
}

const railGraphCache = new WeakMap<RailCoordinate[][], RailGraph>();

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

function coordinateKey([longitude, latitude]: RailCoordinate) {
  return `${longitude.toFixed(COORDINATE_PRECISION)},${latitude.toFixed(COORDINATE_PRECISION)}`;
}

function buildRailGraph(lines: RailCoordinate[][]): RailGraph {
  const cached = railGraphCache.get(lines);
  if (cached) return cached;

  const coordinates: RailCoordinate[] = [];
  const edges: RailGraph["edges"] = [];
  const nodeByCoordinate = new Map<string, number>();

  const nodeFor = (coordinate: RailCoordinate) => {
    const key = coordinateKey(coordinate);
    const existing = nodeByCoordinate.get(key);
    if (existing != null) return existing;

    const node = coordinates.length;
    nodeByCoordinate.set(key, node);
    coordinates.push(coordinate);
    edges.push([]);
    return node;
  };

  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const from = nodeFor(line[index - 1]);
      const to = nodeFor(line[index]);
      if (from === to) continue;
      const distance = Math.sqrt(distanceSquared(coordinates[from], coordinates[to]));
      edges[from].push({ node: to, distance });
      edges[to].push({ node: from, distance });
    }
  }

  const graph = { coordinates, edges };
  railGraphCache.set(lines, graph);
  return graph;
}

function closestNode(graph: RailGraph, point: RailCoordinate) {
  return closestVertex(graph.coordinates, point);
}

function shortestPath(graph: RailGraph, start: number, end: number) {
  const distances = new Float64Array(graph.coordinates.length);
  distances.fill(Number.POSITIVE_INFINITY);
  distances[start] = 0;

  const previous = new Int32Array(graph.coordinates.length);
  previous.fill(-1);
  const visited = new Uint8Array(graph.coordinates.length);

  for (;;) {
    let current = -1;
    let currentDistance = Number.POSITIVE_INFINITY;
    for (let node = 0; node < distances.length; node += 1) {
      if (!visited[node] && distances[node] < currentDistance) {
        current = node;
        currentDistance = distances[node];
      }
    }

    if (current === -1) return [];
    if (current === end) break;
    visited[current] = 1;

    for (const edge of graph.edges[current]) {
      const candidate = currentDistance + edge.distance;
      if (candidate < distances[edge.node]) {
        distances[edge.node] = candidate;
        previous[edge.node] = current;
      }
    }
  }

  const path: number[] = [];
  for (let node = end; node !== -1; node = previous[node]) path.push(node);
  path.reverse();
  return path;
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
  allowFallback = false,
): RailCoordinate[] {
  const graph = buildRailGraph(lines);
  if (graph.coordinates.length === 0) return allowFallback ? [from, to] : [];

  const fromMatch = closestNode(graph, from);
  const toMatch = closestNode(graph, to);
  if (
    fromMatch.distance > MAX_SNAP_DISTANCE_SQUARED ||
    toMatch.distance > MAX_SNAP_DISTANCE_SQUARED
  ) {
    return allowFallback ? [from, to] : [];
  }

  const path = shortestPath(graph, fromMatch.index, toMatch.index);
  if (path.length === 0) return allowFallback ? [from, to] : [];

  return path.map((node) => graph.coordinates[node]);
}

export function trackPathThrough(lines: RailCoordinate[][], stops: RailCoordinate[]) {
  if (stops.length < 2) return stops;

  const path: RailCoordinate[] = [];
  for (let index = 1; index < stops.length; index += 1) {
    const section = trackPathBetween(lines, stops[index - 1], stops[index]);
    if (section.length === 0) return [];
    path.push(...(path.length === 0 ? section : section.slice(1)));
  }
  return path;
}
