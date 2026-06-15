#!/usr/bin/env python3
"""
Generate a high-quality PNG image of the Irish rail network graph.
"""

import pickle
from pathlib import Path
import math

OUTPUT_DIR = Path("./network_graphs")
GRAPH_FILE = OUTPUT_DIR / "irish_rail_network_proximity.pkl"

try:
    import matplotlib.pyplot as plt
    import matplotlib.patches as mpatches

    HAS_MATPLOTLIB = True
except ImportError:
    HAS_MATPLOTLIB = False


def load_graph():
    """Load the pickled graph."""
    with open(GRAPH_FILE, "rb") as f:
        return pickle.load(f)


def create_matplotlib_image(G):
    """Create a PNG image using matplotlib."""
    if not HAS_MATPLOTLIB:
        print("matplotlib not available, installing...")
        import subprocess

        subprocess.run(
            ["python3", "-m", "pip", "install", "-q", "matplotlib"],
            cwd="/home/semyon/code/personal/irish-rail-nabber/venv",
            env={"VIRTUAL_ENV": "/home/semyon/code/personal/irish-rail-nabber/venv"},
        )
        import matplotlib.pyplot as plt
        import matplotlib.patches as mpatches
    else:
        import matplotlib.pyplot as plt

    # Get bounds
    lats = []
    lons = []

    for node_id in G.nodes():
        lat = G.nodes[node_id].get("latitude", 0)
        lon = G.nodes[node_id].get("longitude", 0)
        lats.append(lat)
        lons.append(lon)

    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)

    # Create figure with dark theme
    fig, ax = plt.subplots(figsize=(20, 16), dpi=150)
    fig.patch.set_facecolor("#0a0e27")
    ax.set_facecolor("#0a0e27")

    # Normalize coordinates
    def normalize_coords(lat, lon):
        y = (lat - lat_min) / (lat_max - lat_min) if lat_max > lat_min else 0.5
        x = (lon - lon_min) / (lon_max - lon_min) if lon_max > lon_min else 0.5
        return x, y

    # Draw edges first
    for source, target in G.edges():
        source_lat = G.nodes[source].get("latitude", 0)
        source_lon = G.nodes[source].get("longitude", 0)
        target_lat = G.nodes[target].get("latitude", 0)
        target_lon = G.nodes[target].get("longitude", 0)

        sx, sy = normalize_coords(source_lat, source_lon)
        tx, ty = normalize_coords(target_lat, target_lon)

        ax.plot(
            [sx, tx], [sy, ty], color="#ffffff", alpha=0.15, linewidth=0.5, zorder=1
        )

    # Draw nodes
    node_x = []
    node_y = []
    node_colors = []
    node_sizes = []

    for node_id in G.nodes():
        lat = G.nodes[node_id].get("latitude", 0)
        lon = G.nodes[node_id].get("longitude", 0)
        x, y = normalize_coords(lat, lon)

        degree = G.degree(node_id)

        node_x.append(x)
        node_y.append(y)
        node_colors.append(degree)
        node_sizes.append(max(10, min(100, 10 + degree * 2)))

    scatter = ax.scatter(
        node_x,
        node_y,
        c=node_colors,
        s=node_sizes,
        cmap="viridis",
        alpha=0.8,
        edgecolors="#4ade80",
        linewidth=0.5,
        zorder=2,
    )

    # Styling
    ax.set_xlim(-0.05, 1.05)
    ax.set_ylim(-0.05, 1.05)
    ax.set_aspect("equal")
    ax.axis("off")

    # Add colorbar
    cbar = plt.colorbar(scatter, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("Station Connections", color="#e0e0e0", fontsize=10)
    cbar.ax.tick_params(colors="#e0e0e0")

    # Add title and stats
    num_stations = G.number_of_nodes()
    num_lines = G.number_of_edges()
    num_components = len(list(__import__("networkx").connected_components(G)))

    title_text = f"Irish Rail Network\n{num_stations} Stations • {num_lines} Rail Lines • {num_components} Components"
    fig.text(
        0.5,
        0.98,
        title_text,
        ha="center",
        va="top",
        fontsize=18,
        color="#4ade80",
        weight="bold",
        family="monospace",
    )

    # Save
    output_file = OUTPUT_DIR / "network_graph.png"
    plt.savefig(
        output_file, facecolor="#0a0e27", edgecolor="none", bbox_inches="tight", dpi=150
    )
    plt.close()

    return output_file


def main():
    print("Loading graph...")
    G = load_graph()

    print("Generating image...")
    output_file = create_matplotlib_image(G)

    print(f"✓ Image saved to {output_file}")
    print(f"  Size: {output_file.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
