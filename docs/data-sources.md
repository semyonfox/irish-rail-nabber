# Data Sources

The rail side of the project is fed by the Irish Rail Realtime API at `http://api.irishrail.ie/realtime/realtime.asmx`. Everything in the rail network graph and rail analysis is derived from data this API produced. The separate NTA bus sources are documented in [buses.md](buses.md).

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
- There is no official field guide. `private/` is gitignored, and this repository does not track `private/analysis`.

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

These are the element names `_insert_station_events` in `daemon.py` looks up. The lookup is case-sensitive. Older notes spelled several of them in Pascal case. The parser does not.

```
Querytime           stored in query_time. Also stripped before the board hash
Traincode           train id for the day
Traindate           service date
Origin              origin station name
Destination         destination station name
Origintime          scheduled origin departure
Destinationtime     scheduled destination arrival
Status              status text
Lastlocation        last reported place. May be a signal block id
Duein               minutes until arrival. Stored, and not part of the row fingerprint
Late                minutes late. Negative means early
Exparrival          expected arrival
Expdepart           expected departure
Scharrival          scheduled arrival
Schdepart           scheduled departure
Direction           direction text
Traintype           train type text
Locationtype        O, D, or S
```

`<Servertime>` is stripped before the board hash and is not inserted. `getCurrentTrainsXML` is different. `fetch_trains` reads `TrainCode`, `TrainLatitude`, and `TrainLongitude`. `fetch_all_train_movements` reads `TrainCode` and `TrainDate`.

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

`daemon.py` strips `<Servertime>` and `<Querytime>` before the station-board hash only. The other hashes do not strip them. See [scraper.md](scraper.md#the-servertimequerytime-trap).

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

## Customer notices (connect.irishrail.ie)

The irishrail.ie website reads from a JSON API at `https://connect.irishrail.ie`. It needs an `x-api-key` header, but the key is the public one shipped in the homepage HTML (`apiKey:"..."`). The daemon reads it from the homepage at startup and again on any 401/403, so a rotation fixes itself. None of it is documented and it can change without notice.

| Path | Returns | Used |
|------|---------|------|
| `/realtime/messages` | customer notices: `head`, `text`, `start`, `end` (Europe/Dublin local), `locationCodes`, `products`, `eventStops` | every 120s into `rail_service_alerts` |
| `/realtime/live/{code}` | station board with each train's full calling pattern (`locations`) and `delay` | no, same data as the ASMX boards |
| `/realtime/trains/current`, `/realtime/stations` | JSON versions of the ASMX feeds | no |
| `/bridges/heights` | 453 rail bridges as GeoJSON with clearance in metres | no, static reference |
| `/fares/stations`, `/fares/codes/`, `/fares/names/` | fare lookup | no |
| `/realtime/trains/movements/{code}` | 403 for this key | no |

`/realtime/messages` holds the same notices Irish Rail posts on social media, already tied to station codes. The irishrail.ie terms of use restrict copying site content without written permission, so this data is for private analysis only. Ask Irish Rail before publishing or sharing anything built on it. `RAIL_NOTICES=0` turns the poller off. NTA's GTFS-Realtime alerts, which are CC BY 4.0, carry some Irish Rail notices too (see [buses.md](buses.md#service-alerts)). After a refusal or an outage the poller backs off from 10 minutes up to 6 hours and honours `Retry-After`. It only lists live and upcoming notices, so history starts when polling starts. Instagram is not usable: anonymous requests hit a login wall.

## Related docs

- [scraper.md](scraper.md) — how the daemon consumes this API
- [context-data.md](context-data.md) — Met Éireann weather and TII road traffic
- [api.md](api.md) — how the data is re-exposed to clients
- [network-graph.md](network-graph.md) — topology derived from this data + GeoJSON
- [analysis/overview.md](analysis/overview.md) — what the dataset says about the network
