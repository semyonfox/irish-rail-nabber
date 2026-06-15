#!/usr/bin/env python3
"""
Build the Irish rail network graph using actual passenger stations.
Handles coordinate transformation from lat/lon to Irish National Grid.
"""

import json
from pathlib import Path
import pickle
import networkx as nx
import math
from pyproj import Transformer

DATA_DIR = Path("./data")
OUTPUT_DIR = Path("./network_graphs")
OUTPUT_DIR.mkdir(exist_ok=True)

RAIL_SEGMENTS_FILE = DATA_DIR / "Rail_Network_Segment_-1920460442717953162.geojson"
STATIONS_FILE = OUTPUT_DIR / "irish_rail_stations.json"

# Coordinate transformer: WGS84 (lat/lon) -> Irish National Grid (EPSG:2157)
TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:2157", always_xy=True)


def load_geojson(filepath):
    """Load GeoJSON file."""
    with open(filepath, "r") as f:
        return json.load(f)


def load_stations():
    """Load actual passenger stations and project coordinates."""
    with open(STATIONS_FILE) as f:
        stations = json.load(f)

    # Project coordinates and deduplicate
    unique_stations = {}
    for station in stations:
        # Transform to Irish National Grid
        x, y = TRANSFORMER.transform(station["longitude"], station["latitude"])
        station["projected_x"] = x
        station["projected_y"] = y

        # Deduplicate: keep unique by rounded projected coords
        key = (round(x, -2), round(y, -2))  # Round to nearest 100m
        if key not in unique_stations:
            unique_stations[key] = station

    return list(unique_stations.values())


def distance_between_points(p1, p2):
    """Calculate Euclidean distance between two points."""
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


def find_nearest_station(point_coord, stations, threshold=5000):
    """Find the nearest station to a point coordinate."""
    min_distance = float("inf")
    nearest_station = None

    for station in stations:
        station_coord = (station["projected_x"], station["projected_y"])
        distance = distance_between_points(point_coord, station_coord)

        if distance < min_distance and distance <= threshold:
            min_distance = distance
            nearest_station = station

    return nearest_station


def segment_length(coordinates):
    """Calculate approximate length of a segment in degrees."""
    total_length = 0
    for i in range(len(coordinates) - 1):
        p1 = coordinates[i]
        p2 = coordinates[i + 1]
        dx = p2[0] - p1[0]
        dy = p2[1] - p1[1]
        total_length += math.sqrt(dx * dx + dy * dy)

    return total_length


def build_network(stations, rail_segments_data):
    """Build network graph connecting actual stations via rail segments."""
    G = nx.Graph()

    # Add nodes for each unique station
    station_index = {}
    for i, station in enumerate(stations):
        station_id = f"{station['code']}_{station['name'].replace(' ', '_')}"
        G.add_node(
            station_id,
            code=station["code"],
            name=station["name"],
            latitude=station["latitude"],
            longitude=station["longitude"],
            type="station",
        )
        station_index[station_id] = station

    # Connect stations via rail segments
    segments = rail_segments_data["features"]
    edges_added = set()
    processed = 0
    stations_on_segment = set()  # Track which stations appear on any segment

    print("Connecting stations via rail segments...")
    for segment in segments:
        processed += 1
        if processed % 1000 == 0:
            print(f"  Processing segment {processed}/{len(segments)}...")

        coords = segment["geometry"]["coordinates"]
        if len(coords) < 2:
            continue

        # Find all unique stations near any point on this segment
        segment_stations = set()
        for coord in coords:
            coord_tuple = tuple(coord)
            station = find_nearest_station(coord_tuple, stations)
            if station:
                station_id = f"{station['code']}_{station['name'].replace(' ', '_')}"
                segment_stations.add(station_id)

        # Connect all pairs of different stations found on this segment
        stations_list = list(segment_stations)
        for i in range(len(stations_list)):
            for j in range(i + 1, len(stations_list)):
                start_id = stations_list[i]
                end_id = stations_list[j]

                edge = tuple(sorted([start_id, end_id]))
                if edge not in edges_added:
                    distance = segment_length(coords)
                    G.add_edge(start_id, end_id, length=distance, type="rail")
                    edges_added.add(edge)

    return G


def save_graph(G, filename):
    """Save graph in multiple formats."""
    base_path = OUTPUT_DIR / filename

    # Save as pickle
    with open(f"{base_path}.pkl", "wb") as f:
        pickle.dump(G, f)

    # Save as GML
    nx.write_gml(G, f"{base_path}.gml")

    # Save statistics
    stats = {
        "num_stations": G.number_of_nodes(),
        "num_connections": G.number_of_edges(),
        "density": nx.density(G),
        "num_components": nx.number_connected_components(G),
    }

    with open(f"{base_path}_stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print(f"✓ Saved to {base_path}.pkl, {base_path}.gml, {base_path}_stats.json")


def main():
    print("Loading stations...")
    stations = load_stations()
    print(f"Found {len(stations)} unique passenger stations")

    print("\nLoading rail segments...")
    rail_segments = load_geojson(RAIL_SEGMENTS_FILE)

    print("\nBuilding network...")
    G = build_network(stations, rail_segments)

    print(f"\nNetwork created:")
    print(f"  - Stations (nodes): {G.number_of_nodes()}")
    print(f"  - Connections (edges): {G.number_of_edges()}")
    print(f"  - Connected components: {nx.number_connected_components(G)}")
    print(f"  - Network density: {nx.density(G):.6f}")

    # Save
    print("\nSaving graph...")
    save_graph(G, "irish_rail_network_real")

    print("\n✓ Done!")


if __name__ == "__main__":
    main()
