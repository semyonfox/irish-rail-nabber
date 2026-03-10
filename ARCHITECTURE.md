# Architecture & Design

Irish Rail API → archive.py → irish_rail.db

## Core Components

### `IrishRailArchive` Class

Main class handling all operations:

```python
class IrishRailArchive:
    __init__(db_path)           # Connect to DB, init schema
    init_db()                   # Create tables if missing
    
    fetch_endpoint(method, params)       # HTTP GET + XML parse
    extract_text(element, default)       # Safe XML text extraction
    
    fetch_and_store_stations()           # Endpoint 1
    fetch_and_store_current_trains()     # Endpoint 3
    fetch_and_store_station_board()      # Endpoint 6/7
    fetch_all_station_boards()           # Loop all 171
    fetch_train_movements()              # Endpoint 8
    fetch_sample_train_movements()       # Sample 10
    
    run()                       # Main workflow
    print_stats()               # Print counts
    close()                     # Clean shutdown
```

## Workflow

```
run()
  ├─ fetch_and_store_stations()
  │   ├─ GET /getAllStationsXML
  │   ├─ Parse 171 stations
  │   └─ INSERT OR REPLACE
  │
  ├─ fetch_and_store_current_trains()
  │   ├─ GET /getCurrentTrainsXML
  │   ├─ Parse ~80 trains
  │   └─ INSERT
  │
  ├─ fetch_all_station_boards()
  │   ├─ SELECT all station codes
  │   ├─ FOR each station:
  │   │   ├─ GET /getStationDataByCodeXML
  │   │   ├─ Parse entries
  │   │   └─ INSERT
  │   └─ COMMIT
  │
  ├─ fetch_sample_train_movements()
  │   ├─ SELECT 10 current trains
  │   ├─ FOR each train:
  │   │   ├─ GET /getTrainMovementsXML
  │   │   ├─ Parse movements
  │   │   └─ INSERT
  │   └─ COMMIT
  │
  └─ print_stats()
      └─ SELECT COUNT(*) from all tables
```

## API Endpoints Used

| # | Endpoint | Method | Params | Returns | Rate |
|---|----------|--------|--------|---------|------|
| 1 | getAllStationsXML | GET | - | 171 stations | 1x/run |
| 3 | getCurrentTrainsXML | GET | - | ~80 trains | 1x/run |
| 6 | getStationDataByCodeXML | GET | StationCode | varies | 171x/run |
| 8 | getTrainMovementsXML | GET | TrainId, TrainDate | varies | 10x/run |

**Total API calls per run**: ~183 requests
**Typical runtime**: 30-60 seconds
**Network bandwidth**: ~500KB

## Error Handling

Simple, silent failures:

```python
try:
    response.raise_for_status()
    root = ET.fromstring(xml_content)
    # parse and store
except Exception as e:
    print(f"Error: {e}")  # Log, continue
    return  # Skip this endpoint
```

**Philosophy**: Better to skip bad data than crash. Log errors, keep going.

## Database Design

#### Why SQLite?
- No external dependencies
- Single file
- SQL support
- No server needed

### Why flat schema?
- Simple, independent tables
- Easy to query
- No join overhead

### Why accumulative data?
- Builds historical archive
- Can analyze trends
- User controls cleanup

## Performance

Bottlenecks: Network I/O > station loop > XML parsing > DB writes

Optimizations: Connection pooling, batch commits, minimal indexing

Not done: Parallel requests (overkill), async (complexity), compression

## Dependencies

**None** (only Python stdlib):
- `requests` - Standard, comes with Python
- `sqlite3` - Standard
- `xml.etree.ElementTree` - Standard
- `time` - Standard

Total: 18KB script, runs on any Python 3.7+

## Deployment Options

### Option 1: Manual
```bash
python3 archive.py
```

### Option 2: Cron
```
0 * * * * cd /path && python3 archive.py >> archive.log 2>&1
```

### Option 3: Docker
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY archive.py .
RUN apt-get update && apt-get install -y sqlite3
CMD ["python3", "archive.py"]
```

### Option 4: Systemd timer
```ini
[Unit]
Description=Irish Rail Archiver

[Timer]
OnBootSec=5min
OnUnitActiveSec=1hour

[Install]
WantedBy=timers.target
```

## Monitoring

### Check if running
```bash
pgrep python3 | grep archive
```

### View logs
```bash
tail -f archive.log
```

### Database size
```bash
ls -lh irish_rail.db
du -sh irish_rail.db
```

### Data freshness
```sql
SELECT MAX(fetched_at) FROM station_boards;
```

### Error rate
```sql
SELECT endpoint, COUNT(*) 
FROM fetch_log 
GROUP BY endpoint, status;
```

## Security

### Non-issues
- Public API (no auth needed)
- No credentials stored
- Local database only
- No sensitive data

### Best practices applied
- Timeout on HTTP (10s)
- Exception handling
- Input validation (XML parsing)
- No SQL injection (parameterized queries)

## Testing

No automated tests (intentionally simple). Manual verification sufficient.

Optional for production: Unit tests, integration tests, benchmarks.

## C++ Integration

Database is directly queryable from C++:

```cpp
#include <sqlite3.h>

sqlite3_open("irish_rail.db", &db);
sqlite3_prepare_v2(db, "SELECT ...", -1, &stmt, nullptr);
while (sqlite3_step(stmt) == SQLITE_ROW) { ... }
```

No serialization/export needed. Direct file access.

## Future Extensions

Optional: GraphQL API, WebSockets, ML predictions, dashboard, alerts, Prometheus metrics
