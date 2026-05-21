# Data Sources

The project is fed by one upstream: the Irish Rail Realtime API at `http://api.irishrail.ie/realtime/realtime.asmx`. Everything else (network graph, analysis) is derived from data this API produced.

For how the daemon polls it, see [scraper.md](scraper.md). For where the data ends up, see [scraper.md#schema](scraper.md#schema).

## Upstream pipeline

```
track circuits / signal blocks
  → Irish Rail CTC                              centralised traffic control
    → HACON / Siemens Mobility middleware       enriches, GPS overlay, ~60s bulk refresh
      → SQL Server                              backing store
        → ASP.NET ASMX API                      thin wrapper, no HTTP cache
```

- Host: `194.106.151.106` (no CDN, served by Irish Rail directly).
- Stack: IIS + ASP.NET SOAP (`.asmx`), SQL Server.
- HTTP headers: `Cache-Control: private, max-age=0`. Polling never hits a cache.
- HTTPS endpoint exists but returns 500 on bare `GET` (it is a SOAP endpoint).
- Documentation: none official; this doc and `private/analysis/*` are the institutional knowledge.

## Endpoints

All endpoints are case-sensitive.

### Stations (reference)

| Path | Returns |
|------|---------|
| `/getAllStationsXML` | every station: code, full name, lat/lon |
| `/getAllStationsXML_WithStationType?StationType=A\|M\|S\|D` | filter by type — All / Mainline / Suburban / DART |
| `/getStationsFilterXML?StationText=br` | name fuzzy match |

### Live trains

| Path | Returns |
|------|---------|
| `/getCurrentTrainsXML` | trains currently running or due to start within 10 minutes |
| `/getCurrentTrainsXML_WithTrainType?TrainType=A\|M\|S\|D` | filtered list |
| `/getHaconTrainsXML` | richer per-train fields (see [HACON fields](#hacon-fields)) — same trains, same refresh cycle |

### Station boards

| Path | Returns |
|------|---------|
| `/getStationDataByCodeXML?StationCode=mhide` | next 90 minutes of arrivals/departures at one station |
| `/getStationDataByCodeXML_WithNumMins?StationCode=mhide&NumMins=20` | same, custom window (5–90) |
| `/getStationDataByNameXML?StationDesc=Bayside` | same lookup by full name |

### Journeys

| Path | Returns |
|------|---------|
| `/getTrainMovementsXML?TrainId=e109&TrainDate=21%20dec%202011` | full stop sequence for one train on one date |

## Field reference

### Station board fields (`getStationData...`)

```
ServerTime          response timestamp (volatile, strip before hashing)
QueryTime           request echo timestamp (volatile, strip before hashing)
TrainCode           unique train ID for the day
TrainDate           service date (may cross midnight)
StationCode         4–5 char code
StationFullName     long station name
Origin              origin station name
Destination         destination station name
OriginTime          scheduled origin departure
DestinationTime     scheduled destination arrival
Status              status text (e.g. "Departed Drogheda")
LastLocation        "Arrived/Departed <station>" (may be a signal block ID)
DueIn               minutes until arrival
Late                minutes late (negative for early)
ExpArrival          expected arrival time          (00:00 if originating here)
ExpDepart           expected departure time        (00:00 if terminating here)
SchArrival          scheduled arrival time         (00:00 if originating here)
SchDepart           scheduled departure time       (00:00 if terminating here)
Direction           Northbound / Southbound / "To <Destination>"
TrainType           DART / Intercity / etc.
LocationType        O = Origin, D = Destination, S = Stop
```

### Train movement fields (`getTrainMovementsXML`)

```
TrainCode
TrainDate
LocationCode
LocationFullName
LocationOrder
LocationType        O = Origin, S = Stop, T = Timing point (no stop), D = Destination
TrainOrigin
TrainDestination
ScheduledArrival
ScheduledDeparture
Arrival             actual
Departure           actual
AutoArrival
AutoDepart
StopType            C = Current, N = Next
```

### Live train fields (`getCurrentTrainsXML`)

```
TrainStatus         N = not yet running, R = running
TrainLatitude
TrainLongitude
TrainCode
TrainDate
PublicMessage
Direction
```

### HACON fields

`getHaconTrainsXML` returns all the live-train fields plus:

```
LastLocationType    A = Arrived, D = Departed, E = Expected, T = Terminated
TrainOrigin         station code
TrainDestination    station code
TrainOriginTime     full datetime
TrainDestinationTime full datetime
LastLocation        station or signal block code
NextLocation        station or signal block code
Difference          seconds early/late relative to schedule
ScheduledDeparture
ScheduledArrival
```

## How train positions update

Trains do not stream GPS continuously. Position updates come from two sources:

1. **Signal block track circuits** (all lines). Trains trigger sensors at block boundaries; the API reports the last triggered block. Rural lines have widely-spaced blocks, causing large position jumps. The `LastLocation` field can be a signal block ID (e.g. `GL368`, `CE454`) instead of a station code.
2. **GPS overlay** (newer rolling stock). DART and modern InterCity report GPS, but bundled with signaling updates — not independent. Older rolling stock reports `lat=0, lon=0` between blocks.

GPS availability sampled from `train_snapshots`:

| Train type | No-GPS rate |
|------------|-------------|
| DART | 0.0% |
| Mainline | 10.5% |
| Suburban | 16.7% |

About **9.8%** of movement stops in the dataset are signal block IDs rather than named stations.

## Refresh cadence (measured)

| Data type | Server-side refresh | Notes |
|-----------|---------------------|-------|
| `getCurrentTrainsXML` | ~10s | 8–25% of polls bring new data |
| `getStationDataByCodeXML` | ~60s bulk flush + trickles | 80%+ of stations refresh in sync every ~60s |
| `getTrainMovementsXML` | event-driven | changes only when a train arrives or departs a stop |
| `getHaconTrainsXML` | ~10s | same feed as current trains, richer fields |

`ServerTime` and `QueryTime` change every single request. They must be stripped before hashing or content-based dedup is defeated. See [scraper.md](scraper.md#the-servertimequerytime-trap).

## Weak coverage regions

The central signalling system has degraded real-time coverage in these areas. Expect schedule-only data (no live updates):

- Athlone — Westport / Ballina
- Cork station and Cork — Cobh / Midleton
- Mallow — Tralee
- Ballybrophy — Limerick
- Limerick — Ennis
- Limerick Junction — Waterford
- Greystones — Rosslare
- Dundalk — Belfast

When ranking stations by delay or punctuality, exclude or annotate stations in these regions — averages there reflect data quality as much as operational reality. See [analysis/overview.md](analysis/overview.md#confidence-guide).

## Tracking quality summary

| Region | GPS quality | Update frequency |
|--------|-------------|------------------|
| Dublin / DART corridor | good | every ~60s |
| Dublin suburban | good | every ~60s |
| Mainline intercity | good on newer stock | 10–40s, occasional jumps |
| Cork / south | mixed | scheduled-only in weak areas |
| Galway / west | poor (frequent 0,0) | only at station boundaries |
| Belfast / north | moderate | cross-border data can lag |

## Caveats from upstream

- Trains indicated as late can make up time and arrive on schedule — published due-in times are estimates.
- Irish Rail provides this feed as-is, no support.
- Service levels vary heavily: weekday peak vs. weekend vs. industrial action shift the active train count from ~70 down to ~30. Refresh cadences do not change, but the volume of new data per refresh does.

## Related docs

- [scraper.md](scraper.md) — how the daemon consumes this API
- [api.md](api.md) — how the data is re-exposed to clients
- [network-graph.md](network-graph.md) — topology derived from this data + GeoJSON
- [analysis/overview.md](analysis/overview.md) — what the dataset says about the network
