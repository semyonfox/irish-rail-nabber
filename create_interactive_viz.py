#!/usr/bin/env python3
"""
Generate an interactive HTML visualization of the Irish rail network.
Uses the proximity-based network with proper coordinate handling.
"""

import pickle
import json
from pathlib import Path

OUTPUT_DIR = Path("./network_graphs")
GRAPH_FILE = OUTPUT_DIR / "irish_rail_network_proximity.pkl"
STATS_FILE = OUTPUT_DIR / "irish_rail_network_proximity_stats.json"


def load_graph():
    """Load the pickled graph."""
    with open(GRAPH_FILE, "rb") as f:
        return pickle.load(f)


def load_stats():
    """Load network statistics."""
    with open(STATS_FILE) as f:
        return json.load(f)


def create_interactive_html(G, stats):
    """Create an interactive HTML visualization using Cytoscape.js."""

    # Prepare nodes and edges for Cytoscape
    nodes = []
    edges = []

    # Get bounds for normalization
    lats = [G.nodes[n].get("latitude", 0) for n in G.nodes()]
    lons = [G.nodes[n].get("longitude", 0) for n in G.nodes()]

    lat_min, lat_max = min(lats), max(lats)
    lon_min, lon_max = min(lons), max(lons)

    def normalize(lat, lon):
        y = (lat - lat_min) / (lat_max - lat_min) * 800 if lat_max > lat_min else 400
        x = (lon - lon_min) / (lon_max - lon_min) * 800 if lon_max > lon_min else 400
        return x, y

    # Add nodes
    for node_id in G.nodes():
        lat = G.nodes[node_id].get("latitude", 0)
        lon = G.nodes[node_id].get("longitude", 0)
        name = G.nodes[node_id].get("name", node_id)
        degree = G.degree(node_id)

        x, y = normalize(lat, lon)

        nodes.append(
            {
                "data": {
                    "id": str(node_id),
                    "label": name,
                    "degree": degree,
                },
                "position": {"x": x, "y": y},
            }
        )

    # Add edges
    edge_set = set()
    for source, target in G.edges():
        edge_id = f"{min(source, target)}-{max(source, target)}"
        if edge_id not in edge_set:
            edges.append(
                {
                    "data": {
                        "id": edge_id,
                        "source": str(source),
                        "target": str(target),
                    }
                }
            )
            edge_set.add(edge_id)

    cytoscape_elements = nodes + edges

    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Irish Rail Network - Interactive</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.28.1/cytoscape.min.js"></script>
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
        }}
        
        #container {{
            display: flex;
            height: 100vh;
        }}
        
        #cy {{
            flex: 1;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%);
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
            font-size: 11px;
            text-transform: uppercase;
            color: #94a3b8;
            letter-spacing: 0.5px;
        }}
        
        .stat-value {{
            font-size: 28px;
            font-weight: 700;
            color: #4ade80;
            margin-top: 4px;
        }}
        
        #info {{
            margin-top: 30px;
            padding: 14px;
            background: rgba(74, 222, 128, 0.08);
            border: 1px solid rgba(74, 222, 128, 0.3);
            border-radius: 6px;
            font-size: 12px;
            line-height: 1.6;
            color: #cbd5e1;
        }}
        
        #nodeInfo {{
            margin-top: 20px;
            padding: 14px;
            background: rgba(59, 130, 246, 0.08);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 6px;
            font-size: 12px;
            display: none;
        }}
        
        #nodeInfo.active {{
            display: block;
        }}
        
        .info-label {{
            color: #94a3b8;
            font-size: 10px;
            text-transform: uppercase;
            margin-bottom: 4px;
            margin-top: 8px;
        }}
        
        .info-label:first-child {{
            margin-top: 0;
        }}
        
        .info-value {{
            color: #3b82f6;
            font-weight: 600;
            font-size: 16px;
        }}
    </style>
</head>
<body>
    <div id="container">
        <div id="cy"></div>
        <div id="sidebar">
            <h1>Irish Rail Network</h1>
            
            <div class="stat">
                <div class="stat-label">Stations</div>
                <div class="stat-value">{stats["num_stations"]}</div>
            </div>
            
            <div class="stat">
                <div class="stat-label">Connections</div>
                <div class="stat-value">{stats["num_connections"]}</div>
            </div>
            
            <div class="stat">
                <div class="stat-label">Components</div>
                <div class="stat-value">{stats["num_components"]}</div>
            </div>
            
            <div id="info">
                <strong>Interactive Graph</strong><br><br>
                Click and drag to pan. Scroll to zoom. Click nodes to see details. Double-click to fit view.
            </div>
            
            <div id="nodeInfo">
                <div class="info-label">Station</div>
                <div class="info-value" id="nodeName">-</div>
                <div class="info-label">Connections</div>
                <div class="info-value" id="nodeDegree">-</div>
            </div>
        </div>
    </div>
    
    <script>
        var cy = cytoscape({{
            container: document.getElementById('cy'),
            elements: {json.dumps(cytoscape_elements)},
            style: [
                {{
                    selector: 'node',
                    style: {{
                        'background-color': '#4ade80',
                        'width': 'mapData(degree, 0, 72, 8, 40)',
                        'height': 'mapData(degree, 0, 72, 8, 40)',
                        'border-width': 2,
                        'border-color': '#1f2937',
                        'label': 'data(label)',
                        'font-size': 8,
                        'color': '#0a0e27',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'z-index': 10,
                        'text-opacity': 0,
                        'overlay-padding': 5,
                    }}
                }},
                {{
                    selector: 'node:hover',
                    style: {{
                        'background-color': '#fbbf24',
                        'box-shadow': '0 0 10px rgba(251, 191, 36, 0.6)',
                        'text-opacity': 1,
                    }}
                }},
                {{
                    selector: 'node:selected',
                    style: {{
                        'background-color': '#60a5fa',
                        'box-shadow': '0 0 15px rgba(96, 165, 250, 0.8)',
                        'border-color': '#3b82f6',
                        'border-width': 3,
                        'text-opacity': 1,
                    }}
                }},
                {{
                    selector: 'edge',
                    style: {{
                        'line-color': '#ffffff',
                        'width': 1,
                        'opacity': 0.1,
                        'z-index': 0,
                    }}
                }}
            ],
            layout: {{
                name: 'cose',
                directed: false,
                animate: false,
                componentSpacing: 40,
                nodeSpacing: 10,
                gravity: 1,
            }},
            wheelSensitivity: 0.1,
            autoungrabify: true,
        }});
        
        // Double click to fit
        cy.on('dbltap', function() {{
            cy.fit();
        }});
        
        // Node selection
        cy.on('tap', 'node', function(evt) {{
            var node = evt.target;
            cy.$('node').removeClass('selected');
            node.addClass('selected');
            
            var degree = node.data('degree');
            var label = node.data('label');
            
            document.getElementById('nodeName').textContent = label;
            document.getElementById('nodeDegree').textContent = degree;
            document.getElementById('nodeInfo').classList.add('active');
        }});
        
        // Click background to deselect
        cy.on('tap', function(evt) {{
            if (evt.target === cy) {{
                cy.$('node').removeClass('selected');
                document.getElementById('nodeInfo').classList.remove('active');
            }}
        }});
        
        // Initial layout
        cy.layout({{name: 'cose', directed: false, animate: false}}).run();
    </script>
</body>
</html>"""

    return html


def main():
    print("Loading graph...")
    G = load_graph()

    print("Loading statistics...")
    stats = load_stats()

    print("Creating interactive visualization...")
    html = create_interactive_html(G, stats)

    # Save HTML
    output_file = OUTPUT_DIR / "network_interactive.html"
    with open(output_file, "w") as f:
        f.write(html)

    print(f"✓ Interactive visualization saved to {output_file}")
    print(f"\nOpen in browser: {output_file.absolute()}")


if __name__ == "__main__":
    main()
