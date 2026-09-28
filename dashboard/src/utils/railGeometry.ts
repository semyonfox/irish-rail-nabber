import railNetworkUrl from "../assets/rail-network.geojson?url";

export type RailCoordinate = [number, number];

export interface RailFeatureCollection {
  metadata?: { outputCrs?: string };
  features: Array<{
    geometry: {
      type: "LineString" | "MultiLineString";
      coordinates: number[][] | number[][][];
    } | null;
  }>;
}

const MAX_SNAP_DISTANCE_METERS = 600;
const COORDINATE_PRECISION = 6;
const METERS_PER_DEGREE = 111_320;

let railLinesPromise: Promise<RailCoordinate[][]> | null = null;

interface RailEdge {
  node: number;
  distance: number;
}

interface RailSegment {
  from: number;
  to: number;
  distance: number;
}

interface RailGraph {
  coordinates: RailCoordinate[];
  edges: RailEdge[][];
  segments: RailSegment[];
  routeCache: Map<string, RailCoordinate[]>;
}

interface SegmentMatch extends RailSegment {
  segment: number;
  fraction: number;
  coordinate: RailCoordinate;
  snapDistance: number;
}

interface HeapEntry {
  node: number;
  distance: number;
}

class MinHeap {
  private readonly entries: HeapEntry[] = [];

  get size() {
    return this.entries.length;
  }

  push(entry: HeapEntry) {
    const entries = this.entries;
    entries.push(entry);
    let index = entries.length - 1;

    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (entries[parent].distance <= entry.distance) break;
      entries[index] = entries[parent];
      index = parent;
    }
    entries[index] = entry;
  }

  pop() {
    const entries = this.entries;
    const first = entries[0];
    const last = entries.pop();
    if (entries.length === 0 || !last) return first;

    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= entries.length) break;
      const child =
        right < entries.length && entries[right].distance < entries[left].distance ? right : left;
      if (entries[child].distance >= last.distance) break;
      entries[index] = entries[child];
      index = child;
    }
    entries[index] = last;
    return first;
  }
}

const railGraphCache = new WeakMap<RailCoordinate[][], RailGraph>();

function coordinateKey([longitude, latitude]: RailCoordinate) {
  return `${longitude.toFixed(COORDINATE_PRECISION)},${latitude.toFixed(COORDINATE_PRECISION)}`;
}

function distanceMeters(from: RailCoordinate, to: RailCoordinate) {
  const latitude = ((from[1] + to[1]) / 2) * (Math.PI / 180);
  const east = (to[0] - from[0]) * METERS_PER_DEGREE * Math.cos(latitude);
  const north = (to[1] - from[1]) * METERS_PER_DEGREE;
  return Math.hypot(east, north);
}

function closestPointOnSegment(point: RailCoordinate, from: RailCoordinate, to: RailCoordinate) {
  const latitude = ((point[1] + from[1] + to[1]) / 3) * (Math.PI / 180);
  const longitudeScale = METERS_PER_DEGREE * Math.cos(latitude);
  const east = (to[0] - from[0]) * longitudeScale;
  const north = (to[1] - from[1]) * METERS_PER_DEGREE;
  const pointEast = (point[0] - from[0]) * longitudeScale;
  const pointNorth = (point[1] - from[1]) * METERS_PER_DEGREE;
  const lengthSquared = east * east + north * north;
  const fraction = lengthSquared
    ? Math.max(0, Math.min(1, (pointEast * east + pointNorth * north) / lengthSquared))
    : 0;
  const coordinate: RailCoordinate = [
    from[0] + fraction * (to[0] - from[0]),
    from[1] + fraction * (to[1] - from[1]),
  ];

  return {
    fraction,
    coordinate,
    distance: Math.hypot(pointEast - fraction * east, pointNorth - fraction * north),
  };
}

function buildRailGraph(lines: RailCoordinate[][]): RailGraph {
  const cached = railGraphCache.get(lines);
  if (cached) return cached;

  const coordinates: RailCoordinate[] = [];
  const edges: RailEdge[][] = [];
  const segments: RailSegment[] = [];
  const nodeByCoordinate = new Map<string, number>();
  const edgeKeys = new Set<string>();

  const nodeFor = (coordinate: RailCoordinate) => {
    const key = coordinateKey(coordinate);
    const existing = nodeByCoordinate.get(key);
    if (existing !== undefined) return existing;

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
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);

      const distance = distanceMeters(coordinates[from], coordinates[to]);
      edges[from].push({ node: to, distance });
      edges[to].push({ node: from, distance });
      segments.push({ from, to, distance });
    }
  }

  const graph = { coordinates, edges, segments, routeCache: new Map() };
  railGraphCache.set(lines, graph);
  return graph;
}

function closestSegment(graph: RailGraph, point: RailCoordinate): SegmentMatch | null {
  let closest: SegmentMatch | null = null;

  for (let segment = 0; segment < graph.segments.length; segment += 1) {
    const edge = graph.segments[segment];
    const match = closestPointOnSegment(
      point,
      graph.coordinates[edge.from],
      graph.coordinates[edge.to],
    );
    if (closest && closest.snapDistance <= match.distance) continue;
    closest = {
      ...edge,
      segment,
      fraction: match.fraction,
      coordinate: match.coordinate,
      snapDistance: match.distance,
    };
  }

  return closest;
}

function deduplicatePath(path: RailCoordinate[]) {
  return path.filter(
    (coordinate, index) => index === 0 || distanceMeters(coordinate, path[index - 1]) >= 0.5,
  );
}

function shortestPath(graph: RailGraph, start: SegmentMatch, end: SegmentMatch): RailCoordinate[] {
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestEndNode = -1;
  let directPath: RailCoordinate[] | null = null;

  if (start.segment === end.segment) {
    bestDistance = Math.abs(start.fraction - end.fraction) * start.distance;
    directPath = [start.coordinate, end.coordinate];
  }

  const distances = new Float64Array(graph.coordinates.length);
  distances.fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(graph.coordinates.length);
  previous.fill(-1);
  const heap = new MinHeap();

  const seed = (node: number, distance: number) => {
    if (distance >= distances[node]) return;
    distances[node] = distance;
    heap.push({ node, distance });
  };

  seed(start.from, start.fraction * start.distance);
  seed(start.to, (1 - start.fraction) * start.distance);

  while (heap.size > 0) {
    const current = heap.pop();
    if (!current) break;
    if (current.distance !== distances[current.node]) continue;
    if (current.distance >= bestDistance) break;

    if (current.node === end.from || current.node === end.to) {
      const finalEdgeDistance =
        current.node === end.from ? end.fraction * end.distance : (1 - end.fraction) * end.distance;
      const candidate = current.distance + finalEdgeDistance;
      if (candidate < bestDistance) {
        bestDistance = candidate;
        bestEndNode = current.node;
        directPath = null;
      }
    }

    for (const edge of graph.edges[current.node]) {
      const candidate = current.distance + edge.distance;
      if (candidate >= distances[edge.node] || candidate >= bestDistance) continue;
      distances[edge.node] = candidate;
      previous[edge.node] = current.node;
      heap.push({ node: edge.node, distance: candidate });
    }
  }

  if (directPath) return deduplicatePath(directPath);
  if (bestEndNode === -1) return [];

  const nodes = [];
  for (let node = bestEndNode; node !== -1; node = previous[node]) nodes.push(node);
  nodes.reverse();
  return deduplicatePath([
    start.coordinate,
    ...nodes.map((node) => graph.coordinates[node]),
    end.coordinate,
  ]);
}

function validCoordinate(coordinate: number[]): coordinate is RailCoordinate {
  return (
    coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1]) &&
    coordinate[0] >= -11 &&
    coordinate[0] <= -5 &&
    coordinate[1] >= 51 &&
    coordinate[1] <= 56
  );
}

export function railLinesFromCollection(collection: RailFeatureCollection) {
  if (collection.metadata?.outputCrs && collection.metadata.outputCrs !== "EPSG:4326") {
    throw new Error(`Unsupported rail geometry CRS: ${collection.metadata.outputCrs}`);
  }

  return collection.features.flatMap((feature) => {
    if (!feature.geometry) return [];
    const sourceLines =
      feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates as number[][]]
        : (feature.geometry.coordinates as number[][][]);

    return sourceLines
      .map((line) => line.filter(validCoordinate))
      .filter((line): line is RailCoordinate[] => line.length >= 2);
  });
}

export function loadRailLines() {
  railLinesPromise ??= fetch(railNetworkUrl).then(async (response) => {
    if (!response.ok) throw new Error("Rail geometry could not be loaded");
    return railLinesFromCollection((await response.json()) as RailFeatureCollection);
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

  const cacheKey = `${coordinateKey(from)}>${coordinateKey(to)}`;
  const cached = graph.routeCache.get(cacheKey);
  if (cached) return cached.length > 0 || !allowFallback ? cached : [from, to];

  const fromMatch = closestSegment(graph, from);
  const toMatch = closestSegment(graph, to);
  if (
    !fromMatch ||
    !toMatch ||
    fromMatch.snapDistance > MAX_SNAP_DISTANCE_METERS ||
    toMatch.snapDistance > MAX_SNAP_DISTANCE_METERS
  ) {
    graph.routeCache.set(cacheKey, []);
    return allowFallback ? [from, to] : [];
  }

  const path = shortestPath(graph, fromMatch, toMatch);
  graph.routeCache.set(cacheKey, path);
  graph.routeCache.set(`${coordinateKey(to)}>${coordinateKey(from)}`, [...path].reverse());
  return path.length > 0 || !allowFallback ? path : [from, to];
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
