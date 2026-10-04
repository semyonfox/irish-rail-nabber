"""Import the NTA's public PSO performance dashboard, without using a realtime API key.

Prepare and validate first:
  python3 import_bus_performance.py --directory /path/to/public-source-cache --output /tmp/import.sql
Apply migrations/015_bus_published_performance.sql, then the generated SQL.
Files are cached locally; --refresh explicitly downloads a new public snapshot.
No database credentials are read by this program.
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import re
import urllib.request

from psycopg import sql

SOURCE_URL = "https://www.nationaltransport.ie/public-transport-services/public-transport-contracts/operator-performance/pso-bus-performance-dashboard/pso-bus-performance-dashboard/"
# Public publish-to-web identifier embedded in SOURCE_URL. This is not an account credential.
PUBLIC_REPORT = "63c6ecf5-c53f-4349-bd6d-01ade762508d"
PUBLIC_API = "https://wabi-north-europe-o-primary-api.analysis.windows.net/public/reports/"
DIMENSIONS = ("Operator", "Line", "Year", "Period")
METRICS = (
    "on_time_pct", "early_pct", "late_pct", "actual_departures",
    "excess_wait_minutes", "planned_km", "actual_km", "lost_km", "contractual_lost_km",
)
COLUMNS = ("import_id", "operator_name", "route_short_name", "report_year", "report_period", *METRICS)
MAX_ROWS = 30000


def expression(kind: str, field: str) -> dict:
    return {kind: {"Expression": {"SourceRef": {"Source": "t"}}, "Property": field}}


def build_query(entity: str, metrics: list[tuple[str, dict]], model_id: int) -> dict:
    fields = [(name, expression("Column", name)) for name in DIMENSIONS] + metrics
    query = {
        "Version": 2, "From": [{"Name": "t", "Entity": entity, "Type": 0}],
        "Select": [{**expr, "Name": name} for name, expr in fields],
    }
    command = {"SemanticQueryDataShapeCommand": {
        "Query": query,
        "Binding": {
            "Primary": {"Groupings": [{"Projections": list(range(len(fields)))}]},
            "DataReduction": {"DataVolume": 4, "Primary": {"Window": {"Count": MAX_ROWS}}},
            "Version": 1,
        },
        "ExecutionMetricsKind": 1,
    }}
    return {"version": "1.0.0", "queries": [{"Query": {"Commands": [command]}, "QueryId": ""}],
            "cancelQueries": [], "modelId": model_id}


def metric_definitions() -> dict:
    counts = {"Aggregation": {"Expression": expression("Column", "# Actual Leave Times"), "Function": 0}}
    return {
        "lf": ("LF All", [
            ("on_time_pct", expression("Measure", "All % on Time")),
            ("early_pct", expression("Measure", "All % Early")),
            ("late_pct", expression("Measure", "All % Late")),
            ("actual_departures", counts),
        ]),
        "ewt": ("EWT All", [
            ("excess_wait_minutes", expression("Column", "AEPWT (min) w/ blanks")),
        ]),
        "lost": ("Lost KM All", [
            ("planned_km", expression("Measure", "Planned KM All")),
            ("actual_km", expression("Measure", "Actual KM All")),
            ("lost_km", expression("Measure", "Actual Lost Deduct KM NO All")),
            ("contractual_lost_km", expression("Measure", "Contractual Lost Deduct KM NO All")),
        ]),
    }


def download_json(url: str, payload: dict | None = None) -> dict:
    request = urllib.request.Request(
        url, data=None if payload is None else json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-PowerBI-ResourceKey": PUBLIC_REPORT,
                 "User-Agent": "traein-public-performance-import/1"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read(32 * 1024 * 1024 + 1)
    if len(body) > 32 * 1024 * 1024:
        raise ValueError("Public source response exceeds the import size limit")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise ValueError("Expected a public-source JSON object")
    return result


def decode_rows(payload: dict, expected_names: list[str]) -> list[dict]:
    """Decode Power BI's flat table transport, rejecting partial or changed layouts."""
    results = payload.get("results", [])
    if len(results) != 1:
        raise ValueError("Expected one query result")
    data = results[0].get("result", {}).get("data")
    if not isinstance(data, dict):
        raise ValueError("Public query returned an error or no data")
    descriptor = data["descriptor"]["Select"]
    if [field.get("Name") for field in descriptor] != expected_names:
        raise ValueError("Source columns changed; refusing a positional import")
    datasets = data["dsr"]["DS"]
    if len(datasets) != 1:
        raise ValueError("Unexpected dataset count")
    dataset = datasets[0]
    if dataset.get("RT") or dataset.get("RestartTokens") or dataset.get("IC") is not True:
        raise ValueError("Truncated source response; import needs explicit pagination")
    partitions = dataset.get("PH", [])
    if len(partitions) != 1 or set(partitions[0]) != {"DM0"}:
        raise ValueError("Only complete flat public tables are supported")
    rows = partitions[0]["DM0"]
    if len(rows) >= MAX_ROWS:
        raise ValueError("Row limit reached; refusing a potentially incomplete import")
    dictionaries = dataset.get("ValueDicts", {})
    schema = None
    previous = None
    decoded = []
    for row in rows:
        if set(row) - {"S", "C", "R", "Ø"}:
            raise ValueError("Unexpected hierarchical/source row layout")
        if "S" in row:
            if schema is not None and schema != row["S"]:
                raise ValueError("Source schema changed within a page")
            schema = row["S"]
        if schema is None or len(schema) != len(descriptor):
            raise ValueError("Missing or incomplete flat table schema")
        values = iter(row.get("C", []))
        repeat, nulls = row.get("R", 0), row.get("Ø", 0)
        if not isinstance(repeat, int) or not isinstance(nulls, int) or repeat < 0 or nulls < 0:
            raise ValueError("Invalid source bitmask")
        if (repeat | nulls) >> len(schema) or repeat & nulls:
            raise ValueError("Invalid overlapping/out-of-range source bitmask")
        raw = []
        for index, field in enumerate(schema):
            if repeat & (1 << index):
                if previous is None:
                    raise ValueError("First row cannot repeat a previous value")
                value = previous[index]
            elif nulls & (1 << index):
                value = None
            else:
                try:
                    value = next(values)
                except StopIteration:
                    raise ValueError("Source row is missing values") from None
            raw.append(value)
        sentinel = object()
        if next(values, sentinel) is not sentinel:
            raise ValueError("Source row has extra values")
        previous = raw
        by_transport_name = {}
        for field, value in zip(schema, raw, strict=True):
            if value is not None and "DN" in field and not isinstance(value, str):
                dictionary = dictionaries[field["DN"]]
                if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value < len(dictionary):
                    raise ValueError("Invalid source dictionary reference")
                value = dictionary[value]
            by_transport_name[field["N"]] = value
        decoded.append({field["Name"]: by_transport_name[field["Value"]] for field in descriptor})
    return decoded


def number(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError("Invalid published metric type")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("Non-finite published metric")
    return result


def normalize(families: dict[str, list[dict]]) -> list[dict]:
    combined: dict[tuple, dict] = {}
    for family, rows in families.items():
        seen = set()
        for raw in rows:
            operator, route = raw["Operator"], raw["Line"]
            year, period = number(raw["Year"]), raw["Period"]
            # Null dimensions cannot identify a route/period. Do not silently discard them.
            if not isinstance(operator, str) or not operator.strip() or not isinstance(route, str) or not route.strip():
                raise ValueError("Missing published route/operator identity")
            if year is None or not year.is_integer() or not 2000 <= year <= datetime.now(timezone.utc).year:
                raise ValueError("Invalid published year")
            match = re.fullmatch(r"(?:Period |P)(\d{1,2})", period or "")
            if not match or not 1 <= int(match[1]) <= 13:
                raise ValueError(f"Unrecognized reporting period: {period!r}")
            # The public EWT union labels the BE DAC contract "Bus Éireann".
            # Its source entity is EWT BE DAC; ECCC/Waterford are separate LF contracts.
            if family == "ewt" and operator == "Bus Éireann":
                operator = "Bus Éireann DAC"
            key = operator.strip(), route.strip(), int(year), int(match[1])
            if key in seen:
                raise ValueError(f"Duplicate route-period in {family}: {key!r}")
            seen.add(key)
            record = combined.setdefault(key, dict(zip(COLUMNS[1:5], key, strict=True)))
            for metric in METRICS:
                if metric not in raw:
                    continue
                value = number(raw[metric])
                if metric.endswith("_pct") and value is not None:
                    if not 0 <= value <= 1:
                        raise ValueError("Expected NTA percentage fractions in [0,1]")
                    value *= 100
                if metric == "actual_departures" and value is not None:
                    if value < 0 or not value.is_integer():
                        raise ValueError("Invalid departure count")
                    value = int(value)
                record[metric] = value
    records = []
    for key in sorted(combined):
        row = combined[key]
        # The source percentage measures coalesce no-departure periods to zero.
        # Retain their counts, but don't present missing departures as 0% punctuality.
        if row.get("actual_departures") in (None, 0):
            for metric in ("on_time_pct", "early_pct", "late_pct"):
                row[metric] = None
        records.append(row)
    return records


def prepare(directory: Path, refresh: bool) -> tuple[list[dict], dict]:
    directory.mkdir(parents=True, exist_ok=True)
    model_path = directory / "model.json"
    if refresh or not model_path.exists():
        model = download_json(PUBLIC_API + PUBLIC_REPORT + "/modelsAndExploration?preferReadOnlySession=true")
        model_path.write_text(json.dumps(model))
    else:
        model = json.loads(model_path.read_text())
    model_id = model["models"][0]["id"]
    if not isinstance(model_id, int):
        raise ValueError("Invalid public model identifier")
    responses, families = {}, {}
    for label, (entity, metrics) in metric_definitions().items():
        path = directory / (label + ".json")
        request = build_query(entity, metrics, model_id)
        if refresh or not path.exists():
            response = download_json(PUBLIC_API + "querydata?synchronous=true", request)
            path.write_text(json.dumps(response))
        else:
            response = json.loads(path.read_text())
        rows = decode_rows(response, [*DIMENSIONS, *(name for name, _ in metrics)])
        print(f"{label}: {len(rows):,} published route-period rows")
        families[label] = rows
        responses[label] = {"request": request, "response": response}
    records = normalize(families)
    if not records:
        raise ValueError("No records; refusing an empty replacement")
    bundle = {"source_url": SOURCE_URL, "source_updated_at": model["models"][0].get("LastRefreshTime"),
              "responses": responses}
    return records, bundle


def write_sql(path: Path, records: list[dict], bundle: dict) -> str:
    normalized = json.dumps(records, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    import_id = hashlib.sha256(normalized).hexdigest()
    raw = gzip.compress(json.dumps(bundle, ensure_ascii=False).encode(), mtime=0)
    years = [row["report_year"] for row in records]
    imported_at = datetime.now(timezone.utc).isoformat()
    source_updated = bundle.get("source_updated_at")
    if source_updated:
        # Power BI LastRefreshTime has no offset in the public UTC model metadata.
        source_updated = datetime.fromisoformat(source_updated).replace(tzinfo=timezone.utc).isoformat()
    literal = lambda value: sql.Literal(value).as_string()
    with path.open("w") as output:
        output.write("BEGIN;\nSET LOCAL statement_timeout = '120s';\n")
        output.write("SELECT pg_advisory_xact_lock(hashtext('nta-published-bus-import'));\n")
        output.write("INSERT INTO bus_published_imports(import_id,source_url,imported_at,source_updated_at,record_count,first_year,last_year,raw_payload_gzip) VALUES (")
        output.write(",".join(literal(v) for v in (import_id, SOURCE_URL, imported_at, source_updated, len(records), min(years), max(years), raw)))
        output.write(") ON CONFLICT(import_id) DO NOTHING;\n")
        output.write("CREATE TEMP TABLE bus_published_stage (LIKE bus_published_performance) ON COMMIT DROP;\n")
        output.write("COPY bus_published_stage (" + ",".join(COLUMNS) + ") FROM STDIN WITH (FORMAT csv, NULL '');\n")
        writer = csv.writer(output, lineterminator="\n")
        for record in records:
            writer.writerow([import_id, *(record.get(column) for column in COLUMNS[1:])])
        output.write("\\.\n")
        output.write("INSERT INTO bus_published_performance SELECT * FROM bus_published_stage ON CONFLICT DO NOTHING;\n")
        output.write("UPDATE bus_published_imports SET is_active = false WHERE is_active;\n")
        output.write("UPDATE bus_published_imports SET is_active = true WHERE import_id = " + literal(import_id) + ";\n")
        output.write("DO $$ BEGIN IF (SELECT COUNT(*) FROM bus_published_performance WHERE import_id = " + literal(import_id) + ") != " + str(len(records)) + " THEN RAISE EXCEPTION 'Published record count mismatch'; END IF; END $$;\nCOMMIT;\n")
    return import_id


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    records, bundle = prepare(args.directory, args.refresh)
    import_id = write_sql(args.output, records, bundle)
    print(json.dumps({"import_id": import_id, "records": len(records),
                      "operators": sorted({r["operator_name"] for r in records}),
                      "route_contracts": len({(r["operator_name"], r["route_short_name"]) for r in records}),
                      "first_period": min((r["report_year"], r["report_period"]) for r in records),
                      "last_period": max((r["report_year"], r["report_period"]) for r in records)}))


if __name__ == "__main__":
    main()
