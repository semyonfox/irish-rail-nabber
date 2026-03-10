# Galway-Athenry Bottleneck

Updated March 10, 2026

## Finding

The Galway -> Oranmore -> Athenry single-track section is a confirmed network bottleneck. Delays accumulate through the corridor and then spread through Athenry into multiple downstream routes.

## Corridor evidence

| Point in corridor | Average delay | Maximum observed delay |
|-------------------|---------------|------------------------|
| Galway | 15.6 min | 89 min |
| Oranmore | 14.4 min | 100 min |
| Athenry | 18.4 min | key signal is accumulation |

## Why this is convincing

- Athenry shows an average +3.9 minute increase across the corridor.
- Worst observed trains add 10-18 minutes through the section.
- Athenry is a junction, so the delay is multiplied rather than contained.
- The clearest downstream example is Galway -> Dublin Heuston, where traced journeys show about 5.5 minutes of additional delay reaching Dublin.

## Mechanism

- Galway -> Oranmore -> Athenry is a single-track section.
- Opposing movements force trains to wait.
- Late arrivals make the queue harder to clear.
- Once trains reach Athenry late, the delay can continue into Dublin, Limerick, Ennis, and Cork-bound paths.

## Why this matters more than older western outlier lists

- Older docs mostly flagged Galway and Oranmore as suspicious station-level outliers.
- This result is stronger because it uses route tracing and measures accumulation directly.
- That still does not prove every western delay pattern is real, but it does make this corridor the best-supported infrastructure issue in the current dataset.

## Confidence and limits

### High confidence

- Delay accumulation through Galway -> Oranmore -> Athenry
- Athenry as the downstream dispersal point
- The corridor as a meaningful operational and planning constraint

### Still limited

- Exact downstream impact size for every route
- Whether other western outliers are true bottlenecks or mostly data-quality artifacts
- Any claim in weaker-coverage corridors without comparable route tracing

## Practical implications

### Operations

- Treat Galway, Oranmore, and Athenry as one control problem.
- Alert downstream teams when the corridor crosses a delay threshold.
- Use larger buffers for Galway-originating trains during busy periods.

### Planning

- Prioritize a relief study for Galway-Oranmore-Athenry.
- Treat this section as the top infrastructure bottleneck candidate in the current analysis set.

## Related docs

- `docs/analysis/overview.md` - broader system context
- `docs/analysis/operations.md` - action plan, alerting, and predictive follow-up
- `DATA_SOURCES.md` - API caveats
