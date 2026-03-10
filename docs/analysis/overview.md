# Irish Rail Analysis Overview

Updated March 10, 2026  
Primary dataset: 1,024,976 station events, 257 trains, 171 monitored stations  
Supporting network model: 210 routed nodes used for graph and cascade analysis

## Core takeaway

Irish Rail looks strong at network level: average delay is 1 minute, on-time reporting is about 99.5%, and Dublin commuter operations are the most reliable and most heavily used part of the system.

The most important newer finding is that the Galway -> Oranmore -> Athenry single-track section is not just a suspicious western outlier. Route tracing supports it as a real bottleneck with measurable delay accumulation and downstream impact.

## Topline metrics

| Metric | Value | Notes |
|--------|-------|-------|
| Average delay | 1 minute | Strong network-wide punctuality |
| On-time reporting | 99.5% | Delays and cancellations are rare in the feed |
| Unique trains | 257 | Good operational spread |
| Busiest station | Dublin Connolly (36,605 events) | Core Dublin hub |
| Busiest route | Malahide <-> Bray (84,231 events) | Highest-volume corridor |
| Top 10 route share | 47% of all events | Demand is concentrated |

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

## Related docs

- `docs/analysis/bottleneck.md` - technical bottleneck evidence
- `docs/analysis/operations.md` - action plan and follow-up frameworks
- `DATA_SOURCES.md` - API caveats and coverage limits
