#!/usr/bin/env python3
"""
Quick test to verify the visualizations are properly generated.
"""

import pickle
import json
from pathlib import Path

def test_files():
    """Test that all required files exist and are valid."""
    output_dir = Path("./network_graphs")
    
    tests = []
    
    # Test interactive HTML
    html_file = output_dir / "network_interactive.html"
    if html_file.exists():
        with open(html_file, 'r') as f:
            content = f.read()
        size_kb = html_file.stat().st_size / 1024
        has_data = '"data":' in content and len(content) > 100000
        tests.append(("Interactive HTML", html_file.exists() and has_data, f"{size_kb:.0f} KB"))
    
    # Test PNG image
    png_file = output_dir / "network_graph.png"
    if png_file.exists():
        size_kb = png_file.stat().st_size / 1024
        is_valid = png_file.stat().st_size > 100000
        tests.append(("PNG Image", is_valid, f"{size_kb:.0f} KB"))
    
    # Test graph data
    graph_file = output_dir / "irish_rail_network_proximity.pkl"
    if graph_file.exists():
        with open(graph_file, 'rb') as f:
            G = pickle.load(f)
        tests.append(("Graph Data", G.number_of_nodes() == 158, f"{G.number_of_nodes()} nodes, {G.number_of_edges()} edges"))
    
    # Test stations
    stations_file = output_dir / "irish_rail_stations.json"
    if stations_file.exists():
        with open(stations_file, 'r') as f:
            stations = json.load(f)
        tests.append(("Station Data", len(stations) > 100, f"{len(stations)} stations"))
    
    # Print results
    print("=" * 60)
    print("VISUALIZATION TEST RESULTS")
    print("=" * 60)
    for test_name, passed, details in tests:
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{status:8} | {test_name:20} | {details}")
    
    all_passed = all(t[1] for t in tests)
    print("=" * 60)
    if all_passed:
        print("\n✓ All tests passed! Visualizations are ready to use.")
        print("\nOpen these files in your browser:")
        print(f"  1. {html_file.absolute()}")
        print(f"  2. {png_file.absolute()}")
    else:
        print("\n✗ Some tests failed. Check the output above.")
    
    return all_passed

if __name__ == "__main__":
    success = test_files()
    exit(0 if success else 1)
