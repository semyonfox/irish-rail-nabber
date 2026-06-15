# Accurate Irish Rail Network Design

## Goal

Produce an accurate station-level graph for Irish Rail that can be trusted for downstream network calculations.

The graph must represent physical rail topology from geometry data, while also carrying historical operational evidence from the existing database. Missing or inconsistent live tracking data must not remove true physical links.

## Scope

In scope:

- Build a passenger-station-only graph (158 stations).
- Construct physical station adjacency from rail geometry (not proximity thresholding).
- Attach historical movement and timing evidence from the Postgres database on `server:9898`.
- Export graph and quality artifacts for analysis.

Out of scope:

- Full rail-point or track-vertex graph.
- Replacing the collector/daemon ingestion logic.
- Real-time visualization redesign.

## Source of Truth and Conflict Policy

1. Geometry data in `data/*.geojson` is the source of truth for physical topology.
2. Historical ATA/movement data is used to enrich and score edges.
3. If geometry and ATA disagree, keep the geometry-derived physical edge and mark ATA evidence as weak or missing.

## Data Inputs

- `network_graphs/irish_rail_stations.json`
  - Passenger station metadata (code, name, lat/lon).
- `data/Rail_Network_Segment_-1920460442717953162.geojson`
  - Rail segment geometry used for physical adjacency.
- Historic database (`server:9898`, `ireland_public`)
  - `train_movements` for ordered stop transitions and observed runtimes.
  - `station_events` for station-level delay reliability indicators.

## Graph Model

### Nodes

One node per passenger station, keyed by canonical `station_code`.

Node attributes:

- `station_code`
- `name`
- `latitude`
- `longitude`

### Edge Layers

#### 1) Physical layer (`rail_edge`)

Meaning: adjacency on real track topology between consecutive stations.

Attributes:

- `edge_type = "rail_edge"`
- `distance_km`
- `geometry_confidence` (default high)
- `track_count` (optional, nullable where unknown)
- `source = "geojson"`

#### 2) Service layer (`service_edge`)

Meaning: operational evidence observed in historic data.

Attributes:

- `edge_type = "service_edge"`
- `trips_observed`
- `median_runtime_min`
- `on_time_rate`
- `ata_coverage_score`
- `source = "historic_ata"`

Rules:

- Service metrics are attached to matching `rail_edge`s when possible.
- Non-matching service transitions are retained as low-confidence service candidates and excluded from core topology.

## Pipeline Design

1. Load and normalize station metadata.
2. Project station coordinates to EPSG:2157.
3. Snap stations to rail segment geometry with bounded nearest-neighbor matching.
4. Build segment connectivity graph and derive station-to-next-station physical adjacency.
5. Query historical DB and derive observed stop-to-stop transitions plus timing/reliability stats.
6. Join ATA evidence onto physical edges; retain unmatched service candidates separately.
7. Compute confidence scores and coverage diagnostics.
8. Export graph and reports.

## Confidence and Quality

Per corridor:

- `geometry_confidence`: high unless snapping quality is poor.
- `ata_coverage_score`: based on observation count, recency, and directional balance.
- `composite_confidence`: weighted blend for filtering and analysis.

Coverage behavior:

- Weak API coverage areas remain in physical topology.
- Their operational fields may be sparse and are explicitly marked, not silently dropped.

## Error Handling

- Missing DB connectivity: still produce geometry-only graph and mark ATA enrichment status as unavailable.
- Unmatched station names/codes: fail that station with explicit warning and summary counts.
- Ambiguous station snaps: pick best candidate by distance threshold and emit ambiguity report.
- Data sparsity on a corridor: keep physical edge, set service metrics null/low-confidence.

## Validation

Required checks:

- No proximity-generated long-hop shortcuts in `rail_edge` layer.
- Physical graph contains expected trunk corridors and remains globally consistent.
- Every exported station node maps to a canonical station code.
- Edge counts and connected components are stable and explainable.

## Outputs

- `network_graphs/irish_rail_network_actual.pkl`
- `network_graphs/irish_rail_network_actual.gml`
- `network_graphs/irish_rail_network_actual_stats.json`
- `network_graphs/irish_rail_network_actual_confidence.csv`

Stats/report fields include:

- Node/edge totals by layer.
- Component counts for physical layer.
- Corridor confidence distribution.
- List of low-evidence or ATA-missing corridors.

## Testing Strategy

- Unit tests for station normalization, snapping thresholds, and edge-layer construction.
- Integration test that builds graph from local files and checks deterministic invariants.
- DB integration test (when DB reachable) validating ATA enrichment joins and metrics.
- Regression test to prevent reintroduction of 50km proximity edges into core topology.

## Implementation Notes

- Prefer extending existing builder scripts over introducing unrelated modules.
- Preserve existing artifacts while adding `*_actual` outputs.
- Keep the pipeline deterministic and rerunnable for reproducible analysis.

## Success Criteria

- Graph represents real station-to-station topology from geometry data.
- Historic data enriches edges without distorting core topology.
- Coverage gaps are visible as confidence metadata, not hidden by edge deletion.
- Output graph is immediately usable for shortest-path, centrality, bottleneck, and reliability-aware calculations.
