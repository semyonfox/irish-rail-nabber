# Usage Guide

## Basic Usage

```bash
python3 archive.py
```

Output shows data counts and saves to `irish_rail.db`

## Database Queries

### Connect to database
```bash
sqlite3 irish_rail.db
```

### List all tables
```sql
.tables
```

### Count everything
```sql
SELECT 
  'stations' as table_name, COUNT(*) as count FROM stations
UNION ALL
SELECT 'current_trains', COUNT(*) FROM current_trains
UNION ALL
SELECT 'station_boards', COUNT(*) FROM station_boards
UNION ALL
SELECT 'train_movements', COUNT(*) FROM train_movements;
```

### Find a specific station
```sql
SELECT * FROM stations 
WHERE station_desc LIKE '%Connolly%';
```

Result:
```
1|1|CNLLY|Dublin Connolly||53.3622|-6.2478|2026-03-10 11:41:23
```

### Get all trains currently running
```sql
SELECT train_code, train_status, train_latitude, train_longitude 
FROM current_trains 
WHERE train_status = 'R'
LIMIT 10;
```

### Find trains due at a station
```sql
SELECT train_code, origin, destination, status, due_in, late
FROM station_boards
WHERE station_code = 'CNLLY'
ORDER BY due_in ASC;
```

### Get trains that are late
```sql
SELECT train_code, station_fullname, late, status
FROM station_boards
WHERE late > 0
ORDER BY late DESC
LIMIT 20;
```

### View train journey
```sql
SELECT train_code, location_full_name, location_order, 
       scheduled_arrival, actual_arrival, status
FROM train_movements
WHERE train_code = 'D561'
ORDER BY location_order;
```

### Get historical data (last 24 hours if running regularly)
```sql
SELECT train_code, station_code, status, due_in, late, fetched_at
FROM station_boards
WHERE fetched_at > datetime('now', '-24 hours')
ORDER BY fetched_at DESC
LIMIT 50;
```

## Python Integration

### Read database in Python
```python
import sqlite3

conn = sqlite3.connect('irish_rail.db')
cursor = conn.cursor()

# Get all stations
cursor.execute("SELECT station_code, station_desc FROM stations")
stations = cursor.fetchall()
print(f"Total stations: {len(stations)}")

# Get live trains
cursor.execute("SELECT train_code, train_latitude, train_longitude FROM current_trains")
trains = cursor.fetchall()
for code, lat, lon in trains:
    print(f"{code}: {lat}, {lon}")

conn.close()
```

### Build a network matrix
```python
import sqlite3

conn = sqlite3.connect('irish_rail.db')
cursor = conn.cursor()

# Get all stations
cursor.execute("SELECT station_code FROM stations ORDER BY station_code")
stations = [row[0] for row in cursor.fetchall()]
n = len(stations)
station_idx = {code: i for i, code in enumerate(stations)}

# Create adjacency matrix
import numpy as np
adj_matrix = np.zeros((n, n))

# Populate from train movements
cursor.execute("""
    SELECT location_code, location_full_name FROM train_movements 
    GROUP BY location_code
""")
movements = cursor.fetchall()

for i, movement in enumerate(movements):
    if i < n - 1:
        curr_code = movement[0]
        next_code = movements[i + 1][0]
        if curr_code in station_idx and next_code in station_idx:
            adj_matrix[station_idx[curr_code], station_idx[next_code]] = 1

print(f"Adjacency matrix shape: {adj_matrix.shape}")
print(f"Total edges: {np.count_nonzero(adj_matrix)}")

conn.close()
```

## Automation

### Run every hour (cron)
```bash
crontab -e
```

Add:
```
0 * * * * cd /home/semyon/code/personal/irish-rail-nabber && python3 archive.py >> archive.log 2>&1
```

### Run every 5 minutes
```
*/5 * * * * cd /home/semyon/code/personal/irish-rail-nabber && python3 archive.py >> archive.log 2>&1
```

### Run in background forever
```bash
nohup bash -c 'while true; do python3 archive.py; sleep 300; done' > archive.log 2>&1 &
```

### Monitor the log
```bash
tail -f archive.log
```

## Data Export

### Export stations to CSV
```bash
sqlite3 irish_rail.db << EOF
.mode csv
.headers on
.output stations.csv
SELECT * FROM stations;
.output stdout
EOF
```

### Export current trains to JSON
```python
import sqlite3
import json

conn = sqlite3.connect('irish_rail.db')
cursor = conn.cursor()
cursor.execute("""
    SELECT train_code, train_latitude, train_longitude, train_date, direction
    FROM current_trains
""")

trains = []
for row in cursor.fetchall():
    trains.append({
        'code': row[0],
        'latitude': row[1],
        'longitude': row[2],
        'date': row[3],
        'direction': row[4]
    })

with open('trains.json', 'w') as f:
    json.dump(trains, f, indent=2)

conn.close()
print(f"Exported {len(trains)} trains to trains.json")
```

## Performance Tips

### Create indexes for faster queries
```sql
CREATE INDEX IF NOT EXISTS idx_train_code ON station_boards(train_code);
CREATE INDEX IF NOT EXISTS idx_station_code ON station_boards(station_code);
CREATE INDEX IF NOT EXISTS idx_fetched_at ON station_boards(fetched_at);
```

### Vacuum database to reduce size
```bash
sqlite3 irish_rail.db "VACUUM;"
```

### Analyze query performance
```sql
EXPLAIN QUERY PLAN
SELECT * FROM station_boards WHERE station_code = 'CNLLY';
```

## Troubleshooting

### Database is growing too fast?
- Reduce collection frequency
- Or periodically clean old data:
```sql
DELETE FROM station_boards 
WHERE fetched_at < datetime('now', '-7 days');
```

### Queries are slow?
- Add indexes (see Performance Tips)
- Use WHERE clauses to filter early
- Avoid SELECT * on large tables

### Want to reset everything?
```bash
rm irish_rail.db
python3 archive.py
```
