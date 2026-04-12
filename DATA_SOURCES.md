# Data Sources & API Reference

## Irish Rail Realtime API

All data in this project is sourced from the **Irish Rail Realtime API** (http://api.irishrail.ie/realtime/realtime.asmx).

### Important Data Limitations

This information is an **estimate of train times** based on:

- The current location of train services from Iarnród Éireann's central signalling system
- The scheduled journey times from areas under local signalling control
- **Trains indicated as being late can make up time and arrive on time** - allow plenty of time to catch your train

### Weaker Coverage Areas

The central signalling system has **weaker real-time coverage** in these areas:

- Athlone - Westport/Ballina Line
- Cork Station
- Cork - Cobh/Midleton Line
- Mallow - Tralee Line
- Ballybrophy - Limerick Line
- Limerick - Ennis Line
- Limerick Junction - Waterford Line
- Greystones - Rosslare Line
- Dundalk - Belfast Line

**In these areas, queries will return scheduled times only**, not real-time estimates.

---

## Available API Functions

### 1. Get All Stations
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML`

Returns all stations with:
- StationDesc, StationCode, StationId, StationAlias
- StationLatitude, StationLongitude
- Ordered by Latitude, Longitude

### 2. Get All Stations with Type
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML_WithStationType?StationType=D`

Filters stations by type:
- `A` = All
- `M` = Mainline
- `S` = Suburban
- `D` = DART

### 3. Get Current Trains
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML`

Lists 'running trains' (between origin/destination or due to start within 10 minutes).

Returns:
- TrainStatus (N=not yet running, R=running)
- TrainLatitude, TrainLongitude
- TrainCode, TrainDate
- PublicMessage, Direction

### 4. Get Current Trains with Type
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML_WithTrainType?TrainType=D`

Same as #3 but filtered by train type (A/M/S/D).

### 5. Get Station Data By Name
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getStationDataByNameXML?StationDesc=Bayside`

Returns all trains due at station in next 90 minutes.

**With custom minutes:**
`http://api.irishrail.ie/realtime/realtime.asmx/getStationDataByNameXML?StationDesc=Bayside&NumMins=20`

(NumMins must be 5-90)

### 6. Get Station Data by StationCode
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getStationDataByCodeXML?StationCode=mhide`

Returns all trains due at station in next 90 minutes.

**With custom minutes:**
`http://api.irishrail.ie/realtime/realtime.asmx/getStationDataByCodeXML_WithNumMins?StationCode=mhide&NumMins=20`

### 7. Get Stations Filter
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getStationsFilterXML?StationText=br`

Returns station names containing the search text.

### 8. Get Train Movements
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getTrainMovementsXML?TrainId=e109&TrainDate=21%20dec%202011`

Returns all stop information for a specific train.

---

## Station Data Response Fields

Queries #5-6 return:

- **ServerTime** - Server time of query
- **TrainCode** - Unique ID for train
- **StationFullName** - Long station name
- **StationCode** - 4-5 letter abbreviation
- **QueryTime** - When query was made
- **TrainDate** - Service start date (may cross midnight)
- **Origin**, **Destination**
- **OriginTime** - Departure time from origin
- **DestinationTime** - Scheduled arrival at destination
- **Status** - Latest information
- **LastLocation** - "Arrived/Departed StationName"
- **DueIn** - Minutes until arrival
- **Late** - Minutes late
- **ExpArrival** - Expected arrival time (00:00 if originating here)
- **ExpDepart** - Expected departure time (00:00 if terminating here)
- **SchArrival** - Scheduled arrival (00:00 if originating here)
- **SchDepart** - Scheduled departure (00:00 if terminating here)
- **Direction** - Northbound, Southbound, or "To {Destination}"
- **TrainType** - DART, Intercity, etc.
- **LocationType** - O=Origin, D=Destination, S=Stop

---

## Train Movements Response Fields

- **TrainCode**
- **TrainDate**
- **LocationCode**
- **LocationFullName**
- **LocationOrder**
- **LocationType** - O=Origin, S=Stop, T=Timing Point (non-stopping), D=Destination
- **TrainOrigin**, **TrainDestination**
- **ScheduledArrival**, **ScheduledDeparture**
- **Arrival** (actual), **Departure** (actual)
- **AutoArrival**, **AutoDepart** (automatically generated?)
- **StopType** - C=Current, N=Next

---

### 9. Get HACON Trains (undocumented)
**Endpoint:** `http://api.irishrail.ie/realtime/realtime.asmx/getHaconTrainsXML`

Returns enriched train data from the HACON/Siemens Mobility upstream feed. Same trains as `getCurrentTrainsXML` but with additional fields:
- LastLocationType (A=Arrived, D=Departed, E=Expected, T=Terminated)
- TrainOrigin, TrainDestination (station codes)
- TrainOriginTime, TrainDestinationTime (full datetime)
- LastLocation, NextLocation (station/signal block codes)
- Difference (seconds early/late relative to schedule)
- ScheduledDeparture, ScheduledArrival

---

## Upstream Data Pipeline

Benchmarked April 2026. The API is a thin ASP.NET ASMX wrapper over a SQL Server database fed by HACON/Siemens Mobility middleware.

```
track circuits / signal blocks
    -> Irish Rail CTC (Centralised Traffic Control)
        -> HACON/Siemens middleware (enriches, adds GPS interpolation)
            -> SQL Server database (bulk refresh ~60s cycle)
                -> ASP.NET ASMX API (no server-side HTTP cache, hits DB per request)
```

### infrastructure

- server: `194.106.151.106` (api.irishrail.ie), hosted by Irish Rail directly (no CDN)
- technology: IIS + ASP.NET SOAP (.asmx), SQL Server backend
- HTTP headers: `Cache-Control: private, max-age=0` (no HTTP caching)
- HTTPS available but returns 500 on bare GET (SOAP endpoint)

### network path

benchmarks run through Mullvad VPN on router (always in path for all LAN traffic). base latency to Irish Rail:
- ping RTT: 11-14ms, 1ms jitter (includes Mullvad hop)
- DNS: 1ms (cached)
- TCP connect: 12ms
- TTFB: 22ms
- latency spikes (200ms+, occasional 9s outliers) are server-side IIS/SQL Server contention, not network

docker containers on bridge networks cannot reach external hosts — nftables on the host blocks outbound TCP from docker bridges. DNS resolves (docker internal resolver) but TCP times out to all external IPs. `--network host` works fine. this is unrelated to Mullvad (which was only installed April 11; the daemon has been failing since April 1).

### how train positions actually update

trains don't stream GPS continuously. position updates come from two sources:

1. **signal block tracking** (all lines): trains trigger track circuit sensors at block boundaries. the API reports the last triggered block. on rural lines, blocks can be far apart, causing large position jumps. some locations in the API are signal block IDs (e.g. `GL368`, `LJ896`) rather than station codes.

2. **GPS overlay** (newer rolling stock): DART and newer InterCity trains report GPS coordinates. but GPS only updates when the signaling data updates — it's bundled into the same feed, not independent.

trains between signal blocks with no GPS show `lat=0, lon=0` in the API. this is common on:
- Heuston-Galway line (A700, A702 etc. frequently report 0,0)
- Athlone-Westport/Ballina
- rural single-track sections

### benchmark conditions (April 2026)

- **date**: Saturday 12 April 2026
- **service level**: heavily reduced — weekend timetable + industrial action (strike) + Galway-Athenry line closed for maintenance (weekend of April 5-6)
- **active trains observed**: 34-40 (vs 70-74 on a weekday, per DB data from April 3)
- **network**: all traffic routed through Mullvad VPN on router (installed April 11)

weekday service would show ~2x more active trains, more frequent GPS updates (more trains crossing signal blocks), and more station board changes. the refresh intervals below represent the server-side pipeline cadence, which doesn't change with service level — but the amount of _new data_ per refresh does.

### measured refresh intervals (April 2026)

the upstream feed has a ~60 second bulk refresh cycle, not a cache:

| data type | refresh pattern | evidence |
|-----------|----------------|----------|
| train positions (getCurrentTrainsXML) | ~10s server-side refresh | polled at 2s intervals, data changes 8-25% of polls |
| station boards (getStationDataByCodeXML) | ~60s bulk flush + event-driven trickles | 80%+ of 171 stations update simultaneously every ~60s |
| train movements (getTrainMovementsXML) | event-driven only | changes only when train arrives/departs a stop |
| train types (WithTrainType) | same ~10s as main trains | redundant with type map approach |
| HACON trains | same feed as getCurrentTrainsXML | richer fields, same refresh cycle |

**station board timestamp fields**: every response includes `<Servertime>` and `<Querytime>` that change on every request. these must be stripped before hashing or dedup is defeated.

### per-train update granularity

individual trains don't all update at once. each train updates when it crosses a signal block boundary:

- **DART** (Dublin coastal): ~60s between updates, dense signal blocks
- **mainline intercity** (Dublin-Cork, Dublin-Belfast): ~10-40s between updates, GPS-equipped
- **western/rural** (Galway, Westport): updates only at station boundaries, sometimes minutes between position changes, GPS often 0,0

measured examples from a 90-second observation window:
- E903 (DART, Greystones-Howth): 2 updates, 62s gap
- E205 (DART, Malahide-Portmarnock): 2 updates, 62s gap
- A701 (Mainline, Sligo-Heuston): 2 updates, 10s gap
- D371 (Suburban, Hazelhatch-Dunboyne): 1 update in 90s

### tracking quality by region

| region | GPS quality | update frequency | notes |
|--------|------------|-----------------|-------|
| Dublin/DART corridor | good (non-zero GPS) | every ~60s | dense signaling, most reliable |
| Dublin suburban | good | every ~60s | similar to DART |
| mainline intercity | good on newer stock | every 10-40s | some trains jump large distances |
| cork/south | mixed | scheduled times only in weaker areas | cork station itself is weaker coverage |
| galway/west | poor (frequent 0,0 GPS) | station boundaries only | single-track sections, signal block IDs |
| belfast/north | moderate | varies | cross-border data may lag |

### database sample analysis (April 3 weekday vs April 12 weekend+strike)

the daemon collected data on April 1-3 (Tue-Thu) with significant connectivity issues — 2565/2620 train polls failed with "no response" (daemon inside docker can't reliably reach the API through Mullvad-on-router). only 19 successful train polls and 3 movement fetches were captured.

from the data that was captured (April 3, ~3 minute window):

| metric | value |
|--------|-------|
| unique trains seen (weekday) | 74 |
| trains per poll (weekday) | 70 |
| unique trains seen (weekend+strike, benchmark) | 34-40 |
| trains with GPS=0,0 | DART: 0%, Mainline: 10.5%, Suburban: 16.7% |
| movement stops that are signal blocks (not named stations) | 9.8% (291/2982) |
| station board polling | never ran (stations never loaded due to connectivity) |

GPS availability by train type from DB:

| type | total snapshots | no GPS (0,0) | % without GPS |
|------|----------------|--------------|---------------|
| DART | 236 | 0 | 0.0% |
| Mainline | 627 | 66 | 10.5% |
| Suburban | 455 | 76 | 16.7% |

the Cork-Cobh line (P530 Cobh->Cork) movement data shows signal block IDs mixed with station names: `CE454` and `CK109` are signal blocks between Little Island and Cork, confirming the track-circuit-based tracking system.

dedup effectiveness from the 19 successful polls: 36 polls were skipped (65% skip rate). of 74 unique trains, most had only 1 distinct position across all 19 polls — confirming the ~10s server-side refresh means most 3s polls see identical data.

### known daemon issues

1. **docker + Mullvad-on-router**: the daemon container frequently can't reach the API (2565/2620 polls failed = 98% failure rate). host machine has no issues. likely a docker DNS resolution or routing issue with VPN on the router.
2. **station board polling never ran**: `getAllStationsXML` failed on startup, so `station_codes` was never populated, and all board polling was skipped with "no stations loaded".
3. **station board dedup bug**: even when boards are fetched, `Servertime`/`Querytime` fields poison the content hash, causing every poll to appear "changed" and insert duplicate rows.

---

## Important Notes

**Case Sensitive** - All webservice names and parameters are case sensitive.

**No Support** - Irish Rail provides this information as-is without support.

**Data Quality** - Real-time coverage varies by region. Western and rural lines may have scheduled-time-only data.

---

## Data Collection Strategy

This project uses:

1. **`getCurrentTrainsXML`** - Every 10 seconds for live train positions (matches server refresh cycle)
2. **`getStationDataByCodeXML`** - Every 15 seconds for station events (bulk refresh is ~60s, but busy stations trickle every ~15-30s)
3. **`getTrainMovementsXML`** - Every 60 seconds for complete journey tracking
4. **`getAllStationsXML`** - Once per 24 hours for station reference data

Previous intervals (3s for trains and boards) were based on an incorrect assumption that the API updated every ~3.5s. Benchmarking in April 2026 showed ~75-90% of polls at 3s intervals returned identical data.

All data is **deduplicated** (only stored when values change) and stored in **TimescaleDB** with automatic compression after 7 days. Dedup hashes must strip `Servertime` and `Querytime` fields from station board responses to avoid false positives.
