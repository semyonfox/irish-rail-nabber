# Setup & Installation

## Requirements

- Python 3.7+
- No external packages (requests, sqlite3 are stdlib)

## Installation

```bash
cd /home/semyon/code/personal/irish-rail-nabber
python3 --version  # Verify 3.7+
```

## Running the Archiver

### One-time fetch:
```bash
python3 archive.py
```

This will:
- Fetch all 171 Irish Rail stations
- Fetch ~80 live trains with real-time positions
- Fetch ~1000+ station board entries (arrivals/departures)
- Fetch ~100-200 train movement records
- Store everything in `irish_rail.db` (SQLite)
- Print statistics

### Scheduled archiving (cron):

For hourly collection:
```bash
0 * * * * cd /home/semyon/code/personal/irish-rail-nabber && python3 archive.py
```

For every 5 minutes:
```bash
*/5 * * * * cd /home/semyon/code/personal/irish-rail-nabber && python3 archive.py
```

Or with nohup in background:
```bash
while true; do python3 archive.py; sleep 300; done &
```

## Database

The script creates `irish_rail.db` (SQLite format).

### Query examples:

```bash
# Open database
sqlite3 irish_rail.db

# List tables
.tables

# Count records
SELECT COUNT(*) FROM stations;
SELECT COUNT(*) FROM current_trains;
SELECT COUNT(*) FROM station_boards;

# Find a station
SELECT * FROM stations WHERE station_desc LIKE '%Dublin%';

# Get recent trains
SELECT train_code, train_latitude, train_longitude, fetched_at 
FROM current_trains 
ORDER BY fetched_at DESC 
LIMIT 10;
```

## C++ Integration

```cpp
#include <sqlite3.h>

int main() {
    sqlite3 *db;
    sqlite3_open("irish_rail.db", &db);
    sqlite3_stmt *stmt;
    sqlite3_prepare_v2(db, 
        "SELECT station_code, latitude, longitude FROM stations", 
        -1, &stmt, nullptr);
    
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        const char *code = (const char*)sqlite3_column_text(stmt, 0);
        double lat = sqlite3_column_double(stmt, 1);
        double lon = sqlite3_column_double(stmt, 2);
    }
    
    sqlite3_finalize(stmt);
    sqlite3_close(db);
}
```

## Troubleshooting

### Script fails to fetch data
- Check internet connection
- API might be temporarily down (rare, no SLA provided)
- Check if network allows HTTP requests

### Database locked
- Another instance is running
- Wait a few seconds and retry
- Check: `lsof irish_rail.db`

### Permission denied
- Make archive.py executable: `chmod +x archive.py`
- Or run with explicit Python: `python3 archive.py`

## Performance

- Full run: ~30-60 seconds (depends on network)
- Database size: Grows ~5-10KB per run
- Storage: 171 stations (static), trains/boards/movements accumulate

## Notes

- API updates every ~2.7 seconds
- Zero-delay requests return cached data (100% identical)
- Real-time coverage: mainline, DART, suburban
- Scheduled only: Cork, Limerick, Rosslare lines (see README.md for details)
