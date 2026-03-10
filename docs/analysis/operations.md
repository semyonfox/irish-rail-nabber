# Analysis Action Plan

Updated March 10, 2026

This document condenses the operational follow-up work that had been spread across the old briefing, alerting, predictive, and session-summary files.

## Immediate priorities

1. Monitor Galway, Oranmore, and Athenry as one corridor.
2. Add downstream alerting for Dublin-bound and other Athenry-linked routes.
3. Review timetable buffers and stagger departures where conflicts are most likely.
4. Keep Dublin core stations under peak-hour watch because they absorb western knock-on effects.

## Suggested monitoring pack

### Weekly

- Galway, Oranmore, and Athenry average delay
- Athenry accumulation above Galway baseline
- Number of trains delayed above threshold
- Knock-on impact on Dublin Heuston arrivals

### Monthly

- Peak conflict windows on the single-track section
- Capacity pressure on Malahide <-> Bray and Dublin core hubs
- Coverage-quality checks for weaker western corridors

## Alerting framework

Use a simple corridor-based alert model instead of station-by-station monitoring alone.

| Level | Galway/Athenry threshold | Cascade threshold | Expected action |
|------|---------------------------|-------------------|-----------------|
| Yellow | > 6 min | > 2 min increase | Watch and notify ops |
| Orange | > 8 min | > 3 min increase | Prepare intervention |
| Red | > 12 min | > 5 min increase | Trigger incident response |

The key idea is to alert on accumulation through Athenry, not just on raw delay at one station.

## Predictive follow-up

The existing modelling work is promising but still early.

- Current framework uses historical patterns to forecast expected delay by hour, station, and service type.
- Reported early performance is roughly 0.89 minutes RMSE, but it is based on short coverage and should be treated as exploratory.
- The biggest current limitation is data breadth: more hours, more days, and more seasonal coverage are needed before using it as a strong planning tool.

### Best next steps for the model

1. Expand training coverage across full days and full weeks.
2. Add route-specific and corridor-specific features.
3. Separate confirmed bottleneck behaviour from weaker-coverage regions.
4. Use predictions to support alerts, not replace operational judgement.

## Strategic follow-up

### Near term

- Run a dedicated Galway-Athenry peak-conflict study.
- Quantify benefits of timetable changes and added buffers.
- Validate downstream impact sizes on Dublin and Limerick-bound services.

### Medium term

- Complete a relief options study for Galway-Oranmore-Athenry.
- Assess signalling improvements and passing-loop alternatives.
- Keep Dublin corridor capacity review active alongside western bottleneck work.

## Related docs

- `docs/analysis/overview.md` - main summary
- `docs/analysis/bottleneck.md` - technical bottleneck evidence
- `DATA_SOURCES.md` - API caveats and weaker-coverage areas
