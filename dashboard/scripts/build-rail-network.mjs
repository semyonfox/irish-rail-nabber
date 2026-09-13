#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import proj4 from "proj4";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");
const SOURCE_PATH = path.join(
  REPOSITORY_ROOT,
  "data/Rail_Network_Segment_-1920460442717953162.geojson",
);
const STATIONS_PATH = path.join(REPOSITORY_ROOT, "network_graphs/irish_rail_stations.json");
const OUTPUT_PATH = path.join(SCRIPT_DIR, "../src/assets/rail-network.geojson");

const IRISH_GRID =
  "+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m +no_defs";
const QUANTIZATION_METERS = 2;
const SIMPLIFICATION_TOLERANCE_METERS = 12;
const STATION_SNAP_MAX_METERS = 600;
const STATION_DEDUP_METERS = 100;
const SPATIAL_CELL_METERS = 1_000;
const OUTPUT_DECIMALS = 6;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function edgeKey(from, to) {
  return from < to ? `${from}:${to}` : `${to}:${from}`;
}

function quantizedKey([east, north]) {
  return `${Math.round(east / QUANTIZATION_METERS)},${Math.round(north / QUANTIZATION_METERS)}`;
}

function buildGraph(collection) {
  const nodeByKey = new Map();
  const coordinates = [];
  const neighbours = [];
  let inputVertices = 0;

  const nodeFor = (coordinate) => {
    const key = quantizedKey(coordinate);
    const existing = nodeByKey.get(key);
    if (existing !== undefined) return existing;

    const [gridEast, gridNorth] = key.split(",").map(Number);
    const node = coordinates.length;
    nodeByKey.set(key, node);
    coordinates.push([gridEast * QUANTIZATION_METERS, gridNorth * QUANTIZATION_METERS]);
    neighbours.push(new Set());
    return node;
  };

  for (const feature of collection.features) {
    if (feature.geometry?.type !== "LineString") continue;
    const line = feature.geometry.coordinates;
    inputVertices += line.length;

    for (let index = 1; index < line.length; index += 1) {
      const from = nodeFor(line[index - 1]);
      const to = nodeFor(line[index]);
      if (from === to) continue;
      neighbours[from].add(to);
      neighbours[to].add(from);
    }
  }

  return { coordinates, neighbours, inputVertices };
}

function largestComponent(neighbours) {
  const component = new Int32Array(neighbours.length);
  component.fill(-1);

  let largestId = -1;
  let largestSize = 0;
  let componentCount = 0;

  for (let start = 0; start < neighbours.length; start += 1) {
    if (component[start] !== -1) continue;

    const id = componentCount;
    componentCount += 1;
    const queue = [start];
    component[start] = id;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      for (const next of neighbours[queue[cursor]]) {
        if (component[next] !== -1) continue;
        component[next] = id;
        queue.push(next);
      }
    }

    if (queue.length > largestSize) {
      largestId = id;
      largestSize = queue.length;
    }
  }

  const retained = new Uint8Array(neighbours.length);
  for (let node = 0; node < component.length; node += 1) {
    if (component[node] === largestId) retained[node] = 1;
  }

  return { retained, componentCount, largestSize };
}

function spatialKey([east, north]) {
  return `${Math.floor(east / SPATIAL_CELL_METERS)},${Math.floor(north / SPATIAL_CELL_METERS)}`;
}

function buildSpatialIndex(coordinates, retained) {
  const cells = new Map();
  for (let node = 0; node < coordinates.length; node += 1) {
    if (!retained[node]) continue;
    const key = spatialKey(coordinates[node]);
    const nodes = cells.get(key);
    if (nodes) nodes.push(node);
    else cells.set(key, [node]);
  }
  return cells;
}

function nearestNode(point, coordinates, cells) {
  const cellEast = Math.floor(point[0] / SPATIAL_CELL_METERS);
  const cellNorth = Math.floor(point[1] / SPATIAL_CELL_METERS);
  const radius = Math.ceil(STATION_SNAP_MAX_METERS / SPATIAL_CELL_METERS) + 1;
  let bestNode = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let east = cellEast - radius; east <= cellEast + radius; east += 1) {
    for (let north = cellNorth - radius; north <= cellNorth + radius; north += 1) {
      for (const node of cells.get(`${east},${north}`) ?? []) {
        const coordinate = coordinates[node];
        const distance = Math.hypot(point[0] - coordinate[0], point[1] - coordinate[1]);
        if (distance < bestDistance) {
          bestNode = node;
          bestDistance = distance;
        }
      }
    }
  }

  return { node: bestNode, distance: bestDistance };
}

function stationNodes(stations, coordinates, retained) {
  const cells = buildSpatialIndex(coordinates, retained);
  const stationCoordinates = new Set();
  const terminal = new Uint8Array(coordinates.length);
  let mappedStations = 0;

  for (const station of stations) {
    const projected = proj4("EPSG:4326", IRISH_GRID, [station.longitude, station.latitude]);
    const dedupKey = `${Math.round(projected[0] / STATION_DEDUP_METERS)},${Math.round(projected[1] / STATION_DEDUP_METERS)}`;
    if (stationCoordinates.has(dedupKey)) continue;
    stationCoordinates.add(dedupKey);

    const match = nearestNode(projected, coordinates, cells);
    if (match.node === -1 || match.distance > STATION_SNAP_MAX_METERS) continue;
    terminal[match.node] = 1;
    mappedStations += 1;
  }

  return { terminal, mappedStations };
}

function pruneUnservedBranches(neighbours, retained, terminal) {
  const degree = new Int32Array(neighbours.length);
  const queue = [];

  for (let node = 0; node < neighbours.length; node += 1) {
    if (!retained[node]) continue;
    degree[node] = [...neighbours[node]].filter((next) => retained[next]).length;
    if (degree[node] <= 1 && !terminal[node]) queue.push(node);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    if (!retained[node] || terminal[node] || degree[node] > 1) continue;
    retained[node] = 0;

    for (const next of neighbours[node]) {
      if (!retained[next]) continue;
      degree[next] -= 1;
      if (degree[next] <= 1 && !terminal[next]) queue.push(next);
    }
  }

  return degree;
}

function pointSegmentDistance(point, from, to) {
  const deltaEast = to[0] - from[0];
  const deltaNorth = to[1] - from[1];
  const lengthSquared = deltaEast * deltaEast + deltaNorth * deltaNorth;
  const fraction = lengthSquared
    ? Math.max(
        0,
        Math.min(
          1,
          ((point[0] - from[0]) * deltaEast + (point[1] - from[1]) * deltaNorth) / lengthSquared,
        ),
      )
    : 0;

  return Math.hypot(
    point[0] - from[0] - fraction * deltaEast,
    point[1] - from[1] - fraction * deltaNorth,
  );
}

function simplifyLine(points) {
  if (points.length <= 2) return points;

  const retained = new Uint8Array(points.length);
  retained[0] = 1;
  retained[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let furthestIndex = -1;
    let furthestDistance = 0;

    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistance(points[index], points[start], points[end]);
      if (distance > furthestDistance) {
        furthestDistance = distance;
        furthestIndex = index;
      }
    }

    if (furthestIndex !== -1 && furthestDistance > SIMPLIFICATION_TOLERANCE_METERS) {
      retained[furthestIndex] = 1;
      stack.push([start, furthestIndex], [furthestIndex, end]);
    }
  }

  return points.filter((_, index) => retained[index]);
}

function traceChains(coordinates, neighbours, retained, terminal, degree) {
  const visitedEdges = new Set();
  const lines = [];
  const isAnchor = (node) => degree[node] !== 2 || terminal[node] === 1;

  const trace = (start, next) => {
    const nodes = [start];
    let previous = start;
    let current = next;
    visitedEdges.add(edgeKey(start, next));

    for (;;) {
      nodes.push(current);
      if (current !== start && isAnchor(current)) break;

      const candidates = [...neighbours[current]].filter(
        (candidate) => retained[candidate] && candidate !== previous,
      );
      if (candidates.length !== 1) break;

      const following = candidates[0];
      const key = edgeKey(current, following);
      if (visitedEdges.has(key)) break;
      visitedEdges.add(key);
      previous = current;
      current = following;
    }

    return simplifyLine(nodes.map((node) => coordinates[node]));
  };

  for (let node = 0; node < coordinates.length; node += 1) {
    if (!retained[node] || !isAnchor(node)) continue;
    for (const next of neighbours[node]) {
      if (!retained[next] || visitedEdges.has(edgeKey(node, next))) continue;
      lines.push(trace(node, next));
    }
  }

  // Retain closed loops whose nodes all have degree two.
  for (let node = 0; node < coordinates.length; node += 1) {
    if (!retained[node]) continue;
    for (const next of neighbours[node]) {
      if (!retained[next] || visitedEdges.has(edgeKey(node, next))) continue;
      lines.push(trace(node, next));
    }
  }

  return lines;
}

function roundCoordinate(value) {
  return Number(value.toFixed(OUTPUT_DECIMALS));
}

function toWgs84(lines) {
  return lines
    .map((line) => {
      const converted = simplifyLine(line).map((coordinate) => {
        const [longitude, latitude] = proj4(IRISH_GRID, "EPSG:4326", coordinate);
        return [roundCoordinate(longitude), roundCoordinate(latitude)];
      });

      return converted.filter(
        (coordinate, index) =>
          index === 0 ||
          coordinate[0] !== converted[index - 1][0] ||
          coordinate[1] !== converted[index - 1][1],
      );
    })
    .filter((line) => line.length >= 2);
}

function compareCoordinates(left, right) {
  return left[0] - right[0] || left[1] - right[1];
}

function normalizeLineOrder(lines) {
  for (const line of lines) {
    if (compareCoordinates(line.at(-1), line[0]) < 0) line.reverse();
  }
  lines.sort(
    (left, right) =>
      compareCoordinates(left[0], right[0]) ||
      compareCoordinates(left.at(-1), right.at(-1)) ||
      left.length - right.length,
  );
  return lines;
}

const source = readJson(SOURCE_PATH);
const stations = readJson(STATIONS_PATH);
if (source.crs?.properties?.name !== "EPSG:2157") {
  throw new Error(`Expected EPSG:2157 source geometry, received ${source.crs?.properties?.name}`);
}

const graph = buildGraph(source);
const component = largestComponent(graph.neighbours);
const matchedStations = stationNodes(stations, graph.coordinates, component.retained);
const degree = pruneUnservedBranches(
  graph.neighbours,
  component.retained,
  matchedStations.terminal,
);
const projectedLines = traceChains(
  graph.coordinates,
  graph.neighbours,
  component.retained,
  matchedStations.terminal,
  degree,
);
const lines = normalizeLineOrder(toWgs84(projectedLines));
const retainedNodes = component.retained.reduce((total, value) => total + value, 0);
const outputVertices = lines.reduce((total, line) => total + line.length, 0);

const output = {
  type: "FeatureCollection",
  metadata: {
    source: path.relative(REPOSITORY_ROOT, SOURCE_PATH),
    sourceCrs: "EPSG:2157",
    outputCrs: "EPSG:4326",
    inputFeatures: source.features.length,
    inputVertices: graph.inputVertices,
    sourceComponents: component.componentCount,
    retainedNodes,
    mappedPassengerStations: matchedStations.mappedStations,
    quantizationMeters: QUANTIZATION_METERS,
    simplificationToleranceMeters: SIMPLIFICATION_TOLERANCE_METERS,
    stationSnapMaxMeters: STATION_SNAP_MAX_METERS,
    lineStrings: lines.length,
    outputVertices,
  },
  features: [
    {
      type: "Feature",
      properties: {},
      geometry: { type: "MultiLineString", coordinates: lines },
    },
  ],
};

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output)}\n`);
console.log(
  `rail asset: ${source.features.length} source features -> ${lines.length} lines / ${outputVertices} vertices (${retainedNodes} topology nodes)`,
);
