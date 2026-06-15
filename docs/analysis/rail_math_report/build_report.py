#!/usr/bin/env python3
"""Build a mathematical rail-delay report from production aggregate data.

The script intentionally avoids pandas/networkx so it can run in this repo's
current lightweight Python environment. It fetches compact CSV snapshots from
the production TimescaleDB over SSH, computes graph and delay summaries with
numpy/stdlib, renders matplotlib figures, writes LaTeX, and optionally compiles
the report with tectonic.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import mean, median

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
FIGURES = ROOT / "figures"
NETWORK = Path(__file__).resolve().parents[3] / "network_graphs"
REPORT_TEX = ROOT / "report.tex"
REPORT_PDF = ROOT / "report.pdf"


SSH_TARGET = "ssh.semyon.ie"
DB_CONTAINER = "irish_rail_db"
DB_USER = "irish_data"
DB_NAME = "ireland_public"
WINDOW_DAYS = 14
MIN_LATE = -30
MAX_LATE = 180
TRANSITION_MAX_LATE = 60


@dataclass
class Stop:
    train_code: str
    train_date: str
    station_code: str
    station_desc: str
    origin: str
    destination: str
    train_type: str
    direction: str
    late: float
    fetched_at: str
    hour: int


def run_psql_copy(query: str, output_path: Path) -> None:
    """Run a COPY query inside the production DB container and write CSV."""
    DATA.mkdir(parents=True, exist_ok=True)
    sql = f"COPY ({query}) TO STDOUT WITH CSV HEADER;\n"
    cmd = [
        "ssh",
        SSH_TARGET,
        "docker",
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-U",
        DB_USER,
        "-d",
        DB_NAME,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
    ]
    print(f"fetching {output_path.name} ...")
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        subprocess.run(cmd, input=sql, text=True, stdout=handle, check=True)


def fetch_data() -> None:
    """Export compact production snapshots used by the report."""
    dedup_query = f"""
WITH dedup AS MATERIALIZED (
  SELECT DISTINCT ON (
      se.train_code, se.train_date, se.station_code, se.origin, se.destination,
      se.scheduled_arrival, se.scheduled_departure
    )
    se.train_code,
    se.train_date,
    se.station_code,
    s.station_desc,
    COALESCE(se.origin, '') AS origin,
    COALESCE(se.destination, '') AS destination,
    COALESCE(se.train_type, '') AS train_type,
    COALESCE(se.direction, '') AS direction,
    se.late_minutes,
    se.fetched_at,
    EXTRACT(HOUR FROM se.fetched_at)::int AS fetched_hour
  FROM station_events se
  LEFT JOIN stations s ON s.station_code = se.station_code
  WHERE se.fetched_at >= now() - interval '{WINDOW_DAYS} days'
    AND se.late_minutes IS NOT NULL
    AND se.train_date IS NOT NULL
  ORDER BY
    se.train_code, se.train_date, se.station_code, se.origin, se.destination,
    se.scheduled_arrival, se.scheduled_departure, se.fetched_at DESC
)
SELECT *
FROM dedup
WHERE late_minutes BETWEEN {MIN_LATE} AND {MAX_LATE}
ORDER BY fetched_at
"""
    daily_query = f"""
SELECT d::date AS day,
  COALESCE(se.n, 0) AS station_events,
  COALESCE(ts.n, 0) AS train_snapshots,
  COALESCE(hc.n, 0) AS hacon_snapshots,
  COALESCE(tm.n, 0) AS train_movements,
  COALESCE(fh.n, 0) AS fetch_history
FROM generate_series(current_date - interval '{WINDOW_DAYS - 1} days', current_date, interval '1 day') d
LEFT JOIN (
  SELECT fetched_at::date AS day, count(*) AS n
  FROM station_events
  WHERE fetched_at >= current_date - interval '{WINDOW_DAYS - 1} days'
  GROUP BY 1
) se ON se.day = d::date
LEFT JOIN (
  SELECT fetched_at::date AS day, count(*) AS n
  FROM train_snapshots
  WHERE fetched_at >= current_date - interval '{WINDOW_DAYS - 1} days'
  GROUP BY 1
) ts ON ts.day = d::date
LEFT JOIN (
  SELECT fetched_at::date AS day, count(*) AS n
  FROM train_snapshots_hacon
  WHERE fetched_at >= current_date - interval '{WINDOW_DAYS - 1} days'
  GROUP BY 1
) hc ON hc.day = d::date
LEFT JOIN (
  SELECT fetched_at::date AS day, count(*) AS n
  FROM train_movements
  WHERE fetched_at >= current_date - interval '{WINDOW_DAYS - 1} days'
  GROUP BY 1
) tm ON tm.day = d::date
LEFT JOIN (
  SELECT fetched_at::date AS day, count(*) AS n
  FROM fetch_history
  WHERE fetched_at >= current_date - interval '{WINDOW_DAYS - 1} days'
  GROUP BY 1
) fh ON fh.day = d::date
ORDER BY d::date
"""
    table_query = """
SELECT 'station_events' AS table_name, count(*) AS rows, min(fetched_at) AS first_seen, max(fetched_at) AS last_seen FROM station_events
UNION ALL SELECT 'train_snapshots', count(*), min(fetched_at), max(fetched_at) FROM train_snapshots
UNION ALL SELECT 'train_snapshots_hacon', count(*), min(fetched_at), max(fetched_at) FROM train_snapshots_hacon
UNION ALL SELECT 'train_movements', count(*), min(fetched_at), max(fetched_at) FROM train_movements
UNION ALL SELECT 'fetch_history', count(*), min(fetched_at), max(fetched_at) FROM fetch_history
ORDER BY table_name
"""
    hacon_query = f"""
SELECT train_code,
       COALESCE(train_status, '') AS train_status,
       COALESCE(train_origin, '') AS train_origin,
       COALESCE(train_destination, '') AS train_destination,
       difference_seconds / 60.0 AS difference_minutes,
       fetched_at,
       EXTRACT(HOUR FROM fetched_at)::int AS fetched_hour
FROM train_snapshots_hacon
WHERE fetched_at >= now() - interval '{WINDOW_DAYS} days'
  AND difference_seconds IS NOT NULL
  AND difference_seconds BETWEEN {MIN_LATE * 60} AND {MAX_LATE * 60}
ORDER BY fetched_at
"""
    snapshot_quality_query = f"""
SELECT COALESCE(train_type, 'unknown') AS train_type,
       count(*) AS rows,
       count(DISTINCT train_code) AS train_codes,
       count(*) FILTER (WHERE latitude = 0 OR longitude = 0) AS zero_coord_rows
FROM train_snapshots
WHERE fetched_at >= now() - interval '{WINDOW_DAYS} days'
GROUP BY train_type
ORDER BY rows DESC
"""
    transition_base = f"""
WITH dedup AS MATERIALIZED (
  SELECT DISTINCT ON (
      se.train_code, se.train_date, se.station_code, se.origin, se.destination,
      se.scheduled_arrival, se.scheduled_departure
    )
    se.train_code,
    se.train_date,
    se.station_code,
    s.station_desc,
    COALESCE(se.origin, '') AS origin,
    COALESCE(se.destination, '') AS destination,
    se.late_minutes,
    COALESCE(
      NULLIF(se.scheduled_departure, '00:00'::time),
      NULLIF(se.scheduled_arrival, '00:00'::time),
      se.scheduled_departure,
      se.scheduled_arrival
    ) AS service_time,
    se.fetched_at
  FROM station_events se
  LEFT JOIN stations s ON s.station_code = se.station_code
  WHERE se.fetched_at >= now() - interval '{WINDOW_DAYS} days'
    AND se.late_minutes BETWEEN {MIN_LATE} AND {TRANSITION_MAX_LATE}
    AND se.train_date IS NOT NULL
  ORDER BY
    se.train_code, se.train_date, se.station_code, se.origin, se.destination,
    se.scheduled_arrival, se.scheduled_departure, se.fetched_at DESC
), ordered AS (
  SELECT *,
    lag(station_code) OVER w AS prev_code,
    lag(station_desc) OVER w AS prev_name,
    lag(late_minutes) OVER w AS prev_late
  FROM dedup
  WHERE service_time IS NOT NULL
  WINDOW w AS (
    PARTITION BY train_code, train_date, origin, destination
    ORDER BY service_time, station_code
  )
), trans AS (
  SELECT
    prev_code,
    prev_name,
    station_code AS next_code,
    station_desc AS next_name,
    origin,
    destination,
    prev_late,
    late_minutes AS next_late,
    late_minutes - prev_late AS delta
  FROM ordered
  WHERE prev_code IS NOT NULL
    AND prev_code <> station_code
    AND prev_late IS NOT NULL
)
"""
    transition_query = transition_base + """
SELECT
  prev_code,
  prev_name,
  next_code,
  next_name,
  count(*) AS observations,
  round(avg(prev_late)::numeric, 3) AS prev_avg,
  round(avg(next_late)::numeric, 3) AS next_avg,
  round(avg(delta)::numeric, 3) AS delta_avg,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY delta) AS delta_p50,
  percentile_disc(0.75) WITHIN GROUP (ORDER BY delta) AS delta_p75,
  percentile_disc(0.90) WITHIN GROUP (ORDER BY delta) AS delta_p90,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY delta) AS delta_p95,
  round((count(*) FILTER (WHERE delta > 2) * 100.0 / count(*))::numeric, 3) AS pct_gain_gt2,
  round(COALESCE(
    count(*) FILTER (WHERE prev_late <= 5 AND next_late > 5) * 100.0
    / NULLIF(count(*) FILTER (WHERE prev_late <= 5), 0),
    0
  )::numeric, 3) AS pct_bad_after_ok
FROM trans
GROUP BY prev_code, prev_name, next_code, next_name
HAVING count(*) >= 20
ORDER BY avg(delta) DESC
"""
    galway_transition_query = transition_base + """
SELECT
  prev_code,
  prev_name,
  next_code,
  next_name,
  origin,
  destination,
  count(*) AS observations,
  round(avg(prev_late)::numeric, 3) AS prev_avg,
  round(avg(next_late)::numeric, 3) AS next_avg,
  round(avg(delta)::numeric, 3) AS delta_avg,
  percentile_disc(0.50) WITHIN GROUP (ORDER BY delta) AS delta_p50,
  percentile_disc(0.75) WITHIN GROUP (ORDER BY delta) AS delta_p75,
  percentile_disc(0.90) WITHIN GROUP (ORDER BY delta) AS delta_p90,
  percentile_disc(0.95) WITHIN GROUP (ORDER BY delta) AS delta_p95,
  round((count(*) FILTER (WHERE delta > 2) * 100.0 / count(*))::numeric, 3) AS pct_gain_gt2,
  round(COALESCE(
    count(*) FILTER (WHERE prev_late <= 5 AND next_late > 5) * 100.0
    / NULLIF(count(*) FILTER (WHERE prev_late <= 5), 0),
    0
  )::numeric, 3) AS pct_bad_after_ok
FROM trans
WHERE (origin = 'Dublin Heuston' AND destination = 'Galway')
   OR (origin = 'Galway' AND destination = 'Dublin Heuston')
GROUP BY prev_code, prev_name, next_code, next_name, origin, destination
HAVING count(*) >= 5
ORDER BY avg(delta) DESC
"""

    run_psql_copy(dedup_query, DATA / "dedup_stops_14d.csv")
    run_psql_copy(daily_query, DATA / "daily_counts_14d.csv")
    run_psql_copy(table_query, DATA / "table_summary.csv")
    run_psql_copy(hacon_query, DATA / "hacon_14d.csv")
    run_psql_copy(snapshot_quality_query, DATA / "snapshot_quality_14d.csv")
    run_psql_copy(transition_query, DATA / "transition_metrics_14d.csv")
    run_psql_copy(galway_transition_query, DATA / "galway_transition_metrics_14d.csv")


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def as_float(row: dict[str, str], key: str, default: float = 0.0) -> float:
    try:
        return float(row.get(key, default))
    except (TypeError, ValueError):
        return default


def as_int(row: dict[str, str], key: str, default: int = 0) -> int:
    try:
        return int(float(row.get(key, default)))
    except (TypeError, ValueError):
        return default


def read_stops() -> list[Stop]:
    rows = read_csv(DATA / "dedup_stops_14d.csv")
    stops: list[Stop] = []
    for row in rows:
        try:
            late = float(row["late_minutes"])
            hour = int(row["fetched_hour"])
        except (ValueError, KeyError):
            continue
        stops.append(
            Stop(
                train_code=row.get("train_code", ""),
                train_date=row.get("train_date", ""),
                station_code=row.get("station_code", ""),
                station_desc=row.get("station_desc", "") or row.get("station_code", ""),
                origin=row.get("origin", ""),
                destination=row.get("destination", ""),
                train_type=row.get("train_type", "") or "unknown",
                direction=row.get("direction", ""),
                late=late,
                fetched_at=row.get("fetched_at", ""),
                hour=hour,
            )
        )
    return stops


def pct(values: list[float] | np.ndarray, q: float) -> float:
    if len(values) == 0:
        return float("nan")
    return float(np.percentile(np.array(values, dtype=float), q, method="nearest"))


def grouped(values: list[Stop], key_func):
    groups: dict[str, list[Stop]] = defaultdict(list)
    for item in values:
        groups[key_func(item)].append(item)
    return groups


def station_metrics(stops: list[Stop]) -> dict[str, dict[str, float | str]]:
    metrics = {}
    for code, rows in grouped(stops, lambda s: s.station_code).items():
        late = [s.late for s in rows]
        metrics[code] = {
            "code": code,
            "name": rows[0].station_desc,
            "n": len(rows),
            "avg": mean(late),
            "median": median(late),
            "p90": pct(late, 90),
            "p95": pct(late, 95),
            "max": max(late),
            "within5": 100.0 * sum(1 for x in late if x <= 5) / len(late),
            "over15": 100.0 * sum(1 for x in late if x > 15) / len(late),
        }
    return metrics


def route_metrics(stops: list[Stop]) -> list[dict[str, float | str]]:
    out = []
    for route, rows in grouped(stops, lambda s: f"{s.origin} -> {s.destination}").items():
        if " -> " not in route or route.startswith(" ->") or route.endswith("-> "):
            continue
        late = [s.late for s in rows]
        trains = {(s.train_code, s.train_date) for s in rows}
        out.append(
            {
                "route": route,
                "n": len(rows),
                "trains": len(trains),
                "avg": mean(late),
                "p95": pct(late, 95),
                "within5": 100.0 * sum(1 for x in late if x <= 5) / len(late),
            }
        )
    return out


def load_graph() -> tuple[list[str], dict[str, str], list[tuple[str, str, float]]]:
    stations = json.loads((NETWORK / "irish_rail_stations.json").read_text(encoding="utf-8"))
    names = {row["code"]: row["name"] for row in stations}
    codes = [row["code"] for row in stations]
    edges = []
    with (NETWORK / "irish_rail_network_actual_confidence.csv").open(
        "r", encoding="utf-8", newline=""
    ) as handle:
        for row in csv.DictReader(handle):
            try:
                confidence = float(row["composite_confidence"])
            except ValueError:
                confidence = 0.0
            a = row["from_code"]
            b = row["to_code"]
            if a != b and a in names and b in names:
                edges.append((a, b, confidence))
    return codes, names, edges


def adjacency(codes: list[str], edges: list[tuple[str, str, float]], removed=()):
    removed_set = set(removed)
    idx = {code: i for i, code in enumerate(codes)}
    adj = {code: set() for code in codes}
    weighted = np.zeros((len(codes), len(codes)), dtype=float)
    for e_index, (a, b, w) in enumerate(edges):
        if e_index in removed_set:
            continue
        adj[a].add(b)
        adj[b].add(a)
        weighted[idx[a], idx[b]] = w
        weighted[idx[b], idx[a]] = w
    return adj, weighted


def connected_components(codes: list[str], adj: dict[str, set[str]]) -> list[list[str]]:
    seen = set()
    comps = []
    for code in codes:
        if code in seen:
            continue
        queue = deque([code])
        seen.add(code)
        comp = []
        while queue:
            node = queue.popleft()
            comp.append(node)
            for nxt in adj[node]:
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    return comps


def lambda2_for_component(codes: list[str], weighted: np.ndarray, comp: list[str]) -> float:
    if len(comp) < 2:
        return 0.0
    idx = {code: i for i, code in enumerate(codes)}
    comp_idx = [idx[code] for code in comp]
    a = weighted[np.ix_(comp_idx, comp_idx)]
    degree = np.diag(a.sum(axis=1))
    lap = degree - a
    vals = np.linalg.eigvalsh(lap)
    vals.sort()
    return float(vals[1]) if len(vals) > 1 else 0.0


def node_betweenness(codes: list[str], adj: dict[str, set[str]]) -> dict[str, float]:
    # Brandes algorithm for unweighted undirected graphs.
    score = {v: 0.0 for v in codes}
    for source in codes:
        stack = []
        pred = {w: [] for w in codes}
        sigma = dict.fromkeys(codes, 0.0)
        sigma[source] = 1.0
        dist = dict.fromkeys(codes, -1)
        dist[source] = 0
        queue = deque([source])
        while queue:
            v = queue.popleft()
            stack.append(v)
            for w in adj[v]:
                if dist[w] < 0:
                    queue.append(w)
                    dist[w] = dist[v] + 1
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta = dict.fromkeys(codes, 0.0)
        while stack:
            w = stack.pop()
            if sigma[w]:
                for v in pred[w]:
                    delta[v] += (sigma[v] / sigma[w]) * (1.0 + delta[w])
            if w != source:
                score[w] += delta[w]
    n = len(codes)
    if n > 2:
        scale = 1.0 / ((n - 1) * (n - 2))
        for v in score:
            score[v] *= scale
    return score


def edge_betweenness(codes: list[str], adj: dict[str, set[str]]) -> dict[tuple[str, str], float]:
    score = defaultdict(float)
    for source in codes:
        stack = []
        pred = {w: [] for w in codes}
        sigma = dict.fromkeys(codes, 0.0)
        sigma[source] = 1.0
        dist = dict.fromkeys(codes, -1)
        dist[source] = 0
        queue = deque([source])
        while queue:
            v = queue.popleft()
            stack.append(v)
            for w in adj[v]:
                if dist[w] < 0:
                    queue.append(w)
                    dist[w] = dist[v] + 1
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta = dict.fromkeys(codes, 0.0)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                c = (sigma[v] / sigma[w]) * (1.0 + delta[w]) if sigma[w] else 0.0
                edge = tuple(sorted((v, w)))
                score[edge] += c
                delta[v] += c
    for edge in list(score):
        score[edge] /= 2.0
    return dict(score)


def graph_metrics(codes: list[str], edges: list[tuple[str, str, float]], removed=()):
    adj, weighted = adjacency(codes, edges, removed)
    comps = connected_components(codes, adj)
    edge_count = sum(len(v) for v in adj.values()) // 2
    isolated = sum(1 for v in codes if not adj[v])
    cycle_rank = edge_count - len(codes) + len(comps)
    largest_lambda2 = lambda2_for_component(codes, weighted, comps[0]) if comps else 0.0
    return {
        "components": len(comps),
        "largest_component": len(comps[0]) if comps else 0,
        "edges": edge_count,
        "isolated": isolated,
        "cycle_rank": cycle_rank,
        "largest_lambda2": largest_lambda2,
        "adj": adj,
        "weighted": weighted,
        "components_list": comps,
    }


def zscores(values: list[float]) -> list[float]:
    arr = np.array(values, dtype=float)
    sd = float(arr.std())
    if sd == 0.0:
        return [0.0 for _ in values]
    return [float((v - arr.mean()) / sd) for v in arr]


def save_metric_csv(path: Path, rows: list[dict[str, object]]) -> None:
    if not rows:
        return
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def plot_daily_volume() -> None:
    rows = read_csv(DATA / "daily_counts_14d.csv")
    days = [r["day"][5:] for r in rows]
    series = [
        ("station events", "station_events", "#4c78a8"),
        ("train snapshots", "train_snapshots", "#f58518"),
        ("movements", "train_movements", "#54a24b"),
        ("HACON", "hacon_snapshots", "#b279a2"),
    ]
    bottom = np.zeros(len(rows))
    fig, ax = plt.subplots(figsize=(11, 5.8))
    for label, key, color in series:
        vals = np.array([int(r[key]) for r in rows], dtype=float)
        ax.bar(days, vals / 1000.0, bottom=bottom / 1000.0, label=label, color=color)
        bottom += vals
    ax.set_title("Raw Rows Collected Per Day")
    ax.set_ylabel("rows, thousands")
    ax.set_xlabel("date")
    ax.tick_params(axis="x", rotation=45)
    ax.grid(axis="y", alpha=0.25)
    ax.legend(ncol=2)
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_daily_volume.png", dpi=180)
    plt.close(fig)


def plot_delay_distribution(stops: list[Stop], summary: dict[str, float]) -> None:
    values = np.array([s.late for s in stops], dtype=float)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5.2))
    hist_vals = values[(values >= -5) & (values <= 60)]
    axes[0].hist(hist_vals, bins=np.arange(-5, 61, 1), color="#4c78a8", alpha=0.8)
    for label, x, color in [
        ("median", summary["p50"], "#222222"),
        ("P90", summary["p90"], "#f58518"),
        ("P95", summary["p95"], "#e45756"),
    ]:
        axes[0].axvline(x, color=color, linestyle="--", linewidth=1.8, label=f"{label} = {x:.0f}")
    axes[0].set_title("Delay Distribution, Clipped View")
    axes[0].set_xlabel("minutes late")
    axes[0].set_ylabel("deduped train-stops")
    axes[0].grid(axis="y", alpha=0.25)
    axes[0].legend()

    sorted_vals = np.sort(values)
    y = np.arange(1, len(sorted_vals) + 1) / len(sorted_vals)
    axes[1].plot(sorted_vals, y, color="#54a24b", linewidth=2)
    axes[1].set_xlim(-10, 60)
    axes[1].set_title("Empirical CDF")
    axes[1].set_xlabel("minutes late")
    axes[1].set_ylabel("P(delay <= x)")
    axes[1].grid(alpha=0.25)
    for x in [0, 5, 15]:
        axes[1].axvline(x, color="#999999", linestyle=":", linewidth=1)
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_delay_distribution.png", dpi=180)
    plt.close(fig)


def plot_hourly(stops: list[Stop]) -> None:
    rows = []
    for hour in range(24):
        vals = [s.late for s in stops if s.hour == hour]
        if vals:
            rows.append(
                {
                    "hour": hour,
                    "n": len(vals),
                    "avg": mean(vals),
                    "p95": pct(vals, 95),
                    "within5": 100.0 * sum(1 for v in vals if v <= 5) / len(vals),
                }
            )
    fig, ax1 = plt.subplots(figsize=(11, 5.4))
    hours = [r["hour"] for r in rows]
    avg = [r["avg"] for r in rows]
    p95 = [r["p95"] for r in rows]
    n = [r["n"] for r in rows]
    ax1.plot(hours, avg, marker="o", color="#4c78a8", label="average delay")
    ax1.plot(hours, p95, marker="o", color="#e45756", label="P95 delay")
    ax1.set_xlabel("hour of day")
    ax1.set_ylabel("delay minutes")
    ax1.set_xticks(range(0, 24, 2))
    ax1.grid(alpha=0.25)
    ax2 = ax1.twinx()
    ax2.bar(hours, n, color="#cccccc", alpha=0.35, label="observed stops")
    ax2.set_ylabel("deduped stops")
    lines, labels = ax1.get_legend_handles_labels()
    bars, bar_labels = ax2.get_legend_handles_labels()
    ax1.legend(lines + bars, labels + bar_labels, loc="upper left")
    ax1.set_title("Delay by Hour: Mean, Tail, and Volume")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_hourly_delay.png", dpi=180)
    plt.close(fig)


def plot_station_risk(metrics: dict[str, dict[str, float | str]]) -> None:
    rows = [m for m in metrics.values() if int(m["n"]) >= 200]
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    x = np.array([math.log10(float(r["n"])) for r in rows])
    y = np.array([float(r["avg"]) for r in rows])
    p95 = np.array([float(r["p95"]) for r in rows])
    sizes = 25 + np.clip(p95, 0, 60) * 3
    scatter = ax.scatter(x, y, s=sizes, c=p95, cmap="magma_r", alpha=0.75, edgecolor="white", linewidth=0.5)
    ax.set_xlabel("log10(observed train-stops)")
    ax.set_ylabel("average delay, minutes")
    ax.set_title("Station Risk: Delay Level vs Evidence Volume")
    ax.grid(alpha=0.25)
    for r in sorted(rows, key=lambda item: (float(item["avg"]), float(item["p95"])), reverse=True)[:12]:
        ax.annotate(str(r["name"]), (math.log10(float(r["n"])), float(r["avg"])), fontsize=8, xytext=(4, 4), textcoords="offset points")
    cbar = fig.colorbar(scatter, ax=ax)
    cbar.set_label("P95 delay, minutes")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_station_risk.png", dpi=180)
    plt.close(fig)


def plot_corridor(metrics: dict[str, dict[str, float | str]]) -> None:
    corridor = [
        ("HSTON", "Heuston"),
        ("KDARE", "Kildare"),
        ("PTRTN", "Portarlington"),
        ("TMORE", "Tullamore"),
        ("CLARA", "Clara"),
        ("ATLNE", "Athlone"),
        ("BSLOE", "Ballinasloe"),
        ("WLAWN", "Woodlawn"),
        ("ATHRY", "Athenry"),
        ("ORNMR", "Oranmore"),
        ("GALWY", "Galway"),
    ]
    labels = []
    avg = []
    p95 = []
    for code, fallback in corridor:
        if code in metrics:
            labels.append(str(metrics[code]["name"]) if metrics[code]["name"] else fallback)
            avg.append(float(metrics[code]["avg"]))
            p95.append(float(metrics[code]["p95"]))
    pos = np.arange(len(labels))
    fig, ax = plt.subplots(figsize=(12, 5.6))
    ax.bar(pos, avg, color="#4c78a8", alpha=0.8, label="average")
    ax.plot(pos, p95, color="#e45756", marker="o", linewidth=2, label="P95")
    ax.set_xticks(pos)
    ax.set_xticklabels(labels, rotation=35, ha="right")
    ax.set_ylabel("delay minutes")
    ax.set_title("Dublin Heuston to Galway Corridor Delay Profile")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_galway_corridor.png", dpi=180)
    plt.close(fig)


def plot_route_ranking(routes: list[dict[str, float | str]]) -> None:
    rows = [r for r in routes if int(r["trains"]) >= 20 and int(r["n"]) >= 100]
    rows.sort(key=lambda r: float(r["avg"]), reverse=True)
    rows = rows[:14][::-1]
    fig, ax = plt.subplots(figsize=(11, 6.3))
    labels = [str(r["route"]).replace(" -> ", " to ") for r in rows]
    y = np.arange(len(rows))
    avg = [float(r["avg"]) for r in rows]
    p95 = [float(r["p95"]) for r in rows]
    ax.barh(y, avg, color="#4c78a8", alpha=0.8, label="average")
    ax.scatter(p95, y, color="#e45756", label="P95", zorder=3)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel("delay minutes")
    ax.set_title("Highest Average-Delay Routes with Reasonable Sample Size")
    ax.grid(axis="x", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_route_ranking.png", dpi=180)
    plt.close(fig)


def transition_score(row: dict[str, str]) -> float:
    delta = max(as_float(row, "delta_avg"), 0.0)
    observations = max(as_int(row, "observations"), 1)
    gain_rate = max(as_float(row, "pct_gain_gt2"), 0.0) / 100.0
    bad_after_ok = max(as_float(row, "pct_bad_after_ok"), 0.0) / 100.0
    return delta * math.log1p(observations) * (0.65 * gain_rate + 0.35 * bad_after_ok)


def read_transition_rows(path: Path) -> list[dict[str, str]]:
    rows = read_csv(path)
    for row in rows:
        row["score"] = f"{transition_score(row):.6f}"
    return rows


def top_chokepoints(rows: list[dict[str, str]], limit: int = 12) -> list[dict[str, str]]:
    candidates = [row for row in rows if as_int(row, "observations") >= 30]
    candidates.sort(key=lambda row: transition_score(row), reverse=True)
    return candidates[:limit]


def plot_transition_chokepoints(rows: list[dict[str, str]]) -> None:
    top = top_chokepoints(rows, 14)[::-1]
    labels = [f"{r['prev_name']} -> {r['next_name']}" for r in top]
    y = np.arange(len(top))
    avg = [as_float(r, "delta_avg") for r in top]
    p90 = [as_float(r, "delta_p90") for r in top]
    gain = [as_float(r, "pct_gain_gt2") for r in top]

    fig, ax = plt.subplots(figsize=(11, 6.6))
    bars = ax.barh(y, avg, color="#4c78a8", alpha=0.82, label="average delay gain")
    ax.scatter(p90, y, color="#e45756", zorder=3, label="P90 delay gain")
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel("minutes added between adjacent observed stops")
    ax.set_title("Strongest Delay-Gain Chokepoint Candidates")
    ax.grid(axis="x", alpha=0.25)
    for bar, pct_gain in zip(bars, gain):
        ax.text(
            bar.get_width() + 0.4,
            bar.get_y() + bar.get_height() / 2,
            f"{pct_gain:.0f}% >2m",
            va="center",
            fontsize=7,
        )
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_transition_chokepoints.png", dpi=180)
    plt.close(fig)


def plot_chokepoint_score(rows: list[dict[str, str]]) -> None:
    candidates = [row for row in rows if as_int(row, "observations") >= 20]
    x = np.array([as_float(row, "delta_avg") for row in candidates])
    y = np.array([as_float(row, "pct_gain_gt2") for row in candidates])
    size = np.array([16 + math.sqrt(as_int(row, "observations")) * 7 for row in candidates])
    color = np.array([as_float(row, "pct_bad_after_ok") for row in candidates])

    fig, ax = plt.subplots(figsize=(10.5, 6.3))
    sc = ax.scatter(x, y, s=size, c=color, cmap="inferno_r", alpha=0.78, edgecolor="white", linewidth=0.4)
    ax.axvline(0, color="#777777", linestyle=":", linewidth=1)
    ax.set_xlabel("average delay gain, minutes")
    ax.set_ylabel("share of observations adding >2 minutes")
    ax.set_title("Chokepoint Score Space")
    ax.grid(alpha=0.25)
    for row in top_chokepoints(rows, 10):
        ax.annotate(
            f"{row['prev_name']} -> {row['next_name']}",
            (as_float(row, "delta_avg"), as_float(row, "pct_gain_gt2")),
            fontsize=7,
            xytext=(4, 4),
            textcoords="offset points",
        )
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("P(next >5 min | previous <=5 min), %")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_chokepoint_score.png", dpi=180)
    plt.close(fig)


def plot_galway_transition_waterfall(rows: list[dict[str, str]]) -> None:
    order = [
        "HSTON",
        "NBRGE",
        "KDARE",
        "PTRTN",
        "TMORE",
        "CLARA",
        "ATLNE",
        "BSLOE",
        "WLAWN",
        "ATMON",
        "ATHRY",
        "ORNMR",
        "GALWY",
    ]
    rank = {code: idx for idx, code in enumerate(order)}
    westbound = [
        row
        for row in rows
        if row.get("origin") == "Dublin Heuston"
        and row.get("destination") == "Galway"
        and row.get("prev_code") in rank
        and row.get("next_code") in rank
        and rank[row["next_code"]] > rank[row["prev_code"]]
    ]
    westbound.sort(key=lambda row: (rank[row["prev_code"]], rank[row["next_code"]]))
    labels = [f"{row['prev_name']} -> {row['next_name']}" for row in westbound]
    avg = [as_float(row, "delta_avg") for row in westbound]
    p90 = [as_float(row, "delta_p90") for row in westbound]
    y = np.arange(len(westbound))

    fig, ax = plt.subplots(figsize=(11, 7.2))
    colors = ["#e45756" if val > 5 else "#4c78a8" if val > 0 else "#72b7b2" for val in avg]
    ax.barh(y, avg, color=colors, alpha=0.85, label="average gain")
    ax.scatter(p90, y, color="#222222", zorder=3, label="P90 gain")
    ax.axvline(0, color="#777777", linestyle=":", linewidth=1)
    ax.set_yticks(y)
    ax.set_yticklabels(labels, fontsize=8)
    ax.set_xlabel("minutes gained/lost between observed stops")
    ax.set_title("Dublin Heuston to Galway: Segment Delay Gain")
    ax.grid(axis="x", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_galway_transition_waterfall.png", dpi=180)
    plt.close(fig)


def plot_galway_station_heatmap(stops: list[Stop]) -> None:
    corridor = [
        ("HSTON", "Heuston"),
        ("NBRGE", "Newbridge"),
        ("KDARE", "Kildare"),
        ("PTRTN", "Portarlington"),
        ("TMORE", "Tullamore"),
        ("CLARA", "Clara"),
        ("ATLNE", "Athlone"),
        ("BSLOE", "Ballinasloe"),
        ("WLAWN", "Woodlawn"),
        ("ATMON", "Attymon"),
        ("ATHRY", "Athenry"),
        ("ORNMR", "Oranmore"),
        ("GALWY", "Galway"),
    ]
    codes = [code for code, _ in corridor]
    labels = [label for _, label in corridor]
    days = sorted({s.train_date for s in stops if s.station_code in codes and s.train_date})
    values = np.full((len(codes), len(days)), np.nan)
    grouped_values: dict[tuple[str, str], list[float]] = defaultdict(list)
    for stop in stops:
        if stop.station_code in codes and stop.train_date in days:
            grouped_values[(stop.station_code, stop.train_date)].append(stop.late)
    day_index = {day: idx for idx, day in enumerate(days)}
    code_index = {code: idx for idx, code in enumerate(codes)}
    for (code, day), vals in grouped_values.items():
        values[code_index[code], day_index[day]] = min(mean(vals), 60.0)

    fig, ax = plt.subplots(figsize=(12, 6.3))
    im = ax.imshow(values, aspect="auto", cmap="magma_r", vmin=-2, vmax=35)
    ax.set_yticks(np.arange(len(labels)))
    ax.set_yticklabels(labels)
    ax.set_xticks(np.arange(len(days)))
    ax.set_xticklabels([day[5:] for day in days], rotation=45, ha="right")
    ax.set_title("Galway Corridor Daily Average Delay by Station")
    ax.set_xlabel("train date")
    ax.set_ylabel("station")
    cbar = fig.colorbar(im, ax=ax)
    cbar.set_label("average delay minutes, capped at 60")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_galway_heatmap.png", dpi=180)
    plt.close(fig)


def plot_graph_centrality(
    codes: list[str],
    names: dict[str, str],
    edges: list[tuple[str, str, float]],
    station_delay: dict[str, dict[str, float | str]],
) -> dict[str, float]:
    adj, _ = adjacency(codes, edges)
    bc = node_betweenness(codes, adj)
    stations = json.loads((NETWORK / "irish_rail_stations.json").read_text(encoding="utf-8"))
    coords = {row["code"]: (float(row["longitude"]), float(row["latitude"])) for row in stations}

    fig, ax = plt.subplots(figsize=(8.5, 9.2))
    for a, b, _ in edges:
        if a in coords and b in coords:
            ax.plot([coords[a][0], coords[b][0]], [coords[a][1], coords[b][1]], color="#dddddd", linewidth=0.75, zorder=1)
    x = [coords[c][0] for c in codes if c in coords]
    y = [coords[c][1] for c in codes if c in coords]
    cvals = [bc[c] for c in codes if c in coords]
    sizes = []
    for c in codes:
        if c not in coords:
            continue
        metric = station_delay.get(c)
        sizes.append(18 + (float(metric["avg"]) if metric else 0.0) * 9)
    sc = ax.scatter(x, y, c=cvals, s=sizes, cmap="viridis", edgecolor="white", linewidth=0.4, zorder=2)
    for code in sorted(codes, key=lambda c: bc[c], reverse=True)[:10]:
        if code in coords:
            ax.annotate(names.get(code, code), coords[code], fontsize=7, xytext=(3, 3), textcoords="offset points")
    ax.set_title("Physical Graph: Betweenness Centrality and Delay Size")
    ax.set_xlabel("longitude")
    ax.set_ylabel("latitude")
    ax.grid(alpha=0.15)
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("node betweenness")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_graph_centrality.png", dpi=180)
    plt.close(fig)
    return bc


def plot_centrality_delay(
    centrality: dict[str, float],
    station_delay: dict[str, dict[str, float | str]],
) -> None:
    rows = []
    for code, metric in station_delay.items():
        if code in centrality and int(metric["n"]) >= 150:
            rows.append((code, str(metric["name"]), centrality[code], float(metric["avg"]), float(metric["p95"]), int(metric["n"])))
    fig, ax = plt.subplots(figsize=(10.5, 6.2))
    x = np.array([r[2] for r in rows])
    y = np.array([r[3] for r in rows])
    p95 = np.array([r[4] for r in rows])
    n = np.array([r[5] for r in rows])
    sc = ax.scatter(x, y, c=p95, s=20 + np.sqrt(n), cmap="plasma_r", alpha=0.78, edgecolor="white", linewidth=0.4)
    ax.set_xlabel("physical graph betweenness")
    ax.set_ylabel("average delay, minutes")
    ax.set_title("Structure vs Operations: Important Nodes Are Not Always Late Nodes")
    ax.grid(alpha=0.25)
    for code, name, cent, avg, p, sample in sorted(rows, key=lambda r: (r[3] + 8 * r[2]), reverse=True)[:14]:
        ax.annotate(name, (cent, avg), fontsize=8, xytext=(4, 4), textcoords="offset points")
    cbar = fig.colorbar(sc, ax=ax)
    cbar.set_label("P95 delay, minutes")
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_centrality_delay.png", dpi=180)
    plt.close(fig)


def plot_fragility(codes: list[str], edges: list[tuple[str, str, float]]) -> list[dict[str, object]]:
    base = graph_metrics(codes, edges)
    edge_bc = edge_betweenness(codes, base["adj"])
    edge_order = []
    for i, (a, b, _) in enumerate(edges):
        edge_order.append((edge_bc.get(tuple(sorted((a, b))), 0.0), i))
    edge_order.sort(reverse=True)

    rows = []
    for removal_pct in range(0, 51, 5):
        remove_count = int(round(len(edges) * removal_pct / 100.0))
        removed = [idx for _, idx in edge_order[:remove_count]]
        metrics = graph_metrics(codes, edges, removed)
        rows.append(
            {
                "removal_pct": removal_pct,
                "edges": metrics["edges"],
                "components": metrics["components"],
                "largest_component": metrics["largest_component"],
                "isolated": metrics["isolated"],
                "cycle_rank": metrics["cycle_rank"],
                "largest_lambda2": metrics["largest_lambda2"],
            }
        )

    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    x = [r["removal_pct"] for r in rows]
    axes[0, 0].plot(x, [r["components"] for r in rows], marker="o", color="#e45756")
    axes[0, 0].set_title("Components")
    axes[0, 1].plot(x, [r["largest_component"] for r in rows], marker="o", color="#4c78a8")
    axes[0, 1].set_title("Largest Component Size")
    axes[1, 0].plot(x, [r["cycle_rank"] for r in rows], marker="o", color="#54a24b")
    axes[1, 0].set_title("Cycle Rank")
    axes[1, 1].plot(x, [r["largest_lambda2"] for r in rows], marker="o", color="#f58518")
    axes[1, 1].set_title("Largest Component lambda2")
    for ax in axes.ravel():
        ax.set_xlabel("top edge-betweenness edges removed (%)")
        ax.grid(alpha=0.25)
    fig.suptitle("Targeted Structural Fragility Sweep", y=1.01, fontsize=14)
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_fragility_sweep.png", dpi=180, bbox_inches="tight")
    plt.close(fig)
    return rows


def plot_hacon() -> dict[str, float]:
    rows = read_csv(DATA / "hacon_14d.csv")
    values = [float(r["difference_minutes"]) for r in rows if r.get("difference_minutes")]
    fig, ax = plt.subplots(figsize=(10, 5.4))
    vals = np.array([v for v in values if -10 <= v <= 45], dtype=float)
    ax.hist(vals, bins=np.arange(-10, 46, 1), color="#72b7b2", alpha=0.85)
    ax.axvline(pct(values, 50), color="#222222", linestyle="--", label=f"median = {pct(values, 50):.1f}")
    ax.axvline(pct(values, 95), color="#e45756", linestyle="--", label=f"P95 = {pct(values, 95):.1f}")
    ax.set_title("HACON Difference Distribution")
    ax.set_xlabel("minutes early/late")
    ax.set_ylabel("snapshots")
    ax.grid(axis="y", alpha=0.25)
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "fig_hacon_distribution.png", dpi=180)
    plt.close(fig)
    return {
        "n": len(values),
        "avg": mean(values) if values else 0.0,
        "p50": pct(values, 50),
        "p90": pct(values, 90),
        "p95": pct(values, 95),
        "over5": 100.0 * sum(1 for v in values if v > 5) / len(values) if values else 0.0,
    }


def make_summary(stops: list[Stop]) -> dict[str, float]:
    late = [s.late for s in stops]
    return {
        "n": len(stops),
        "trains": len({(s.train_code, s.train_date) for s in stops}),
        "stations": len({s.station_code for s in stops}),
        "routes": len({(s.origin, s.destination) for s in stops if s.origin and s.destination}),
        "avg": mean(late),
        "sd": float(np.std(np.array(late, dtype=float))),
        "p50": pct(late, 50),
        "p75": pct(late, 75),
        "p90": pct(late, 90),
        "p95": pct(late, 95),
        "max": max(late),
        "within5": 100.0 * sum(1 for v in late if v <= 5) / len(late),
        "over15": 100.0 * sum(1 for v in late if v > 15) / len(late),
    }


def top_rows_table(rows: list[dict[str, object]], columns: list[str], align="lrrrr") -> str:
    def tex_text(value: object) -> str:
        text = str(value)
        replacements = {
            "\\": r"\textbackslash{}",
            "&": r"\&",
            "%": r"\%",
            "$": r"\$",
            "#": r"\#",
            "_": r"\_",
            "{": r"\{",
            "}": r"\}",
        }
        for old, new in replacements.items():
            text = text.replace(old, new)
        return text

    lines = [r"\begin{tabular}{" + align + "}", r"\toprule"]
    header = " & ".join(tex_text(col) for col in columns) + r" \\"
    lines.append(header)
    lines.append(r"\midrule")
    for row in rows:
        values = []
        for col in columns:
            val = row[col]
            if isinstance(val, float):
                values.append(f"{val:.2f}")
            else:
                values.append(tex_text(val))
        lines.append(" & ".join(values) + r" \\")
    lines.append(r"\bottomrule")
    lines.append(r"\end{tabular}")
    return "\n".join(lines)


def write_report(
    summary: dict[str, float],
    station_delay: dict[str, dict[str, float | str]],
    routes: list[dict[str, float | str]],
    graph_rows: list[dict[str, object]],
    graph_base: dict[str, object],
    hacon_summary: dict[str, float],
    transitions: list[dict[str, str]],
    galway_transitions: list[dict[str, str]],
) -> None:
    table_summary = read_csv(DATA / "table_summary.csv")
    raw_rows = sum(int(r["rows"]) for r in table_summary)
    first_seen = min(r["first_seen"] for r in table_summary if r["first_seen"])
    last_seen = max(r["last_seen"] for r in table_summary if r["last_seen"])

    top_stations = []
    for row in sorted(
        [m for m in station_delay.values() if int(m["n"]) >= 250],
        key=lambda m: float(m["avg"]),
        reverse=True,
    )[:10]:
        top_stations.append(
            {
                "station": row["name"],
                "stops": row["n"],
                "avg": float(row["avg"]),
                "p95": float(row["p95"]),
                "within5": float(row["within5"]),
            }
        )

    top_routes = []
    route_candidates = [r for r in routes if int(r["trains"]) >= 20 and int(r["n"]) >= 100]
    for row in sorted(route_candidates, key=lambda r: float(r["avg"]), reverse=True)[:10]:
        top_routes.append(
            {
                "route": str(row["route"]).replace(" -> ", " to "),
                "trains": row["trains"],
                "avg": float(row["avg"]),
                "p95": float(row["p95"]),
                "within5": float(row["within5"]),
            }
        )

    top_transition_rows = []
    for row in top_chokepoints(transitions, 10):
        top_transition_rows.append(
            {
                "segment": f"{row['prev_name']} to {row['next_name']}",
                "obs": as_int(row, "observations"),
                "avg_gain": as_float(row, "delta_avg"),
                "med_gain": as_float(row, "delta_p50"),
                "p90_gain": as_float(row, "delta_p90"),
                "gain_gt2": as_float(row, "pct_gain_gt2"),
            }
        )

    top_choke = top_chokepoints(transitions, 1)[0] if transitions else {}
    top_choke_text = (
        f"{top_choke.get('prev_name', 'unknown')} to {top_choke.get('next_name', 'unknown')}"
        if top_choke
        else "unknown"
    )
    top_choke_avg = as_float(top_choke, "delta_avg") if top_choke else 0.0
    top_choke_med = as_float(top_choke, "delta_p50") if top_choke else 0.0
    top_choke_p90 = as_float(top_choke, "delta_p90") if top_choke else 0.0

    galway_westbound = [
        row
        for row in galway_transitions
        if row.get("origin") == "Dublin Heuston" and row.get("destination") == "Galway"
    ]
    galway_westbound.sort(key=lambda row: transition_score(row), reverse=True)
    galway_top = galway_westbound[0] if galway_westbound else {}
    galway_top_text = (
        f"{galway_top.get('prev_name', 'unknown')} to {galway_top.get('next_name', 'unknown')}"
        if galway_top
        else "unknown"
    )
    galway_top_avg = as_float(galway_top, "delta_avg") if galway_top else 0.0
    galway_top_p90 = as_float(galway_top, "delta_p90") if galway_top else 0.0

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    station_table = top_rows_table(top_stations, ["station", "stops", "avg", "p95", "within5"], "lrrrr")
    route_table = top_rows_table(top_routes, ["route", "trains", "avg", "p95", "within5"], "lrrrr")
    transition_table = top_rows_table(
        top_transition_rows,
        ["segment", "obs", "avg_gain", "med_gain", "p90_gain", "gain_gt2"],
        "lrrrrr",
    )

    tex = rf"""\documentclass[11pt,a4paper]{{article}}
\usepackage[T1]{{fontenc}}
\usepackage[utf8]{{inputenc}}
\usepackage{{lmodern}}
\usepackage{{geometry}}
\usepackage{{amsmath,amssymb}}
\usepackage{{booktabs}}
\usepackage{{graphicx}}
\usepackage{{float}}
\usepackage{{hyperref}}
\usepackage{{xcolor}}
\geometry{{margin=1in}}
\graphicspath{{{{figures/}}}}
\setlength{{\parskip}}{{0.6em}}
\setlength{{\parindent}}{{0pt}}

\title{{Mathematical Notes on the Irish Rail Dataset}}
\author{{Generated from irish-rail-nabber}}
\date{{{generated_at}}}

\begin{{document}}
\maketitle

\begin{{abstract}}
This report uses the current Irish Rail archive as a mathematical object rather than just a live dashboard feed. The production database contains {raw_rows:,} raw time-series rows from {first_seen} to {last_seen}. For the operational plots, repeated polling rows are collapsed to one latest observation per train-stop over the last {WINDOW_DAYS} days, leaving {summary['n']:,.0f} cleaned observations. The main result is simple: most trains are close to time, but the delay distribution has a heavy tail, and the Galway--Oranmore--Athenry corridor remains the clearest high-delay pattern.
\end{{abstract}}

\section{{Data and Cleaning}}

The raw database is large because it stores polling snapshots: station boards, live positions, HACON snapshots, train movements, and fetch history. Directly plotting raw rows would mostly measure polling frequency. I therefore deduplicate station-board observations by
\[
(\text{{train}}, \text{{date}}, \text{{station}}, \text{{origin}}, \text{{destination}}, \text{{scheduled times}})
\]
and keep the latest row for each train-stop.

I also apply a robust operational window:
\[
 -30 \leq \text{{late minutes}} \leq 180.
\]
This keeps {summary['n']:,.0f} observations and removes obvious stale cross-day artefacts such as roughly 24-hour late values. This is not hiding disruption; it is separating timetable/data glitches from interpretable delay measurements.

\begin{{table}}[H]
\centering
\begin{{tabular}}{{lr}}
\toprule
Metric & Value \\
\midrule
Cleaned train-stop observations & {summary['n']:,.0f} \\
Distinct train/date pairs & {summary['trains']:,.0f} \\
Stations observed & {summary['stations']:,.0f} \\
Route pairs observed & {summary['routes']:,.0f} \\
Average delay & {summary['avg']:.2f} min \\
Median delay & {summary['p50']:.0f} min \\
P90 delay & {summary['p90']:.0f} min \\
P95 delay & {summary['p95']:.0f} min \\
Within 5 minutes & {summary['within5']:.2f}\% \\
Over 15 minutes & {summary['over15']:.2f}\% \\
\bottomrule
\end{{tabular}}
\caption{{Cleaned operational sample for the last {WINDOW_DAYS} days.}}
\end{{table}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_daily_volume.png}}
\caption{{Raw rows collected each day. This figure is a pipeline-health view: it shows the scale of the archive, not passenger-facing punctuality.}}
\end{{figure}}

\section{{Delay Distribution}}

The median delay is {summary['p50']:.0f} minutes, P90 is {summary['p90']:.0f} minutes, and P95 is {summary['p95']:.0f} minutes. This is a heavy-tailed distribution: the ordinary day is good, but the right tail is operationally important.

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_delay_distribution.png}}
\caption{{Left: histogram of delay minutes in a readable clipped range. Right: empirical cumulative distribution. The CDF makes the reliability claim clearer than an average: about {summary['within5']:.1f}\% of cleaned train-stops are within 5 minutes.}}
\end{{figure}}

\section{{Time of Day}}

The useful statistic here is not just the mean. The P95 line shows when the bad tail grows, while the bars show how much evidence exists in that hour.

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_hourly_delay.png}}
\caption{{Average delay, P95 delay, and observation volume by hour. Peaks in the P95 curve identify hours where ordinary averages understate passenger risk.}}
\end{{figure}}

\section{{Stations and Routes}}

\begin{{table}}[H]
\centering
\small
{station_table}
\caption{{Highest average-delay stations with at least 250 cleaned observations. Values are in minutes except within5, which is percent.}}
\end{{table}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_station_risk.png}}
\caption{{Each station is a point. The x-axis is evidence volume, the y-axis is average delay, and colour/size encode the upper tail. Galway, Oranmore, and Athenry are high-delay stations with enough evidence to take seriously.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_galway_corridor.png}}
\caption{{Delay profile along the Dublin Heuston to Galway corridor. The rise around Athenry--Oranmore--Galway is the cleanest operational story in the current sample.}}
\end{{figure}}

\begin{{table}}[H]
\centering
\small
{route_table}
\caption{{Highest average-delay route pairs with at least 20 train codes and 100 cleaned observations. Values are in minutes except within5, which is percent.}}
\end{{table}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_route_ranking.png}}
\caption{{Route-level average delay and P95 delay. This avoids over-reading single tiny samples by requiring both route volume and distinct train counts.}}
\end{{figure}}

\section{{Chokepoint Analysis}}

The station ranking says where trains are late; the chokepoint calculation asks a sharper question: where does delay get added between two consecutive observed stops? For each train/date/route, stops are ordered by scheduled time and the segment delay gain is
\[
\Delta_e = \text{{late}}(\text{{next station}}) - \text{{late}}(\text{{previous station}}).
\]
Positive $\Delta_e$ means the train became later across that observed segment. To avoid a single bad stale record dominating the result, this transition analysis uses the stricter range
\[
 -30 \leq \text{{late minutes}} \leq {TRANSITION_MAX_LATE}.
\]

The current strongest recurring delay-gain segment is \textbf{{{top_choke_text}}}: average gain {top_choke_avg:.2f} minutes, median gain {top_choke_med:.0f} minutes, and P90 gain {top_choke_p90:.0f} minutes. On the Dublin Heuston--Galway route specifically, the strongest segment is \textbf{{{galway_top_text}}}, with average gain {galway_top_avg:.2f} minutes and P90 gain {galway_top_p90:.0f} minutes.

\begin{{table}}[H]
\centering
\small
{transition_table}
\caption{{Top delay-gain chokepoint candidates. \texttt{{avg\_gain}}, \texttt{{med\_gain}}, and \texttt{{p90\_gain}} are minutes added between consecutive observed stops; \texttt{{gain\_gt2}} is the percent of observations adding more than two minutes.}}
\end{{table}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_transition_chokepoints.png}}
\caption{{Strongest adjacent-stop delay-gain segments. This is the most direct ``where is the chokepoint?'' chart: it measures where lateness increases, not merely where lateness is observed.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_chokepoint_score.png}}
\caption{{Chokepoint score space. The best candidates sit high and to the right: many observations, positive average delay gain, frequent gains over two minutes, and high chance of turning an OK train into a late one.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_galway_transition_waterfall.png}}
\caption{{Dublin Heuston to Galway segment delay gains. The Athenry approach is where the current sample shows the largest recurring delay accumulation; Oranmore and Galway then inherit that lateness.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_galway_heatmap.png}}
\caption{{Daily average delay across the Galway corridor. This separates persistent corridor structure from single-day incidents.}}
\end{{figure}}

\section{{Graph View}}

For the physical network graph, stations are vertices and rail adjacencies are edges. With weighted adjacency matrix $A$, degree matrix $D$, and Laplacian
\[
L = D - A,
\]
the number of connected components is the nullity of $L$, and the second-smallest eigenvalue $\lambda_2(L)$ measures algebraic connectivity inside a connected component.

The graph model used here has {len(graph_base['components_list'][0])} stations in its largest component, {graph_base['components']} physical components, {graph_base['edges']} edges, cycle rank {graph_base['cycle_rank']}, and largest-component $\lambda_2 = {graph_base['largest_lambda2']:.4f}$. The graph is useful, but not perfect: some edges are stitched from geometry fallbacks and some service evidence is missing. Treat the graph math as structure, not gospel.

\begin{{figure}}[H]
\centering
\includegraphics[width=0.9\textwidth]{{fig_graph_centrality.png}}
\caption{{Physical rail graph. Colour is node betweenness centrality: how often a station lies on shortest paths. Point size increases with observed average delay. This separates structural importance from operational pain.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_centrality_delay.png}}
\caption{{Betweenness centrality versus average delay. Dublin nodes are structurally central; Galway-side nodes are operationally late. Those are different mathematical statements, and both are useful.}}
\end{{figure}}

\begin{{figure}}[H]
\centering
\includegraphics[width=\textwidth]{{fig_fragility_sweep.png}}
\caption{{Targeted removal sweep. Edges are ranked by edge betweenness and removed in 5\% steps. Components, largest component size, cycle rank, and $\lambda_2$ show how fragile a corridor-like rail graph is under targeted cuts.}}
\end{{figure}}

\section{{HACON Snapshot Check}}

HACON gives a separate delay-like signal through \texttt{{difference\_seconds}}. In the last {WINDOW_DAYS} days, the cleaned HACON sample has {hacon_summary['n']:,.0f} snapshots, average difference {hacon_summary['avg']:.2f} minutes, median {hacon_summary['p50']:.1f} minutes, P95 {hacon_summary['p95']:.1f} minutes, and {hacon_summary['over5']:.1f}\% over 5 minutes.

\begin{{figure}}[H]
\centering
\includegraphics[width=0.9\textwidth]{{fig_hacon_distribution.png}}
\caption{{HACON difference distribution. This is snapshot-based rather than train-stop-based, so it should confirm broad shape rather than replace station-board delay analysis.}}
\end{{figure}}

\section{{What This Means}}

The archive is now large enough for more than dashboard summaries. The strongest next mathematical directions are:

\begin{{itemize}}
\item \textbf{{Current chokepoint}}: in this sample, the clearest measured delay-adding section is the Athenry approach, especially {top_choke_text}. Operationally, Athenry is where the Galway-line problem becomes visible, while Oranmore/Galway inherit the delay.
\item \textbf{{Delay propagation}}: estimate $P(D_{{v,t+\Delta}}>5 \mid D_{{u,t}}>5)$ along corridors and rank edges by downstream amplification.
\item \textbf{{Bayesian station reliability}}: shrink low-sample stations toward the network mean so rural/noisy stations do not dominate rankings by accident.
\item \textbf{{Robust quantile prediction}}: predict P50/P90 delay rather than a single average.
\item \textbf{{Spectral fragility}}: continue the Laplacian/eigenvalue work, but report it with explicit graph-confidence caveats.
\end{{itemize}}

\section{{Limits}}

The data is much better than the old linear algebra project, but the rail graph itself is still imperfect. Station aliases exist, some physical edges have no observed service coverage, and rural/western live-position quality is weaker. The right interpretation is therefore: operational delay findings are strong where sample size is high; graph-theoretic findings are best read as structural hypotheses.

\end{{document}}
"""
    REPORT_TEX.write_text(tex, encoding="utf-8")


def write_summary_json(summary: dict[str, object]) -> None:
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def build(compile_pdf: bool) -> None:
    FIGURES.mkdir(parents=True, exist_ok=True)
    stops = read_stops()
    summary = make_summary(stops)
    station_delay = station_metrics(stops)
    routes = route_metrics(stops)
    transitions = read_transition_rows(DATA / "transition_metrics_14d.csv")
    galway_transitions = read_transition_rows(DATA / "galway_transition_metrics_14d.csv")
    codes, names, edges = load_graph()
    graph_base = graph_metrics(codes, edges)

    plot_daily_volume()
    plot_delay_distribution(stops, summary)
    plot_hourly(stops)
    plot_station_risk(station_delay)
    plot_corridor(station_delay)
    plot_route_ranking(routes)
    plot_transition_chokepoints(transitions)
    plot_chokepoint_score(transitions)
    plot_galway_transition_waterfall(galway_transitions)
    plot_galway_station_heatmap(stops)
    centrality = plot_graph_centrality(codes, names, edges, station_delay)
    plot_centrality_delay(centrality, station_delay)
    graph_rows = plot_fragility(codes, edges)
    hacon_summary = plot_hacon()

    save_metric_csv(ROOT / "station_metrics.csv", list(station_delay.values()))
    save_metric_csv(ROOT / "route_metrics.csv", routes)
    save_metric_csv(ROOT / "fragility_metrics.csv", graph_rows)
    save_metric_csv(ROOT / "top_chokepoints.csv", top_chokepoints(transitions, 30))

    write_report(
        summary,
        station_delay,
        routes,
        graph_rows,
        graph_base,
        hacon_summary,
        transitions,
        galway_transitions,
    )
    write_summary_json(
        {
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "window_days": WINDOW_DAYS,
            "cleaned_summary": summary,
            "graph_base": {
                key: value
                for key, value in graph_base.items()
                if key not in {"adj", "weighted", "components_list"}
            },
            "hacon_summary": hacon_summary,
            "top_chokepoint": top_chokepoints(transitions, 1)[0] if transitions else {},
        }
    )

    if compile_pdf:
        subprocess.run(["tectonic", REPORT_TEX.name], cwd=ROOT, check=True)
        if (ROOT / "report.pdf").exists():
            print(f"wrote {REPORT_PDF}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-fetch", action="store_true", help="reuse CSVs in data/")
    parser.add_argument("--no-compile", action="store_true", help="do not run tectonic")
    args = parser.parse_args()

    if not args.skip_fetch:
        fetch_data()
    build(compile_pdf=not args.no_compile)


if __name__ == "__main__":
    main()
