#!/usr/bin/env python3
"""
Visualize the Irish rail network graph as interactive HTML.
"""

import pickle
import json
from pathlib import Path
import math

OUTPUT_DIR = Path("./network_graphs")
GRAPH_FILE = OUTPUT_DIR / "irish_rail_network.pkl"


def load_graph():
    """Load the pickled graph."""
    with open(GRAPH_FILE, "rb") as f:
        return pickle.load(f)


def create_html_visualization(G):
    """Create an interactive HTML visualization of the graph."""

    # Calculate node positions using a spring layout approximation
    # For large graphs, we'll use geographic coordinates directly
    nodes_data = []
    edges_data = []

    # Get bounds for normalization
    lats = []
    lons = []

    for node_id in G.nodes():
        lat = G.nodes[node_id].get("lat", 0)
        lon = G.nodes[node_id].get("lon", 0)
        lats.append(lat)
        lons.append(lon)

    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)

    # Normalize to 0-1000 range for canvas
    canvas_size = 1000

    def normalize_coords(lat, lon):
        # Mercator-like projection for better visual representation
        y = (
            (lat - lat_min) / (lat_max - lat_min) * canvas_size
            if lat_max > lat_min
            else canvas_size / 2
        )
        x = (
            (lon - lon_min) / (lon_max - lon_min) * canvas_size
            if lon_max > lon_min
            else canvas_size / 2
        )
        return x, y

    # Add nodes
    for node_id in G.nodes():
        lat = G.nodes[node_id].get("lat", 0)
        lon = G.nodes[node_id].get("lon", 0)
        x, y = normalize_coords(lat, lon)

        degree = G.degree(node_id)
        size = max(3, min(15, 3 + degree / 10))  # Size based on connections

        nodes_data.append(
            {
                "id": node_id,
                "x": x,
                "y": y,
                "size": size,
                "degree": degree,
                "lat": lat,
                "lon": lon,
            }
        )

    # Add edges
    for source, target in G.edges():
        source_node = next(n for n in nodes_data if n["id"] == source)
        target_node = next(n for n in nodes_data if n["id"] == target)

        edges_data.append(
            {
                "source": source,
                "target": target,
                "x1": source_node["x"],
                "y1": source_node["y"],
                "x2": target_node["x"],
                "y2": target_node["y"],
            }
        )

    # Load stats
    stats_file = OUTPUT_DIR / "irish_rail_network_stats.json"
    with open(stats_file) as f:
        stats = json.load(f)

    # Create HTML
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Irish Rail Network Graph</title>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}
        
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: #0a0e27;
            color: #e0e0e0;
            overflow: hidden;
        }}
        
        #container {{
            display: flex;
            height: 100vh;
        }}
        
        #canvas {{
            flex: 1;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
            cursor: crosshair;
        }}
        
        #sidebar {{
            width: 320px;
            background: #0f1329;
            border-left: 1px solid #2a3f5f;
            padding: 24px;
            overflow-y: auto;
            box-shadow: -4px 0 12px rgba(0, 0, 0, 0.5);
        }}
        
        h1 {{
            font-size: 20px;
            margin-bottom: 20px;
            color: #4ade80;
            font-weight: 600;
        }}
        
        .stat {{
            margin-bottom: 16px;
            padding: 12px;
            background: rgba(74, 222, 128, 0.05);
            border-left: 3px solid #4ade80;
            border-radius: 4px;
        }}
        
        .stat-label {{
            font-size: 12px;
            text-transform: uppercase;
            color: #94a3b8;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
        }}
        
        .stat-value {{
            font-size: 24px;
            font-weight: 700;
            color: #4ade80;
        }}
        
        #info {{
            margin-top: 30px;
            padding: 16px;
            background: rgba(148, 163, 184, 0.05);
            border: 1px solid rgba(148, 163, 184, 0.2);
            border-radius: 6px;
            font-size: 13px;
            line-height: 1.6;
        }}
        
        .node-info {{
            margin-top: 20px;
            padding: 12px;
            background: rgba(59, 130, 246, 0.05);
            border-left: 3px solid #3b82f6;
            border-radius: 4px;
            font-size: 12px;
        }}
        
        .node-info-label {{
            color: #94a3b8;
            margin-bottom: 4px;
        }}
        
        .node-info-value {{
            color: #3b82f6;
            font-weight: 600;
        }}
    </style>
</head>
<body>
    <div id="container">
        <canvas id="canvas"></canvas>
        <div id="sidebar">
            <h1>Irish Rail Network</h1>
            
            <div class="stat">
                <div class="stat-label">Stations</div>
                <div class="stat-value">{stats["num_stations"]}</div>
            </div>
            
            <div class="stat">
                <div class="stat-label">Rail Lines</div>
                <div class="stat-value">{stats["num_rail_lines"]}</div>
            </div>
            
            <div class="stat">
                <div class="stat-label">Network Components</div>
                <div class="stat-value">{stats["num_components"]}</div>
            </div>
            
            <div class="stat">
                <div class="stat-label">Density</div>
                <div class="stat-value">{stats["density"]:.4f}</div>
            </div>
            
            <div id="info">
                <strong>About this visualization:</strong><br><br>
                This is an interactive network graph showing the Irish rail network structure.
                <br><br>
                <strong>Green nodes</strong> represent stations (size indicates connectivity).
                <strong>White lines</strong> represent rail segments.
                <br><br>
                Hover over nodes to see connection details. The larger a node, the more connections it has.
            </div>
            
            <div id="nodeInfo" class="node-info" style="display: none;">
                <div class="node-info-label">Selected Station ID:</div>
                <div class="node-info-value" id="nodeId">-</div>
                <div class="node-info-label" style="margin-top: 8px;">Connections:</div>
                <div class="node-info-value" id="nodeConnections">-</div>
            </div>
        </div>
    </div>
    
    <script>
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const nodes = {json.dumps(nodes_data)};
        const edges = {json.dumps(edges_data)};
        
        // Set canvas size
        function resizeCanvas() {{
            canvas.width = window.innerWidth - 320;
            canvas.height = window.innerHeight;
            draw();
        }}
        
        window.addEventListener('resize', resizeCanvas);
        resizeCanvas();
        
        // Mouse tracking
        let hoveredNode = null;
        canvas.addEventListener('mousemove', (e) => {{
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            hoveredNode = null;
            for (const node of nodes) {{
                const dx = node.x - x;
                const dy = node.y - y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < node.size * 2) {{
                    hoveredNode = node;
                    break;
                }}
            }}
            draw();
        }});
        
        // Drawing function
        function draw() {{
            // Clear canvas
            ctx.fillStyle = '#0a0e27';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Draw edges
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            for (const edge of edges) {{
                ctx.beginPath();
                ctx.moveTo(edge.x1, edge.y1);
                ctx.lineTo(edge.x2, edge.y2);
                ctx.stroke();
            }}
            
            // Draw nodes
            for (const node of nodes) {{
                const isHovered = hoveredNode && hoveredNode.id === node.id;
                
                if (isHovered) {{
                    ctx.fillStyle = '#fbbf24';
                    ctx.shadowColor = 'rgba(251, 191, 36, 0.6)';
                    ctx.shadowBlur = 15;
                }} else {{
                    ctx.fillStyle = '#4ade80';
                    ctx.shadowColor = 'rgba(74, 222, 128, 0.3)';
                    ctx.shadowBlur = 8;
                }}
                
                const radius = isHovered ? node.size * 1.5 : node.size;
                ctx.beginPath();
                ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.shadowColor = 'transparent';
            }}
            
            // Update info panel
            if (hoveredNode) {{
                document.getElementById('nodeInfo').style.display = 'block';
                document.getElementById('nodeId').textContent = hoveredNode.id;
                document.getElementById('nodeConnections').textContent = hoveredNode.degree;
            }} else {{
                document.getElementById('nodeInfo').style.display = 'none';
            }}
        }}
        
        // Initial draw
        draw();
    </script>
</body>
</html>"""

    return html


def main():
    print("Loading graph...")
    G = load_graph()

    print("Creating visualization...")
    html = create_html_visualization(G)

    # Save HTML
    output_file = OUTPUT_DIR / "network_visualization.html"
    with open(output_file, "w") as f:
        f.write(html)

    print(f"✓ Visualization saved to {output_file}")
    print(f"\nOpen in browser: {output_file.absolute()}")


if __name__ == "__main__":
    main()
