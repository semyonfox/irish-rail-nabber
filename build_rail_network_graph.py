#!/usr/bin/env python3
"""
Build a graph representation of the Irish rail network
using GeoJSON data for stations and rail segments.
"""

import json
import networkx as nx
from pathlib import Path
from collections import defaultdict
import pickle
import math

# File paths
DATA_DIR = Path("./data")
OUTPUT_DIR = Path("./network_graphs")
OUTPUT_DIR.mkdir(exist_ok=True)

RAIL_POINTS_FILE = DATA_DIR / "Rail_Points_-7430818563836234733.geojson"
RAIL_SEGMENTS_FILE = DATA_DIR / "Rail_Network_Segment_-1920460442717953162.geojson"
RAIL_NETWORK_FILE = (
    DATA_DIR
    / "Rail_Network___OSi_National_250k_Map_Of_Ireland_-86053660579710107.geojson"
)

DISTANCE_THRESHOLD = 200  # meters - points within this distance could be connected
SEGMENT_ENDPOINT_THRESHOLD = 1000  # meters - closest point to segment endpoint


def load_geojson(filepath):
    """Load and return GeoJSON data."""
    with open(filepath, "r") as f:
        return json.load(f)


def create_spatial_index(points):
    """Create a simple spatial index for faster lookups."""
    # Group points into grid cells (1km cells)
    grid = defaultdict(list)
    grid_size = 1000  # 1km cells

    for obj_id, point_data in points.items():
        lon, lat = point_data["coords"]
        grid_x = int(lon / grid_size)
        grid_y = int(lat / grid_size)
        grid[(grid_x, grid_y)].append(obj_id)

    return grid, grid_size


def distance_between_points(p1, p2):
    """Calculate Euclidean distance between two points."""
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


def find_station_clusters(points_data):
    """
    Group rail points into station clusters based on proximity.
    Points within DISTANCE_THRESHOLD meters are considered the same station.

    Returns:
        dict: mapping of representative point ID to list of point IDs in cluster
    """
    features = points_data["features"]
    points = {}

    # Extract all points with their coordinates
    for feature in features:
        obj_id = feature["id"]
        coords = feature["geometry"]["coordinates"]
        points[obj_id] = {
            "id": obj_id,
            "coords": tuple(coords),
            "properties": feature.get("properties", {}),
        }

    # Cluster nearby points using spatial index (faster approach)
    clusters = {}
    visited = set()
    grid, grid_size = create_spatial_index(points)

    for obj_id in points.keys():
        if obj_id in visited:
            continue

        # Start a new cluster with BFS
        cluster = [obj_id]
        visited.add(obj_id)
        queue = [obj_id]

        while queue:
            current_id = queue.pop(0)
            current_coords = points[current_id]["coords"]

            # Get grid cells to check (current + neighbors)
            lon, lat = current_coords
            grid_x = int(lon / grid_size)
            grid_y = int(lat / grid_size)

            cells_to_check = set()
            for dx in [-1, 0, 1]:
                for dy in [-1, 0, 1]:
                    cells_to_check.add((grid_x + dx, grid_y + dy))

            # Check nearby points in grid
            for cell in cells_to_check:
                for neighbor_id in grid.get(cell, []):
                    if neighbor_id not in visited:
                        neighbor_coords = points[neighbor_id]["coords"]
                        distance = distance_between_points(
                            current_coords, neighbor_coords
                        )
                        if distance <= DISTANCE_THRESHOLD:
                            cluster.append(neighbor_id)
                            visited.add(neighbor_id)
                            queue.append(neighbor_id)

        clusters[obj_id] = cluster

    return clusters, points


def build_network_graph(rail_segments_data, clusters):
    """
    Build a NetworkX graph from rail segments and station clusters.
    Uses a simpler, faster approach for large datasets.
    """
    G = nx.Graph()

    # Create a mapping from point IDs to their cluster representative
    point_to_cluster = {}
    for cluster_id, point_ids in clusters.items():
        for point_id in point_ids:
            point_to_cluster[point_id] = cluster_id

    # Load points data for coordinates
    points_data = load_geojson(RAIL_POINTS_FILE)
    cluster_coords = {}

    for feature in points_data["features"]:
        obj_id = feature["id"]
        cluster_id = point_to_cluster.get(obj_id)
        if cluster_id and cluster_id not in cluster_coords:
            coords = feature["geometry"]["coordinates"]
            cluster_coords[cluster_id] = {
                "lat": coords[1],
                "lon": coords[0],
                "points": [],
            }
        if cluster_id:
            cluster_coords[cluster_id]["points"].append(obj_id)

    # Add station nodes
    for cluster_id, coord_info in cluster_coords.items():
        G.add_node(
            cluster_id,
            lat=coord_info["lat"],
            lon=coord_info["lon"],
            point_ids=coord_info["points"],
            type="station",
        )

    # Add rail segments as edges (simplified: just connect endpoints)
    segments = rail_segments_data["features"]
    edges_added = set()
    processed = 0

    for segment in segments:
        processed += 1
        if processed % 1000 == 0:
            print(f"  Processing segment {processed}/{len(segments)}...")

        coords = segment["geometry"]["coordinates"]
        if len(coords) < 2:
            continue

        # Get the start and end points of the segment
        start_coord = tuple(coords[0])
        end_coord = tuple(coords[-1])

        # Find closest stations
        start_station = find_closest_station(
            start_coord, cluster_coords, SEGMENT_ENDPOINT_THRESHOLD
        )
        end_station = find_closest_station(
            end_coord, cluster_coords, SEGMENT_ENDPOINT_THRESHOLD
        )

        if start_station and end_station and start_station != end_station:
            edge = tuple(sorted([start_station, end_station]))
            if edge not in edges_added:
                distance = segment_length(coords)
                G.add_edge(start_station, end_station, length=distance, type="rail")
                edges_added.add(edge)

    return G


def find_closest_station(point_coord, cluster_coords, threshold=2000):
    """Find the closest station cluster to a point coordinate."""
    min_distance = float("inf")
    closest_station = None

    for cluster_id, coord_info in cluster_coords.items():
        station_coord = (coord_info["lon"], coord_info["lat"])
        distance = distance_between_points(point_coord, station_coord)

        if distance < min_distance and distance <= threshold:
            min_distance = distance
            closest_station = cluster_id

    return closest_station


def segment_length(coordinates):
    """Calculate the length of a line segment in meters (approximate)."""
    total_length = 0
    for i in range(len(coordinates) - 1):
        p1 = coordinates[i]
        p2 = coordinates[i + 1]
        # Rough approximation: 1 degree ~111km at this latitude
        dx = (p2[0] - p1[0]) * 111000 * 0.85  # 0.85 factor for Irish latitude
        dy = (p2[1] - p1[1]) * 111000
        total_length += (dx**2 + dy**2) ** 0.5

    return total_length


def save_graph(G, filename):
    """Save graph to file in multiple formats."""
    base_path = OUTPUT_DIR / filename

    # Save as pickle
    with open(f"{base_path}.pkl", "wb") as f:
        pickle.dump(G, f)

    # Save as GML (simplified, without list attributes)
    G_simplified = G.copy()
    for node in G_simplified.nodes():
        if "point_ids" in G_simplified.nodes[node]:
            # Convert list to string
            G_simplified.nodes[node]["point_ids"] = str(
                G_simplified.nodes[node]["point_ids"]
            )

    nx.write_gml(G_simplified, f"{base_path}.gml")

    # Save basic statistics as JSON
    stats = {
        "num_stations": G.number_of_nodes(),
        "num_rail_lines": G.number_of_edges(),
        "density": nx.density(G),
        "num_components": nx.number_connected_components(G),
    }

    # Try to calculate some metrics if graph is small enough
    try:
        if G.number_of_nodes() < 500:
            stats["average_degree"] = (
                sum(dict(G.degree()).values()) / G.number_of_nodes()
            )
            stats["average_clustering"] = nx.average_clustering(G)
    except:
        pass

    with open(f"{base_path}_stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print(f"✓ Saved graph to {base_path}.pkl, {base_path}.gml, {base_path}_stats.json")


def main():
    print("Loading rail network data...")

    # Load data
    rail_points_data = load_geojson(RAIL_POINTS_FILE)
    rail_segments_data = load_geojson(RAIL_SEGMENTS_FILE)

    print(f"Found {len(rail_points_data['features'])} rail points")
    print(f"Found {len(rail_segments_data['features'])} rail segments")

    # Find station clusters
    print("\nClustering nearby points into stations...")
    clusters, points = find_station_clusters(rail_points_data)
    print(f"Identified {len(clusters)} station clusters")

    # Build graph
    print("\nBuilding network graph...")
    G = build_network_graph(rail_segments_data, clusters)

    print(f"Graph created:")
    print(f"  - Nodes (stations): {G.number_of_nodes()}")
    print(f"  - Edges (rail lines): {G.number_of_edges()}")
    print(f"  - Connected components: {nx.number_connected_components(G)}")

    # Save graph
    print("\nSaving graph...")
    save_graph(G, "irish_rail_network")

    print("\n✓ Done! Graph representation created.")
    print(f"  Output files in: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
