# Irish Rail Analysis Overview

**Last Updated: March 11, 2026 20:48 UTC**  
**Primary dataset: 260,137 station events, 171 monitored stations (live 21-minute collection)**  
Previous full analysis: March 10, 2026 (1,024,976 events)  
Supporting network model: 210 routed nodes used for graph and cascade analysis

## Core takeaway

Irish Rail continues to show strong network-level performance. Live monitoring (21-minute collection on March 11) shows average delay of **0.89 minutes** with 99.3% on-time reporting. Dublin commuter operations (DART + mainline) remain the most reliable and heavily used segment.

The Galway -> Oranmore -> Athenry single-track bottleneck previously identified remains a focus area for operational monitoring.

## Topline metrics (Live, Mar 11 20:48 UTC)

| Metric | Value | Notes |
|--------|-------|-------|
| Average delay | 0.89 minutes | Excellent punctuality |
| On-time reporting | 99.3% | Only 0.7% with delays ≥1 minute |
| Maximum delay observed | 21 minutes | Rare outlier event |
| Total events collected | 260,137 | 21-minute collection period |
| Train snapshots | 7,058 | Real-time GPS positions |
| Monitored stations | 171 | Full network coverage |
| Busiest station | Connolly (8,905 events) | Core Dublin hub |
| Train type split | 54.5% mainline, 45.5% DART | Balanced operations |

## What is well supported

### Network-wide performance

- Dublin commuter operations are the clearest strength in the dataset.
- DART services account for 45% of all events from only 23% of trains.
- The four core Dublin stations account for 120,518 events, or 11.8% of all recorded traffic.

### Capacity hotspots

- Dublin Connolly, Pearse, Tara Street, and Grand Canal Dock form the main concentration of demand.
- Malahide <-> Bray remains the most obvious high-utilization corridor.
- Hazelhatch remains a resilience concern because of its route concentration.

### Confirmed bottleneck

- Galway -> Oranmore -> Athenry is the strongest confirmed western issue in the current analysis set.
- Traced journeys show delays accumulating through the corridor rather than recovering.
- Athenry then spreads that delay into downstream routes.

See `docs/analysis/bottleneck.md` for the full case.

## Western findings need two different readings

### Confirmed issue

- Galway and Oranmore are part of a route-traced infrastructure bottleneck.

### Still uncertain

- Other western and rural delay averages may reflect weaker real-time coverage as much as real operational delay.
- `DATA_SOURCES.md` should be read alongside any station-level western ranking.

## Confidence guide

### High confidence

- Overall punctuality and network stability
- Dublin demand concentration
- DART vs intercity usage split
- Galway -> Oranmore -> Athenry as a real bottleneck with downstream propagation

### Medium confidence

- Station-by-station western delay averages outside the bottleneck corridor
- Interpretation of weaker-coverage areas without route tracing

## Recommended actions

### Immediate

- Monitor Galway, Oranmore, and Athenry as one corridor.
- Watch peak-hour knock-on effects in Dublin core stations.
- Keep `DATA_SOURCES.md` close when interpreting western delays.

### Near term

- Run focused peak-conflict analysis for Galway-Athenry.
- Review timetable buffers for Galway-originating services.
- Keep capacity review active for Malahide <-> Bray.

### Strategic

- Build the case for relieving the Galway-Oranmore-Athenry single-track constraint.
- Extend route-tracing methods to other suspected bottlenecks before making equivalent claims.

## API data pipeline (April 2026 findings)

benchmarking revealed the upstream data pipeline and its limitations:

- the API is backed by HACON/Siemens Mobility middleware feeding a SQL Server database
- the backend runs a ~60 second bulk refresh cycle for station boards, with event-driven trickles in between
- train positions refresh every ~10 seconds server-side
- trains report position via signal block track circuits, not continuous GPS
- GPS is only available on newer rolling stock (DART, newer InterCity) and updates bundled with signaling data
- western/rural lines (Galway, Westport, Cork-Cobh) frequently show lat=0,lon=0 between signal blocks
- `Servertime` and `Querytime` fields in station board responses change on every request and must be stripped before hashing

see `DATA_SOURCES.md` for full benchmarking methodology and measured refresh intervals.

## Related docs

- `docs/analysis/bottleneck.md` - technical bottleneck evidence
- `docs/analysis/operations.md` - action plan and follow-up frameworks
- `DATA_SOURCES.md` - API caveats, upstream pipeline, and measured refresh intervals
