# API Endpoints - Quick Reference

Base URL: `http://api.irishrail.ie/realtime/realtime.asmx`

10 endpoints total, uses 4. Case-sensitive. No API key.

---

## Endpoints Used

### 1. `getAllStationsXML`

Get all Irish Rail stations.

```
GET /getAllStationsXML
Returns: 171 stations
Fields: StationDesc, StationCode, StationId, StationAlias, StationLatitude, StationLongitude
```

Used in: `fetch_and_store_stations()`

---

### 2. `getAllStationsXML_WithStationType`

Get stations filtered by type.

```
GET /getAllStationsXML_WithStationType?StationType=A
Parameters:
  - StationType: A (All), M (Mainline), S (Suburban), D (DART)
Returns: Filtered stations (same fields as #1)
```

Not used in archive (could add if needed).

---

### 3. `getCurrentTrainsXML`

Get live running trains.

```
GET /getCurrentTrainsXML
Returns: ~80-85 trains (in route or due within 10 mins)
Fields: TrainCode, TrainStatus, TrainLatitude, TrainLongitude, 
        TrainDate, PublicMessage, Direction
```

Used in: `fetch_and_store_current_trains()`

---

### 4. `getCurrentTrainsXML_WithTrainType`

Get live trains filtered by type.

```
GET /getCurrentTrainsXML_WithTrainType?TrainType=D
Parameters:
  - TrainType: A (All), M (Mainline), S (Suburban), D (DART)
Returns: Filtered trains (same fields as #3)
```

Not used in archive.

---

### 5. `getStationDataByNameXML`

Get station board by station name.

```
GET /getStationDataByNameXML?StationDesc=Dublin Connolly
Optional: &NumMins=20 (5-90, default 90)
Returns: ~10-50 trains next 90 mins (or X mins)
Fields: 20+ fields including status, times, delays, types
```

Not used (uses #6 instead).

---

### 6. `getStationDataByCodeXML`

Get station board by station code.

```
GET /getStationDataByCodeXML?StationCode=CNLLY
Returns: ~10-50 trains next 90 mins
Fields: 20+ fields (same as #5)
```

Used in: `fetch_and_store_station_board()` (looped 171 times)

---

### 7. `getStationDataByCodeXML_WithNumMins`

Get station board by code with time limit.

```
GET /getStationDataByCodeXML_WithNumMins?StationCode=CNLLY&NumMins=20
Parameters:
  - StationCode: 4-5 char code (case-insensitive)
  - NumMins: 5-90 (default 90)
Returns: Trains due in next X minutes (same fields as #6)
```

Not used in archive (could add for faster queries).

---

### 8. `getStationsFilterXML`

Search stations by partial text.

```
GET /getStationsFilterXML?StationText=dublin
Returns: ~1-10 stations matching text
Fields: StationDesc_sp (HTML encoded), StationDesc, StationCode
```

Not used in archive.

---

### 9. `getTrainMovementsXML`

Get full journey log for a train.

```
GET /getTrainMovementsXML?TrainId=D561&TrainDate=10%20Mar%202026
Parameters:
  - TrainId: Train code (case-sensitive)
  - TrainDate: "DD MMM YYYY" format (URL encoded)
Returns: 5-20 stops with times
Fields: TrainCode, TrainDate, LocationCode, LocationFullName, 
        LocationOrder, LocationType, TrainOrigin, TrainDestination,
        ScheduledArrival, ScheduledDeparture, Arrival, Departure,
        AutoArrival, AutoDepart, StopType
```

Used in: `fetch_train_movements()` (sampled 10 trains)

---

### 10. (Undocumented)

Not listed in official docs.

---

## Implementation Notes

### Calls per run

```
getAllStationsXML           1x  (171 stations)
getCurrentTrainsXML         1x  (~80 trains)
getStationDataByCodeXML   171x  (all stations)
getTrainMovementsXML       10x  (sample trains)
────────────────────────────────
Total                     183 API calls
```

### Typical response times

| Endpoint | Size | Time |
|----------|------|------|
| getAllStationsXML | 50KB | 200ms |
| getCurrentTrainsXML | 30KB | 150ms |
| getStationDataByCodeXML | 2-5KB | 100-300ms |
| getTrainMovementsXML | 1-3KB | 50-200ms |

### Data coverage

**Real-time data (actual positions & times)**:
- All mainline services
- DART services
- Suburban services

**Scheduled times only (no real-time data)**:
- Athlone ↔ Westport/Ballina
- Cork Station
- Cork ↔ Cobh/Midleton
- Mallow ↔ Tralee
- Ballybrophy ↔ Limerick
- Limerick ↔ Ennis
- Limerick Junction ↔ Waterford
- Greystones ↔ Rosslare
- Dundalk ↔ Belfast

### API behavior

- **Rate limits**: None published (use 100ms+ between calls)
- **Caching**: Cached every ~2.7 seconds
- **Zero-delay requests**: All return identical cached data
- **Position updates**: 1-5 trains per cycle
- **Errors**: Returns empty XML array

### Field reference

#### Station fields (from #1)
- `StationDesc` - Full name
- `StationCode` - 4-5 char code
- `StationId` - Numeric ID
- `StationAlias` - Alternative names
- `StationLatitude` - Decimal lat
- `StationLongitude` - Decimal lon

#### Train fields (from #3)
- `TrainCode` - Unique ID
- `TrainStatus` - N (not started) or R (running)
- `TrainLatitude` - Current lat
- `TrainLongitude` - Current lon
- `TrainDate` - Service date
- `PublicMessage` - Latest status (multiline, `\n` delimited)
- `Direction` - Northbound/Southbound/To [Station]

#### Station board fields (from #6)
- `Servertime` - ISO 8601 timestamp
- `Traincode` - Train identifier
- `Stationfullname` - Station name
- `Stationcode` - Station code
- `Querytime` - Query time
- `Traindate` - Service date
- `Origin` - Starting station
- `Destination` - Final destination
- `Origintime` - Departure from origin
- `Destinationtime` - Arrival at destination
- `Status` - "En Route", "Scheduled", "No Information"
- `Lastlocation` - "Arrived/Departed StationName"
- `Duein` - Minutes until arrival
- `Late` - Minutes late
- `Exparrival` - Expected arrival (updated in real-time)
- `Expdepart` - Expected departure (updated in real-time)
- `Scharrival` - Scheduled arrival
- `Schdepart` - Scheduled departure
- `Direction` - Northbound/Southbound/To [Station]
- `Traintype` - "DART", "Intercity", "Train"
- `Locationtype` - O (Origin), S (Stop), D (Destination)

#### Train movement fields (from #9)
- `TrainCode` - Train identifier
- `TrainDate` - Service date
- `LocationCode` - Station code
- `LocationFullName` - Station name
- `LocationOrder` - Stop sequence (1, 2, 3...)
- `LocationType` - O (Origin), S (Stop), T (Timing point), D (Destination)
- `TrainOrigin` - Starting station
- `TrainDestination` - Final destination
- `ScheduledArrival` - Timetabled arrival (HH:MM)
- `ScheduledDeparture` - Timetabled departure (HH:MM)
- `Arrival` - Actual arrival (empty if not yet)
- `Departure` - Actual departure (empty if not yet)
- `AutoArrival` - true/false (auto-generated?)
- `AutoDepart` - true/false (auto-generated?)
- `StopType` - C (Current), N (Next)

---

## Usage Examples

### Get all stations
```bash
curl "http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML"
```

### Get live trains
```bash
curl "http://api.irishrail.ie/realtime/realtime.asmx/getCurrentTrainsXML"
```

### Get Dublin Connolly board
```bash
curl "http://api.irishrail.ie/realtime/realtime.asmx/getStationDataByCodeXML?StationCode=CNLLY"
```

### Get specific train movements
```bash
curl "http://api.irishrail.ie/realtime/realtime.asmx/getTrainMovementsXML?TrainId=D561&TrainDate=10%20Mar%202026"
```

---

## Notes

- All responses are XML
- API provided as-is by Irish Rail
- No formal support
- Data may be outdated (see weak coverage areas)
- Trains can be late but may catch up - allow extra time
