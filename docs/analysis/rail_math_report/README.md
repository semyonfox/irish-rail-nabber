# Rail Math Report

Generated mathematical report over the live Irish Rail archive.

## Artifacts

- `report.pdf` — compiled report.
- `report.tex` — generated LaTeX source.
- `figures/*.png` — Python-rendered figures used by the report.
- `data/*.csv` — compact production exports used to build the figures.
- `summary.json` — headline metrics.
- `station_metrics.csv`, `route_metrics.csv`, `fragility_metrics.csv`, `top_chokepoints.csv` — derived analysis tables.

## Current Chokepoint Read

The report measures chokepoints as adjacent observed stop pairs where delay increases:

```text
delay gain = late(next station) - late(previous station)
```

In the current 14-day build, the strongest delay-gain candidate is `Attymon -> Athenry`, followed by `Woodlawn -> Athenry`. The practical reading is that the Athenry approach is where delay is being added, while Oranmore and Galway inherit that lateness.

## Rebuild

Fetch fresh production CSVs, regenerate figures, and compile with Tectonic:

```bash
python docs/analysis/rail_math_report/build_report.py
```

Reuse existing CSVs and only regenerate figures/LaTeX/PDF:

```bash
python docs/analysis/rail_math_report/build_report.py --skip-fetch
```

The script uses `ssh ssh.semyon.ie` and `docker exec irish_rail_db psql` for production exports.
