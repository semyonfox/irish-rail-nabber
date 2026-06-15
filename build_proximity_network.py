#!/usr/bin/env python3
"""
Build the Irish rail network graph by connecting nearby stations.
Since the segment data doesn't have proper connectivity, we build a graph
based on geographic proximity and known rail lines.
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

STATIONS_FILE = OUTPUT_DIR / "irish_rail_stations.json"
TRANSFORMER = Transformer.from_crs("EPSG:4326", "EPSG:2157", always_xy=True)


def load_stations():
    """Load actual passenger stations and project coordinates."""
    with open(STATIONS_FILE) as f:
        stations = json.load(f)

    # Project coordinates and deduplicate
    unique_stations = {}
    for station in stations:
        x, y = TRANSFORMER.transform(station["longitude"], station["latitude"])
        station["projected_x"] = x
        station["projected_y"] = y

        key = (round(x, -2), round(y, -2))
        if key not in unique_stations:
            unique_stations[key] = station

    return list(unique_stations.values())


def distance_between_points(p1, p2):
    """Calculate Euclidean distance between two points."""
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


def build_proximity_network(stations, max_distance=50000):
    """Build network by connecting nearby stations."""
    G = nx.Graph()

    # Add nodes
    station_index = {}
    for station in stations:
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

    # Connect stations based on proximity
    print(f"Connecting {len(stations)} stations by proximity (max distance: {max_distance}m)...")
    stations_list = list(stations)
    edges_added = 0

    for i in range(len(stations_list)):
        if (i + 1) % 20 == 0:
            print(f"  Processing station {i + 1}/{len(stations_list)}...")

        station_a = stations_list[i]
        station_a_id = f"{station_a['code']}_{station_a['name'].replace(' ', '_')}"
        station_a_coord = (station_a["projected_x"], station_a["projected_y"])

        for j in range(i + 1, len(stations_list)):
            station_b = stations_list[j]
            station_b_id = f"{station_b['code']}_{station_b['name'].replace(' ', '_')}"
            station_b_coord = (station_b["projected_x"], station_b["projected_y"])

            distance = distance_between_points(station_a_coord, station_b_coord)

            if distance <= max_distance:
                G.add_edge(station_a_id, station_b_id, length=distance, type="proximity")
                edges_added += 1

    return G, edges_added


def save_graph(G, filename):
    """Save graph in multiple formats."""
    base_path = OUTPUT_DIR / filename

    with open(f"{base_path}.pkl", "wb") as f:
        pickle.dump(G, f)

    nx.write_gml(G, f"{base_path}.gml")

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

    print("\nBuilding proximity network...")
    G, edges = build_proximity_network(stations, max_distance=50000)

    print(f"\nNetwork created:")
    print(f"  - Stations (nodes): {G.number_of_nodes()}")
    print(f"  - Connections (edges): {G.number_of_edges()}")
    print(f"  - Connected components: {nx.number_connected_components(G)}")
    print(f"  - Network density: {nx.density(G):.6f}")

    # Analyze connectivity
    degrees = dict(G.degree())
    isolated = len([n for n in degrees if degrees[n] == 0])
    print(f"  - Isolated stations: {isolated}")

    print("\nSaving graph...")
    save_graph(G, "irish_rail_network_proximity")

    print("\n✓ Done!")


if __name__ == "__main__":
    main()
