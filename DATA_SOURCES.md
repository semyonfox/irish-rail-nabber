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

## Important Notes

**Case Sensitive** - All webservice names and parameters are case sensitive.

**No Support** - Irish Rail provides this information as-is without support.

**Data Quality** - Real-time coverage varies by region. Western and rural lines may have scheduled-time-only data.

---

## Data Collection Strategy

This project uses:

1. **`getCurrentTrainsXML`** - Every 3 seconds for live train positions
2. **`getStationDataByCodeXML`** - Every 3 seconds for station events
3. **`getTrainMovementsXML`** - Every 60 seconds for complete journey tracking
4. **`getAllStationsXML`** - Once per 24 hours for station reference data

All data is **deduplicated** (only stored when values change) and stored in **TimescaleDB** with automatic compression after 7 days.
