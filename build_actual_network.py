#!/usr/bin/env python3

import csv
import json
import math
import os
import pickle
import statistics
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx
import psycopg
from pyproj import Transformer

DATA_DIR = Path("./data")
OUTPUT_DIR = Path("./network_graphs")
OUTPUT_DIR.mkdir(exist_ok=True)

STATIONS_FILE = OUTPUT_DIR / "irish_rail_stations.json"
SEGMENTS_FILE = DATA_DIR / "Rail_Network_Segment_-1920460442717953162.geojson"
OUTPUT_BASE = OUTPUT_DIR / "irish_rail_network_actual"

TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:2157", always_xy=True)

SNAP_DISTANCE_METERS = 1800
BBOX_PADDING_METERS = 2500
FALLBACK_NEAREST_KM = 65
STATION_VERTEX_MAX_METERS = 4000
COMPONENT_BRIDGE_MAX_KM = 120
LOW_CONFIDENCE_THRESHOLD = 0.6


def station_node_id(station):
    return f"{station['code']}_{station['name'].replace(' ', '_')}"


def distance(p1, p2):
    dx = p1[0] - p2[0]
    dy = p1[1] - p2[1]
    return math.sqrt(dx * dx + dy * dy)


def composite_confidence(geometry_confidence, coverage_score):
    return round(0.75 * geometry_confidence + 0.25 * coverage_score, 3)


def load_json(path):
    with open(path, "r") as handle:
        return json.load(handle)


def load_stations():
    raw = load_json(STATIONS_FILE)
    stations = []
    by_code = {}
    seen_coords = set()

    for station in raw:
        code = station["code"].strip().upper()
        x, y = TRANSFORMER.transform(station["longitude"], station["latitude"])
        dedup_key = (round(x, -2), round(y, -2))
        if dedup_key in seen_coords:
            continue

        normalized = {
            "code": code,
            "name": station["name"],
            "latitude": station["latitude"],
            "longitude": station["longitude"],
            "projected": (x, y),
        }
        seen_coords.add(dedup_key)
        stations.append(normalized)
        by_code[code] = normalized

    return stations, by_code


def project_onto_segment(point, seg_start, seg_end):
    px, py = point
    x1, y1 = seg_start
    x2, y2 = seg_end
    vx = x2 - x1
    vy = y2 - y1
    denom = vx * vx + vy * vy
    if denom == 0:
        return seg_start, 0.0

    t = ((px - x1) * vx + (py - y1) * vy) / denom
    t = max(0.0, min(1.0, t))
    return (x1 + t * vx, y1 + t * vy), t


def distance_to_polyline_with_offset(point, coords):
    best_distance = float("inf")
    best_offset = 0.0
    walked = 0.0

    for i in range(len(coords) - 1):
        start = coords[i]
        end = coords[i + 1]
        seg_len = distance(start, end)
        projection, t = project_onto_segment(point, start, end)
        d = distance(point, projection)

        if d < best_distance:
            best_distance = d
            best_offset = walked + t * seg_len
        walked += seg_len

    return best_distance, best_offset


def segment_bbox(coords):
    xs = [p[0] for p in coords]
    ys = [p[1] for p in coords]
    return min(xs), min(ys), max(xs), max(ys)


def build_geometry_edges(stations, segments):
    edges = {}

    for feature in segments["features"]:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            continue
        coords = [tuple(c) for c in geometry.get("coordinates", [])]
        if len(coords) < 2:
            continue

        min_x, min_y, max_x, max_y = segment_bbox(coords)
        candidates = []

        for station in stations:
            sx, sy = station["projected"]
            if (
                sx < min_x - BBOX_PADDING_METERS
                or sx > max_x + BBOX_PADDING_METERS
                or sy < min_y - BBOX_PADDING_METERS
                or sy > max_y + BBOX_PADDING_METERS
            ):
                continue

            d, offset = distance_to_polyline_with_offset(station["projected"], coords)
            if d <= SNAP_DISTANCE_METERS:
                candidates.append((offset, d, station))

        if len(candidates) < 2:
            continue

        candidates.sort(key=lambda item: item[0])
        seen_codes = set()
        ordered = []
        for item in candidates:
            code = item[2]["code"]
            if code in seen_codes:
                continue
            seen_codes.add(code)
            ordered.append(item)

        for i in range(len(ordered) - 1):
            offset_a, dist_a, station_a = ordered[i]
            offset_b, dist_b, station_b = ordered[i + 1]
            if station_a["code"] == station_b["code"]:
                continue

            edge_key = tuple(sorted((station_a["code"], station_b["code"])))
            edge_distance = max(0.05, (offset_b - offset_a) / 1000.0)
            snap_quality = 1.0 - min(
                1.0, (dist_a + dist_b) / (2.0 * SNAP_DISTANCE_METERS)
            )
            confidence = round(0.7 + 0.3 * snap_quality, 3)

            existing = edges.get(edge_key)
            if existing is None or edge_distance < existing["distance_km"]:
                edges[edge_key] = {
                    "from_code": edge_key[0],
                    "to_code": edge_key[1],
                    "distance_km": round(edge_distance, 3),
                    "geometry_confidence": confidence,
                    "snap_distance_m": round((dist_a + dist_b) / 2.0, 1),
                    "derived_from": "segment_adjacency",
                }

    return edges


def add_fallback_edges(physical_edges, stations):
    degrees = Counter()
    for edge in physical_edges.values():
        degrees[edge["from_code"]] += 1
        degrees[edge["to_code"]] += 1

    for station in stations:
        code = station["code"]
        if degrees[code] > 0:
            continue

        nearest_code = None
        nearest_km = float("inf")
        for other in stations:
            other_code = other["code"]
            if other_code == code:
                continue
            km = distance(station["projected"], other["projected"]) / 1000.0
            if km < nearest_km and km <= FALLBACK_NEAREST_KM:
                nearest_km = km
                nearest_code = other_code

        if nearest_code is None:
            continue

        edge_key = tuple(sorted((code, nearest_code)))
        if edge_key in physical_edges:
            continue

        physical_edges[edge_key] = {
            "from_code": edge_key[0],
            "to_code": edge_key[1],
            "distance_km": round(nearest_km, 3),
            "geometry_confidence": 0.72,
            "snap_distance_m": None,
            "derived_from": "topology_fallback",
        }

    return physical_edges


def extract_unique_vertices(segments):
    points = {}
    for feature in segments["features"]:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "LineString":
            continue
        for coord in geometry.get("coordinates", []):
            key = (round(coord[0], 1), round(coord[1], 1))
            points[key] = key
    return list(points.values())


def build_vertex_spatial_index(vertices, cell_size=2000.0):
    grid = defaultdict(list)
    for coord in vertices:
        cell = (int(coord[0] // cell_size), int(coord[1] // cell_size))
        grid[cell].append(coord)
    return grid, cell_size


def nearest_vertex(point, vertices, grid, cell_size):
    center = (int(point[0] // cell_size), int(point[1] // cell_size))
    best_coord = None
    best_distance = float("inf")

    for ring in range(8):
        found = False
        for dx in range(-ring, ring + 1):
            for dy in range(-ring, ring + 1):
                if ring > 0 and abs(dx) != ring and abs(dy) != ring:
                    continue
                cell = (center[0] + dx, center[1] + dy)
                for coord in grid.get(cell, []):
                    found = True
                    d = distance(point, coord)
                    if d < best_distance:
                        best_distance = d
                        best_coord = coord
        if found and best_distance <= (ring + 1) * cell_size:
            break

    if best_coord is None:
        for coord in vertices:
            d = distance(point, coord)
            if d < best_distance:
                best_distance = d
                best_coord = coord

    return best_coord, best_distance


def map_stations_to_vertices(stations, vertices):
    grid, cell_size = build_vertex_spatial_index(vertices)
    mapping = {}
    for station in stations:
        coord, d = nearest_vertex(station["projected"], vertices, grid, cell_size)
        if coord is None or d > STATION_VERTEX_MAX_METERS:
            continue
        mapping[station["code"]] = {"coord": coord, "distance_m": round(d, 1)}
    return mapping


def add_component_bridges(
    physical_edges, stations, service_evidence, station_vertex_map
):
    stations_by_code = {station["code"]: station for station in stations}
    rail_graph = nx.Graph()
    rail_graph.add_nodes_from(stations_by_code.keys())
    for edge in physical_edges.values():
        rail_graph.add_edge(edge["from_code"], edge["to_code"])

    while True:
        components = [set(c) for c in nx.connected_components(rail_graph)]
        if len(components) <= 1:
            break

        best_bridge = None
        for i in range(len(components)):
            for j in range(i + 1, len(components)):
                left = [code for code in components[i] if code in station_vertex_map]
                right = [code for code in components[j] if code in station_vertex_map]
                if not left or not right:
                    continue

                for code_a in left:
                    for code_b in right:
                        edge_key = tuple(sorted((code_a, code_b)))
                        if edge_key in physical_edges:
                            continue
                        km = (
                            distance(
                                stations_by_code[code_a]["projected"],
                                stations_by_code[code_b]["projected"],
                            )
                            / 1000.0
                        )
                        if km > COMPONENT_BRIDGE_MAX_KM:
                            continue
                        if best_bridge is None or km < best_bridge[0]:
                            best_bridge = (km, code_a, code_b)

        if best_bridge is None:
            break

        km, code_a, code_b = best_bridge
        edge_key = tuple(sorted((code_a, code_b)))
        physical_edges[edge_key] = {
            "from_code": edge_key[0],
            "to_code": edge_key[1],
            "distance_km": round(km, 3),
            "geometry_confidence": 0.71,
            "snap_distance_m": round(
                (
                    station_vertex_map[code_a]["distance_m"]
                    + station_vertex_map[code_b]["distance_m"]
                )
                / 2.0,
                1,
            ),
            "derived_from": "geometry_component_bridge",
        }
        rail_graph.add_edge(edge_key[0], edge_key[1])

    component_id = {}
    for idx, nodes in enumerate(nx.connected_components(rail_graph)):
        for node in nodes:
            component_id[node] = idx

    service_candidates = []
    for edge_key, metrics in service_evidence.items():
        a, b = edge_key
        if edge_key in physical_edges:
            continue
        if component_id.get(a) is None or component_id.get(b) is None:
            continue
        if component_id[a] == component_id[b]:
            continue
        if metrics["trips_observed"] < 20:
            continue
        service_candidates.append((metrics["trips_observed"], edge_key))

    service_candidates.sort(reverse=True)
    for _, edge_key in service_candidates:
        a, b = edge_key
        if component_id.get(a) == component_id.get(b):
            continue

        km = (
            distance(stations_by_code[a]["projected"], stations_by_code[b]["projected"])
            / 1000.0
        )
        physical_edges[edge_key] = {
            "from_code": edge_key[0],
            "to_code": edge_key[1],
            "distance_km": round(km, 3),
            "geometry_confidence": 0.68,
            "snap_distance_m": None,
            "derived_from": "service_bridge",
        }
        rail_graph.add_edge(edge_key[0], edge_key[1])

        component_id = {}
        for idx, nodes in enumerate(nx.connected_components(rail_graph)):
            for node in nodes:
                component_id[node] = idx
        if len(set(component_id.values())) <= 1:
            break

    return physical_edges


def get_database_url():
    return os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@server:9898/ireland_public",
    )


def load_service_evidence(station_codes):
    query = """
    WITH latest_movements AS (
        SELECT
            train_code,
            train_date,
            UPPER(TRIM(location_code)) AS station_code,
            location_order,
            location_type,
            scheduled_arrival,
            actual_arrival,
            actual_departure,
            expected_arrival,
            fetched_at,
            ROW_NUMBER() OVER (
                PARTITION BY train_code, train_date, location_order
                ORDER BY fetched_at DESC
            ) AS rn
        FROM train_movements
        WHERE location_code IS NOT NULL
          AND location_type <> 'T'
    ),
    dedup AS (
        SELECT *
        FROM latest_movements
        WHERE rn = 1
    ),
    pairs AS (
        SELECT
            a.station_code AS from_code,
            b.station_code AS to_code,
            EXTRACT(EPOCH FROM (
                COALESCE(b.actual_arrival, b.expected_arrival) - a.actual_departure
            )) / 60.0 AS runtime_min,
            CASE
                WHEN b.actual_arrival IS NULL OR b.scheduled_arrival IS NULL THEN NULL
                WHEN b.actual_arrival <= b.scheduled_arrival + INTERVAL '5 minutes' THEN 1.0
                ELSE 0.0
            END AS on_time_flag
        FROM dedup a
        JOIN dedup b
          ON a.train_code = b.train_code
         AND a.train_date = b.train_date
         AND b.location_order = a.location_order + 1
        WHERE a.station_code = ANY(%s)
          AND b.station_code = ANY(%s)
          AND a.station_code <> b.station_code
    )
    SELECT
        LEAST(from_code, to_code) AS code_a,
        GREATEST(from_code, to_code) AS code_b,
        COUNT(*)::INT AS trips_observed,
        AVG(runtime_min) FILTER (WHERE runtime_min > 0 AND runtime_min < 240) AS avg_runtime_min,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY runtime_min)
            FILTER (WHERE runtime_min > 0 AND runtime_min < 240) AS median_runtime_min,
        AVG(on_time_flag) AS on_time_rate,
        COUNT(*) FILTER (WHERE from_code < to_code)::INT AS direction_a_to_b,
        COUNT(*) FILTER (WHERE from_code > to_code)::INT AS direction_b_to_a
    FROM pairs
    GROUP BY 1, 2
    """

    evidence = {}
    try:
        with psycopg.connect(get_database_url()) as conn:
            with conn.cursor() as cursor:
                cursor.execute(query, (station_codes, station_codes))
                rows = cursor.fetchall()
    except Exception as error:
        print(f"warning: could not load ATA evidence from DB: {error}")
        return evidence

    for row in rows:
        edge_key = (row[0], row[1])
        trips = int(row[2] or 0)
        dir_a = int(row[6] or 0)
        dir_b = int(row[7] or 0)
        direction_balance = 0.0
        if trips > 0:
            direction_balance = 1.0 - abs(dir_a - dir_b) / float(trips)

        coverage = round(0.7 * min(1.0, trips / 40.0) + 0.3 * direction_balance, 3)
        evidence[edge_key] = {
            "trips_observed": trips,
            "median_runtime_min": round(float(row[4]), 2)
            if row[4] is not None
            else None,
            "avg_runtime_min": round(float(row[3]), 2) if row[3] is not None else None,
            "on_time_rate": round(float(row[5]), 3) if row[5] is not None else None,
            "direction_balance": round(direction_balance, 3),
            "ata_coverage_score": coverage,
        }

    return evidence


def build_multilayer_graph(stations, physical_edges, service_evidence):
    graph = nx.MultiGraph()
    code_to_node = {}

    for station in stations:
        node = station_node_id(station)
        graph.add_node(
            node,
            station_code=station["code"],
            name=station["name"],
            latitude=station["latitude"],
            longitude=station["longitude"],
        )
        code_to_node[station["code"]] = node

    for edge_key, edge in physical_edges.items():
        a, b = edge_key
        if a not in code_to_node or b not in code_to_node:
            continue

        evidence = service_evidence.get(edge_key)
        coverage = evidence["ata_coverage_score"] if evidence else 0.0

        graph.add_edge(
            code_to_node[a],
            code_to_node[b],
            key="rail_edge",
            edge_type="rail_edge",
            distance_km=edge["distance_km"],
            geometry_confidence=edge["geometry_confidence"],
            snap_distance_m=edge["snap_distance_m"],
            composite_confidence=composite_confidence(
                edge["geometry_confidence"], coverage
            ),
            source="geojson",
            derived_from=edge["derived_from"],
            track_count=None,
        )

        if evidence:
            graph.add_edge(
                code_to_node[a],
                code_to_node[b],
                key="service_edge",
                edge_type="service_edge",
                trips_observed=evidence["trips_observed"],
                median_runtime_min=evidence["median_runtime_min"],
                avg_runtime_min=evidence["avg_runtime_min"],
                on_time_rate=evidence["on_time_rate"],
                direction_balance=evidence["direction_balance"],
                ata_coverage_score=evidence["ata_coverage_score"],
                source="historic_ata",
            )

    return graph


def build_rail_graph_from_multigraph(graph):
    rail_graph = nx.Graph()
    rail_graph.add_nodes_from(graph.nodes(data=True))
    for u, v, data in graph.edges(data=True):
        if data.get("edge_type") == "rail_edge":
            rail_graph.add_edge(u, v, **data)
    return rail_graph


def write_confidence_csv(stations, physical_edges, service_evidence):
    stations_by_code = {station["code"]: station for station in stations}
    output_path = OUTPUT_DIR / "irish_rail_network_actual_confidence.csv"

    with open(output_path, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "from_code",
                "from_name",
                "to_code",
                "to_name",
                "distance_km",
                "geometry_confidence",
                "ata_coverage_score",
                "composite_confidence",
                "trips_observed",
                "on_time_rate",
                "derived_from",
            ]
        )

        for edge_key in sorted(physical_edges.keys()):
            edge = physical_edges[edge_key]
            evidence = service_evidence.get(edge_key)
            coverage = evidence["ata_coverage_score"] if evidence else 0.0
            writer.writerow(
                [
                    edge["from_code"],
                    stations_by_code[edge["from_code"]]["name"],
                    edge["to_code"],
                    stations_by_code[edge["to_code"]]["name"],
                    edge["distance_km"],
                    edge["geometry_confidence"],
                    coverage,
                    composite_confidence(edge["geometry_confidence"], coverage),
                    evidence["trips_observed"] if evidence else 0,
                    evidence["on_time_rate"] if evidence else None,
                    edge["derived_from"],
                ]
            )


def write_stats(graph, physical_edges, service_evidence):
    rail_graph = build_rail_graph_from_multigraph(graph)
    ata_matched_edges = sum(
        1 for edge_key in physical_edges if edge_key in service_evidence
    )
    ata_low_coverage_edges = sum(
        1
        for edge_key in physical_edges
        if edge_key in service_evidence
        and service_evidence[edge_key]["ata_coverage_score"] < 0.4
    )
    service_pairs_off_topology = sum(
        1 for edge_key in service_evidence if edge_key not in physical_edges
    )
    edge_sources = Counter(edge["derived_from"] for edge in physical_edges.values())

    stats = {
        "num_stations": graph.number_of_nodes(),
        "num_rail_edges": rail_graph.number_of_edges(),
        "num_service_edges": graph.number_of_edges() - rail_graph.number_of_edges(),
        "rail_components": nx.number_connected_components(rail_graph),
        "rail_density": round(nx.density(rail_graph), 6),
        "ata_matched_edges": ata_matched_edges,
        "ata_unmatched_edges": len(physical_edges) - ata_matched_edges,
        "ata_low_coverage_edges": ata_low_coverage_edges,
        "service_pairs_off_topology": service_pairs_off_topology,
        "rail_edge_sources": dict(edge_sources),
    }

    with open(f"{OUTPUT_BASE}_stats.json", "w") as handle:
        json.dump(stats, handle, indent=2)


def make_gml_safe_multigraph(graph):
    safe = nx.MultiGraph()
    for node, attrs in graph.nodes(data=True):
        safe.add_node(node, **{k: v for k, v in attrs.items() if v is not None})

    for u, v, key, attrs in graph.edges(keys=True, data=True):
        safe.add_edge(
            u, v, key=key, **{k: v for k, v in attrs.items() if v is not None}
        )

    return safe


def write_data_quality_report(
    stations, graph, physical_edges, service_evidence, station_vertex_map
):
    rail_graph = build_rail_graph_from_multigraph(graph)
    stations_by_code = {station["code"]: station["name"] for station in stations}
    node_to_code = {
        node: attrs.get("station_code", node)
        for node, attrs in rail_graph.nodes(data=True)
    }

    components = []
    for nodes in nx.connected_components(rail_graph):
        codes = sorted(node_to_code[node] for node in nodes)
        components.append(codes)
    components.sort(key=len, reverse=True)

    unmapped_station_codes = sorted(
        [
            station["code"]
            for station in stations
            if station["code"] not in station_vertex_map
        ]
    )

    uncovered_edges = sorted(
        [edge_key for edge_key in physical_edges if edge_key not in service_evidence]
    )
    service_off_topology = [
        {
            "from_code": edge_key[0],
            "to_code": edge_key[1],
            "trips_observed": evidence["trips_observed"],
            "ata_coverage_score": evidence["ata_coverage_score"],
        }
        for edge_key, evidence in service_evidence.items()
        if edge_key not in physical_edges
    ]
    service_off_topology.sort(reverse=True, key=lambda item: item["trips_observed"])

    low_confidence_edges = []
    low_confidence_count = 0
    for edge_key, edge in physical_edges.items():
        evidence = service_evidence.get(edge_key)
        coverage = evidence["ata_coverage_score"] if evidence else 0.0
        composite = composite_confidence(edge["geometry_confidence"], coverage)
        if composite < LOW_CONFIDENCE_THRESHOLD:
            low_confidence_count += 1
            low_confidence_edges.append(
                {
                    "from_code": edge_key[0],
                    "to_code": edge_key[1],
                    "distance_km": edge["distance_km"],
                    "geometry_confidence": edge["geometry_confidence"],
                    "ata_coverage_score": coverage,
                    "composite_confidence": composite,
                    "derived_from": edge["derived_from"],
                    "trips_observed": evidence["trips_observed"] if evidence else 0,
                }
            )
    low_confidence_edges.sort(key=lambda item: item["composite_confidence"])

    degree_values = list(dict(rail_graph.degree()).values())
    avg_degree = (
        round(sum(degree_values) / len(degree_values), 3) if degree_values else 0.0
    )
    median_degree = float(statistics.median(degree_values)) if degree_values else 0.0
    max_degree = max(degree_values) if degree_values else 0

    avg_shortest_path = None
    diameter = None
    if components:
        largest_codes = set(components[0])
        largest_nodes = [
            node
            for node, attrs in rail_graph.nodes(data=True)
            if attrs.get("station_code", node) in largest_codes
        ]
        largest_component_graph = rail_graph.subgraph(largest_nodes).copy()
        if largest_component_graph.number_of_nodes() > 1:
            avg_shortest_path = round(
                nx.average_shortest_path_length(largest_component_graph), 3
            )
            diameter = nx.diameter(largest_component_graph)

    report = {
        "summary": {
            "num_stations": graph.number_of_nodes(),
            "num_rail_edges": rail_graph.number_of_edges(),
            "num_service_edges": graph.number_of_edges() - rail_graph.number_of_edges(),
            "rail_components": len(components),
            "ata_covered_physical_edges": len(physical_edges) - len(uncovered_edges),
            "ata_uncovered_physical_edges": len(uncovered_edges),
            "service_pairs_off_topology": len(service_off_topology),
            "stations_not_mapped_to_geometry_vertices": len(unmapped_station_codes),
            "avg_degree": avg_degree,
            "median_degree": median_degree,
            "max_degree": max_degree,
            "avg_shortest_path_largest_component": avg_shortest_path,
            "diameter_largest_component": diameter,
            "low_confidence_physical_edges": low_confidence_count,
        },
        "unmapped_station_codes": unmapped_station_codes,
        "largest_components": [
            {
                "size": len(component),
                "sample_station_codes": component[:8],
                "sample_station_names": [
                    stations_by_code.get(code, code) for code in component[:8]
                ],
            }
            for component in components[:8]
        ],
        "low_confidence_edges": low_confidence_edges[:30],
        "top_service_pairs_off_topology": service_off_topology[:30],
        "sample_ata_uncovered_edges": [
            {
                "from_code": edge_key[0],
                "to_code": edge_key[1],
                "from_name": stations_by_code.get(edge_key[0], edge_key[0]),
                "to_name": stations_by_code.get(edge_key[1], edge_key[1]),
            }
            for edge_key in uncovered_edges[:40]
        ],
    }

    with open(
        OUTPUT_DIR / "irish_rail_network_actual_data_quality.json", "w"
    ) as handle:
        json.dump(report, handle, indent=2)

    summary = report["summary"]
    lines = [
        "# Irish Rail Network Data Quality Report",
        "",
        "## Summary",
        "",
        f"- stations: {summary['num_stations']}",
        f"- physical rail edges: {summary['num_rail_edges']}",
        f"- service edges: {summary['num_service_edges']}",
        f"- physical components: {summary['rail_components']}",
        f"- physical edges without ATA coverage: {summary['ata_uncovered_physical_edges']}",
        f"- service pairs not present in physical topology: {summary['service_pairs_off_topology']}",
        "",
        f"- stations not mapped to geometry vertices: {summary['stations_not_mapped_to_geometry_vertices']}",
        "",
        f"- average degree (physical): {summary['avg_degree']}",
        f"- median degree (physical): {summary['median_degree']}",
        f"- max degree (physical): {summary['max_degree']}",
        f"- average shortest path (largest component): {summary['avg_shortest_path_largest_component']}",
        f"- diameter (largest component): {summary['diameter_largest_component']}",
        f"- low-confidence physical edges (<0.6 composite): {summary['low_confidence_physical_edges']}",
        "",
        "## User-facing caveats",
        "",
        "- geometry is authoritative for topology, but some links are still stitched by fallback or service evidence",
        "- ATA coverage is incomplete by region, so some physical corridors have no historical confirmation",
        "- service-only pairs may indicate data quality issues, naming mismatches, or operational patterns not cleanly mapped to geometry",
    ]

    if unmapped_station_codes:
        lines.append(
            f"- unmapped station codes needing manual review: {', '.join(unmapped_station_codes)}"
        )

    lines.extend(
        [
            "",
            "## Why your maths results may look this way",
            "",
            "- centrality tends to peak around Dublin stations because that area has the highest branch density and most observed services",
            "- global metrics can be unstable because the physical graph still has disconnected components, especially around NI stations",
            "- path-based metrics are long (high average path and diameter) because this is mostly a corridor network rather than a dense mesh",
            "- confidence-sensitive analyses change noticeably depending on whether low-confidence stitched edges are included",
        ]
    )

    with open(OUTPUT_DIR / "irish_rail_network_actual_data_quality.md", "w") as handle:
        handle.write("\n".join(lines) + "\n")

    return report


def main():
    print("loading stations...")
    stations, stations_by_code = load_stations()
    print(f"loaded {len(stations)} passenger stations")

    print("loading rail geometry...")
    segments = load_json(SEGMENTS_FILE)
    print(f"loaded {len(segments['features'])} rail segments")

    print("building geometry-first physical edges...")
    physical_edges = build_geometry_edges(stations, segments)
    print(f"derived {len(physical_edges)} edges from segment adjacency")

    print("mapping stations to geometry vertices...")
    vertices = extract_unique_vertices(segments)
    station_vertex_map = map_stations_to_vertices(stations, vertices)
    print(
        f"mapped {len(station_vertex_map)}/{len(stations)} stations to geometry vertices"
    )

    physical_edges = add_fallback_edges(physical_edges, stations)
    print(f"after fallback, physical edges: {len(physical_edges)}")

    print("loading historic ATA service evidence...")
    service_evidence = load_service_evidence(list(stations_by_code.keys()))
    print(f"loaded service evidence for {len(service_evidence)} station pairs")

    physical_edges = add_component_bridges(
        physical_edges,
        stations,
        service_evidence,
        station_vertex_map,
    )
    print(f"after component bridges, physical edges: {len(physical_edges)}")

    print("building multilayer graph...")
    graph = build_multilayer_graph(stations, physical_edges, service_evidence)

    print("writing artifacts...")
    with open(f"{OUTPUT_BASE}.pkl", "wb") as handle:
        pickle.dump(graph, handle)
    nx.write_gml(make_gml_safe_multigraph(graph), f"{OUTPUT_BASE}.gml")

    write_confidence_csv(stations, physical_edges, service_evidence)
    write_stats(graph, physical_edges, service_evidence)
    report = write_data_quality_report(
        stations,
        graph,
        physical_edges,
        service_evidence,
        station_vertex_map,
    )

    print("done")
    print(f"graph nodes: {graph.number_of_nodes()}")
    print(f"graph edges: {graph.number_of_edges()} (rail + service)")
    print(f"physical components: {report['summary']['rail_components']}")
    print(f"outputs: {OUTPUT_BASE}.pkl/.gml/_stats.json and *_confidence.csv")


if __name__ == "__main__":
    main()
