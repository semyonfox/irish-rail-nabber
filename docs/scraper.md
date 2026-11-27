# Scraper (daemon)

The Python daemon polls the Irish Rail Realtime API on a fixed cadence, deduplicates by content hash, and writes time-series rows to TimescaleDB. On this branch it is the only process that writes those rail tables. Production also runs a bus daemon and a weather and traffic collector. See [ARCHITECTURE.md](ARCHITECTURE.md).

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

These are the intervals in `daemon.py` `run`, not the upstream refresh times in [data-sources.md](data-sources.md).

| Resource | Interval | Task name |
|----------|----------|-----------|
| Train positions (`getCurrentTrainsXML`) | 5s | `trains` |
| Station boards (`getStationDataByCodeXML`) | 5s | `boards` |
| Train movements (`getTrainMovementsXML`) | 60s | `movements` |
| Station reference (`getAllStationsXML`) | 24h | `stations` |
| HACON enriched feed (`getHaconTrainsXML`) | 5s | `hacon` |

`schema.sql` still seeds `fetch_schedules` at 3 seconds for trains and boards. The daemon does not read that table.

## Deduplication

Hash-based, at the layers in `daemon.py`. HACON is a separate feed from the current-trains list.

1. **Whole train list.** `fetch_trains` hashes sorted `code:lat:lon` strings. A status or message change alone is not a new hash.
2. **HACON.** `fetch_hacon` hashes the raw response, then fingerprints each train.
3. **Per station.** `fetch_all_station_boards` hashes each station board after stripping `<Servertime>` and `<Querytime>`.
4. **Per train at a station.** `_insert_station_events` fingerprints status, lateness, last location, and expected arrival and departure. Due-in is stored and is not in the fingerprint.
5. **Per journey.** `_fetch_train_movements` hashes the stops for one `train_code` and `train_date`.

### The `Servertime`/`Querytime` trap

Station board responses contain `<Servertime>` and `<Querytime>` tags that change every request. They are not train data. `fetch_all_station_boards` strips them before hashing. The other hashes do not. HACON hashes the raw response, so those tags would defeat that hash if the HACON feed includes them.

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

`docker-entrypoint.sh` applies `schema.sql` and then every file in `migrations/` on every start of this branch's daemon image. Column names and types are those SQL files. `fetched_at` is `TIMESTAMP` without time zone. The HACON table is `train_snapshots_hacon` in `migrations/005_add_hacon_snapshots.sql`. There is no table named `hacon_snapshots`.

Live rail compression is 2 days. `schema.sql` still schedules 7 days. See [ARCHITECTURE.md](ARCHITECTURE.md).

### Storage policy

- The checked-in schema schedules compression after **7 days**.
- No automatic row-retention policy is defined in the checked-in schema or migrations. Plan storage and backups accordingly; verify runtime policy settings separately.

## Daily volume (steady state)

An older draft of this page multiplied a 10 second train poll and a 15 second board poll. `daemon.py` polls both every 5 seconds. A full-table insert rate was not measured on 27 November 2026. Uncompressed chunk estimates in [ARCHITECTURE.md](ARCHITECTURE.md) cover only 25 November through 28 November. Compressed chunks have no positive row estimate.

## Known operational hazards

### nftables blocks docker bridge

The daemon container could not reach the upstream API for weeks (2565 / 2620 polls failed in early April 2026). Cause: host nftables drops outbound TCP from docker bridge networks. DNS resolved (docker internal resolver at 127.0.0.11) but TCP timed out to every external IP.

Fix options (pick one):
1. Add an nftables forward rule allowing the docker bridge subnet.
2. Set `network_mode: host` for the daemon in `docker-compose.yml` (temporary, breaks isolation).
3. Switch docker to nftables backend: `"iptables": false` in `/etc/docker/daemon.json`.

Neither `docker-compose.yml` nor `/home/semyon/server-stacks/irish-rail/stack.yaml` sets `network_mode: host`. On 27 November 2026 the running daemon's network mode was `irish-rail-nabber_default`.

### Station board startup race

`fetch_stations` runs at startup and again every 86400 seconds. If `station_codes` is empty, `fetch_all_station_boards` loads codes from the `stations` table. It logs "no stations loaded" and returns only when that table is empty too.

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
