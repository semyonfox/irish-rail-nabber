# Scraper (daemon)

The Python daemon polls the Irish Rail Realtime API on a fixed cadence, deduplicates by content hash, and writes time-series rows to TimescaleDB. It is the only writer of the live data tables.

For upstream API behaviour and field semantics, see [data-sources.md](data-sources.md).

## Upstream pipeline

```
track circuits / signal blocks
  → Irish Rail CTC (centralised traffic control)
    → HACON / Siemens Mobility middleware  (~60s bulk refresh)
      → SQL Server
        → ASP.NET ASMX API (no HTTP cache)
          → daemon.py
```

Position data is signal-block-triggered, not continuous GPS. Newer rolling stock (DART, modern InterCity) reports GPS bundled with signaling updates; western/rural lines often report `lat=0, lon=0` between blocks. Details in [data-sources.md](data-sources.md#how-train-positions-update).

## Polling intervals

Benchmarked April 2026. Earlier 3s intervals were ~75% wasted.

| Resource | Interval | Why |
|----------|----------|-----|
| Train positions (`getCurrentTrainsXML`) | 10s | matches the ~10s server-side refresh |
| Station boards (`getStationDataByCodeXML`) | 15s | bulk flush is ~60s but busy stations trickle ~15–30s |
| Train movements (`getTrainMovementsXML`) | 60s | event-driven; changes only on arrival/departure |
| Station reference (`getAllStationsXML`) | 24h | static |
| HACON enriched feed (`getHaconTrainsXML`) | 10s | same cadence, richer fields per train |

## Deduplication

Hash-based at four granularities. Without this, the database would grow ~10× faster with identical rows.

1. **Whole-endpoint** — the trains XML is hashed as one blob.
2. **Per-station** — each of the 171 station boards is hashed independently.
3. **Per-train-per-station** — station events are fingerprinted by `(status, late, location, due_in, expected times)` minus volatile fields.
4. **Per-journey** — `train_movements` is hashed per `(train_code, train_date)`.

### The `Servertime`/`Querytime` trap

Every Irish Rail response contains `<Servertime>` and `<Querytime>` tags that change every request — not real data. Hashing raw XML defeats dedup entirely because every poll appears "changed".

The fix is in `daemon.py`:

```python
_TIMESTAMP_RE = re.compile(
    r"<(?:Servertime|Querytime)>[^<]*</(?:Servertime|Querytime)>"
)
cleaned = _TIMESTAMP_RE.sub("", xml_body)
content_hash = hashlib.md5(cleaned.encode()).hexdigest()
```

This was the root cause of duplicate station_events rows before April 2026.

## Schema

Schema lives in `schema.sql` and runs at container startup. Migrations under `migrations/` apply incrementally.

### Reference

```sql
stations (
    station_code      TEXT PRIMARY KEY,
    name              TEXT,
    latitude          DOUBLE PRECISION,
    longitude         DOUBLE PRECISION,
    station_type      TEXT          -- M, S, D
)
```

### Hypertables (time-series)

```sql
train_snapshots (
    train_code     TEXT,
    train_date     DATE,
    fetched_at     TIMESTAMPTZ,
    train_status   TEXT,
    latitude       DOUBLE PRECISION,
    longitude      DOUBLE PRECISION,
    public_message TEXT,
    direction      TEXT,
    train_type     TEXT
)  -- hypertable by fetched_at

station_events (
    station_code   TEXT,
    train_code     TEXT,
    train_date     DATE,
    fetched_at     TIMESTAMPTZ,
    sch_arrival    TIME,
    sch_depart     TIME,
    exp_arrival    TIME,
    exp_depart     TIME,
    due_in         INT,
    late           INT,
    status         TEXT,
    last_location  TEXT,
    origin         TEXT,
    destination    TEXT,
    location_type  TEXT
)  -- hypertable by fetched_at

train_movements (
    train_code         TEXT,
    train_date         DATE,
    location_code      TEXT,
    location_full_name TEXT,
    location_order     INT,
    location_type      TEXT,            -- O, S, T, D
    scheduled_arrival  TIME,
    scheduled_depart   TIME,
    arrival            TIME,
    depart             TIME,
    stop_type          TEXT,            -- C, N
    fetched_at         TIMESTAMPTZ
)  -- hypertable by fetched_at

hacon_snapshots (
    train_code            TEXT,
    fetched_at            TIMESTAMPTZ,
    last_location_type    TEXT,         -- A, D, E, T
    last_location         TEXT,
    next_location         TEXT,
    train_origin          TEXT,
    train_destination     TEXT,
    train_origin_time     TIMESTAMPTZ,
    train_destination_time TIMESTAMPTZ,
    difference_seconds    INT,
    scheduled_arrival     TIMESTAMPTZ,
    scheduled_departure   TIMESTAMPTZ
)  -- hypertable by fetched_at
```

### Audit

```sql
fetch_history (
    endpoint      TEXT,
    status        TEXT,            -- success, skipped, failed
    error_msg     TEXT,
    fetched_at    TIMESTAMPTZ,
    rows_inserted INT
)
```

### Retention

- Auto-compress after **7 days** (~90% space savings)
- Auto-drop after **90 days**
- Steady-state size: ~2–5 GB

## Daily volume (steady state)

| Table | Inserts/day | Notes |
|-------|-------------|-------|
| `train_snapshots` | ~50 k | 10s poll × ~40 trains × ~15% change rate |
| `station_events` | ~100 k | 15s poll × 171 stations × ~10% change rate |
| `train_movements` | ~5 k | event-driven, journey hash dedup |
| `hacon_snapshots` | ~30 k | per-train dedup |

## Known operational hazards

### nftables blocks docker bridge

The daemon container could not reach the upstream API for weeks (2565 / 2620 polls failed in early April 2026). Cause: host nftables drops outbound TCP from docker bridge networks. DNS resolved (docker internal resolver at 127.0.0.11) but TCP timed out to every external IP.

Fix options (pick one):
1. Add an nftables forward rule allowing the docker bridge subnet.
2. Set `network_mode: host` for the daemon in `docker-compose.yml` (temporary, breaks isolation).
3. Switch docker to nftables backend: `"iptables": false` in `/etc/docker/daemon.json`.

Option 2 is what is currently deployed; option 1 is the correct long-term fix.

### Station board startup race

`getAllStationsXML` runs once at boot to populate the station code list. If it fails, every subsequent station board poll is skipped with "no stations loaded" and the daemon silently stops collecting board data. The fix is to retry station fetch on a timer until it succeeds.

## Quick verification

```bash
docker compose up -d
sleep 30
docker compose logs daemon --tail=20
```

Full verification checklist in [testing.md](testing.md).

## Related docs

- [api.md](api.md) — how the data is read out
- [data-sources.md](data-sources.md) — upstream API reference and weak-coverage areas
- [deployment.md](deployment.md) — backups and recovery
- [analysis/overview.md](analysis/overview.md) — what the data shows
