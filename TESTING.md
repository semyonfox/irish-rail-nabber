# Testing & Verification Guide

This document explains how to verify the Irish Rail collector is working properly.

## Prerequisites

- Docker & Docker Compose installed
- 2GB free disk space (grows ~5-10MB/day)
- Internet connection (to fetch Irish Rail API)

## Quick Start Test

```bash
docker-compose up -d
sleep 30
```

## Verification Checklist

### 1. Containers Running

```bash
docker-compose ps
```

Expected output:
```
NAME                COMMAND                  SERVICE    STATUS
irish_rail_db       "docker-entrypoint..."   db         Up (healthy)
irish_rail_daemon   "./docker-entrypoint..."  daemon    Up
```

### 2. Database Initialized

```bash
psql -h localhost -U irish_data -d ireland_public \
  -c "\dt"
```

Expected: See tables `stations`, `train_snapshots`, `station_events`, `train_movements`, `fetch_history`

### 3. Data Collection Working

Check after 60 seconds:

```bash
psql -h localhost -U irish_data -d ireland_public << 'SQL'
SELECT 'Stations' as metric, COUNT(*) as count FROM stations
UNION ALL
SELECT 'Train snapshots (last min)', COUNT(*) FROM train_snapshots 
  WHERE fetched_at > NOW() - INTERVAL '1 minute'
UNION ALL
SELECT 'Station events (last min)', COUNT(*) FROM station_events
  WHERE fetched_at > NOW() - INTERVAL '1 minute'
UNION ALL
SELECT 'Fetch successes', COUNT(*) FROM fetch_history WHERE status = 'success'
UNION ALL
SELECT 'Fetch errors', COUNT(*) FROM fetch_history WHERE status = 'failed';
SQL
```

Expected after 60 seconds:
- Stations: 171
- Train snapshots: 15-25 (only when positions change)
- Station events: 500-1000
- Fetch successes: 20 (3s polling × 60s ÷ dedup skips)
- Fetch errors: 0

### 4. Daemon Logs

```bash
docker-compose logs daemon --tail=20
```

Expected output:
```
irish_rail_daemon | 2026-03-10 13:00:00 - INFO - Daemon initialized
irish_rail_daemon | 2026-03-10 13:00:01 - INFO - Initializing stations...
irish_rail_daemon | 2026-03-10 13:00:05 - INFO - Stations: 171 records
irish_rail_daemon | 2026-03-10 13:00:08 - INFO - Trains: 42 records
irish_rail_daemon | 2026-03-10 13:00:11 - INFO - Trains: 0 records (skipped)
irish_rail_daemon | 2026-03-10 13:00:14 - INFO - Station boards: 1847 records from 171 stations
```

### 5. Data Persistence

```bash
docker-compose stop
sleep 5
docker-compose start

# Check data is still there
psql -h localhost -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM train_snapshots;"
```

Data should not be reset after restart.

## 24-Hour Stability Test

Run this to verify 24 hours of continuous collection:

```bash
docker-compose up -d

for i in {1..24}; do
  sleep 3600
  echo "Hour $i:"
  psql -h localhost -U irish_data -d ireland_public -c \
    "SELECT COUNT(*) as snapshots FROM train_snapshots WHERE fetched_at > NOW() - INTERVAL '1 hour';"
done
```

Expected:
- Each hour: 1200+ new train snapshots (3s polling × 1200 requests, minus dedup skips)
- Each hour: 5000-10000 new station events
- Zero daemon crashes
- Logs clean with no error spikes

## Cleanup

```bash
# Stop services (data persists)
docker-compose down

# Delete all data and start fresh
docker-compose down -v
rm -rf postgres_data/
docker-compose up -d
```

## Troubleshooting

### "docker-compose: command not found"
Use `docker compose` instead (newer format).

### Daemon won't start
```bash
docker-compose logs daemon
docker-compose down
docker-compose up --build --no-cache
```

### Database connection timeout
```bash
# Check DB is healthy
docker-compose logs db

# Wait 30+ seconds for startup
sleep 30
docker-compose exec db psql -U irish_data -d ireland_public -c "SELECT NOW();"
```

### No data appearing
```bash
# Check if Irish Rail API is reachable
curl -s "http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML" | head -5

# Check fetch errors
psql -h localhost -U irish_data -d ireland_public \
  -c "SELECT endpoint, status, error_msg, COUNT(*) FROM fetch_history GROUP BY endpoint, status, error_msg;"
```

## Success Criteria

- [ ] `docker-compose ps` shows both services healthy
- [ ] 171 stations in database
- [ ] 30+ train snapshots after 60 seconds
- [ ] 500+ station events after 60 seconds
- [ ] Zero fetch errors in last 10 minutes
- [ ] 24-hour test shows consistent collection
- [ ] Data persists after container restart

Once all criteria pass, system is ready for production deployment.
