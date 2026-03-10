# Database Schema

SQLite database, 5 tables, flat schema.

## Tables

### `stations`

All Irish Rail stations (static, 171 total).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| station_id | TEXT UNIQUE | API station ID (e.g., "1") |
| station_code | TEXT UNIQUE NOT NULL | 4-5 char code (e.g., "CNLLY") |
| station_desc | TEXT NOT NULL | Full name (e.g., "Dublin Connolly") |
| station_alias | TEXT | Alternative names (often null) |
| latitude | REAL | Decimal latitude (e.g., 53.3622) |
| longitude | REAL | Decimal longitude (e.g., -6.2478) |
| fetched_at | TIMESTAMP | When record was inserted |

**Indexes**: `station_code` (unique)

**Example**:
```
CNLLY | Dublin Connolly | 53.3622 | -6.2478
```

---

### `current_trains`

Live train positions (updated each run, ~80 trains).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| train_code | TEXT NOT NULL | Unique train ID (e.g., "D561") |
| train_status | TEXT | N (not started) or R (running) |
| train_latitude | REAL | Current latitude |
| train_longitude | REAL | Current longitude |
| train_date | TEXT | Service date (e.g., "10 Mar 2026") |
| public_message | TEXT | Latest status (multiline) |
| direction | TEXT | "Northbound", "Southbound", "To [Station]" |
| fetched_at | TIMESTAMP | When record was fetched |

**Indexes**: None

**Example**:
```
D561 | R | 51.9018 | -8.4582 | 10 Mar 2026 | (in Cork to Midleton) | To Midleton
```

---

### `station_boards`

Train schedules at all stations (arrivals/departures, ~1000+ per run).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| servertime | TIMESTAMP | Server timestamp (ISO 8601) |
| querytime | TIME | Query time (HH:MM:SS) |
| train_code | TEXT NOT NULL | Train identifier |
| station_fullname | TEXT NOT NULL | Station name |
| station_code | TEXT NOT NULL | Station code |
| train_date | TEXT | Service date |
| origin | TEXT | Starting station |
| destination | TEXT | Final destination |
| origin_time | TIME | Departure from origin |
| destination_time | TIME | Arrival at destination |
| status | TEXT | "En Route", "Scheduled", "No Information" |
| last_location | TEXT | "Arrived/Departed StationName" |
| due_in | INTEGER | Minutes until arrival at this station |
| late | INTEGER | Minutes late (negative = early) |
| exp_arrival | TIME | Expected arrival at this station |
| exp_depart | TIME | Expected departure from this station |
| sch_arrival | TIME | Scheduled arrival |
| sch_depart | TIME | Scheduled departure |
| direction | TEXT | "Northbound", "Southbound", "To [Station]" |
| train_type | TEXT | "DART", "Intercity", "Train" |
| location_type | TEXT | O (Origin), S (Stop), D (Destination) |
| fetched_at | TIMESTAMP | When record was fetched |

**Indexes**: None (add manually for large queries)

**Example**:
```
P407 | Dublin Connolly | CNLLY | Hazelhatch | Grand Canal Dock 
| 10:35 | 11:23 | En Route | 0 mins | 2 mins late | 11:15 | 11:16 | Northbound | Train | S
```

---

### `train_movements`

Full journey logs per train (5-20 stops per train).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| train_code | TEXT NOT NULL | Train identifier |
| train_date | TEXT | Service date |
| location_code | TEXT | Station code |
| location_full_name | TEXT | Station name |
| location_order | INTEGER | Stop sequence (1, 2, 3...) |
| location_type | TEXT | O (Origin), S (Stop), T (Timing point), D (Destination) |
| train_origin | TEXT | Starting station |
| train_destination | TEXT | Final destination |
| scheduled_arrival | TIME | Timetabled arrival |
| scheduled_departure | TIME | Timetabled departure |
| actual_arrival | TIME | Real arrival (empty if not yet arrived) |
| actual_departure | TIME | Real departure (empty if not yet departed) |
| auto_arrival | BOOLEAN | Was arrival auto-generated? |
| auto_depart | BOOLEAN | Was departure auto-generated? |
| stop_type | TEXT | C (Current), N (Next) |
| fetched_at | TIMESTAMP | When record was fetched |

**Indexes**: None

**Example**:
```
D561 | 10 Mar 2026 | CORKY | Cork | 1 | O | Cork | Midleton 
| 00:00 | 10:00 | (empty) | 10:02 | false | false | C
```

---

### `fetch_log`

Metadata tracking (when data was collected).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PRIMARY KEY | Auto-increment |
| endpoint | TEXT NOT NULL | API endpoint called |
| item_count | INTEGER | How many records fetched |
| fetched_at | TIMESTAMP | When it was fetched |
| status | TEXT | "success", "error" |

**Indexes**: None

**Example**:
```
getAllStationsXML | 171 | 2026-03-10 11:41:23 | success
```

---

## Data Growth

### Per run (~30-60 seconds):
- **Stations**: +0 (static, replaced)
- **Current trains**: ~80 new records
- **Station boards**: ~1000 new records
- **Train movements**: ~100-200 new records
- **Fetch log**: +4 entries (one per endpoint)

**Total**: ~5-10KB per run

### Monthly:
- 1,440 runs/month (every 30s) = ~7-15MB
- 288 runs/month (every 5min) = ~1.5-3MB
- 24 runs/month (hourly) = ~120-240KB

## Performance

Add indexes for faster queries:
```sql
CREATE INDEX idx_station_boards_train_code ON station_boards(train_code);
CREATE INDEX idx_station_boards_station_code ON station_boards(station_code);
CREATE INDEX idx_station_boards_fetched_at ON station_boards(fetched_at);
```

Without indexes: <200ms. With indexes: <50ms.

## Weak Coverage Areas

Scheduled times only (no real-time):
- Athlone ↔ Westport/Ballina
- Cork Station & Cork ↔ Cobh/Midleton
- Mallow ↔ Tralee
- Ballybrophy ↔ Limerick
- Limerick ↔ Ennis
- Limerick Junction ↔ Waterford
- Greystones ↔ Rosslare
- Dundalk ↔ Belfast

For these, `actual_arrival/departure` may be empty.

## Maintenance

### Reduce database size:
```sql
-- Delete data older than 7 days
DELETE FROM station_boards WHERE fetched_at < datetime('now', '-7 days');
DELETE FROM current_trains WHERE fetched_at < datetime('now', '-7 days');
DELETE FROM train_movements WHERE fetched_at < datetime('now', '-7 days');

-- Reclaim space
VACUUM;
```

### Check data integrity:
```sql
-- Orphaned records (shouldn't happen, but check)
SELECT COUNT(*) FROM station_boards 
WHERE station_code NOT IN (SELECT station_code FROM stations);

-- Duplicate current trains
SELECT train_code, COUNT(*) 
FROM current_trains 
GROUP BY train_code, fetched_at
HAVING COUNT(*) > 1;
```

### Analyze query efficiency:
```sql
ANALYZE;
EXPLAIN QUERY PLAN
SELECT * FROM station_boards WHERE station_code = 'CNLLY' AND late > 0;
```
