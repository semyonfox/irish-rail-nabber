# Testing & Verification

## Quick Test (60 seconds)

```bash
docker-compose up -d
sleep 30
docker-compose ps              # Both services healthy?
psql -h localhost -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM stations;"  # Should be 171
```

## Full Verification

After 60 seconds, check:

```bash
# Data collection working?
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

Expected:
- Stations: 171
- Train snapshots: 15-25 (only when positions change)
- Station events: 500-1000
- Fetch successes: 20+ (3s polling × 60s ÷ dedup skips)
- Fetch errors: 0

## Daemon Logs

```bash
docker-compose logs daemon --tail=20
```

Expected output:
```
Daemon initialized
Initializing stations...
Stations: 171 records
Trains: 42 records
Trains: 0 records (skipped)
Station boards: 1847 records from 171 stations
```

## 24-Hour Stability Test

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
- Each hour: 1200+ new train snapshots
- Each hour: 5000-10000 new station events
- Zero daemon crashes
- Clean logs with no error spikes

## Data Persistence

```bash
docker-compose stop
sleep 5
docker-compose start

# Check data is still there
psql -h localhost -U irish_data -d ireland_public \
  -c "SELECT COUNT(*) FROM train_snapshots;"
```

Data should not be reset after restart.

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
docker-compose logs db
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

- docker-compose ps shows both services healthy
- 171 stations in database
- 30+ train snapshots after 60 seconds
- 500+ station events after 60 seconds
- Zero fetch errors in last 10 minutes
- 24-hour test shows consistent collection
- Data persists after container restart

Once all pass, system is production-ready.
