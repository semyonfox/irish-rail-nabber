# Local Testing & Deployment Guide

## Phase 1: Local Docker Setup (Development)

### Prerequisites
- Docker & Docker Compose installed
- 2GB free disk space (grows ~5-10GB over 90 days of collection)

### Quick Start
```bash
cd ~/code/personal/irish-rail-nabber

# Start both TimescaleDB and daemon
docker compose up --build

# In another terminal, monitor logs
docker compose logs -f daemon
```

### What Happens
1. **Database service starts** (container: `irish_rail_db`)
   - TimescaleDB 16.3 on Alpine Linux
   - Creates database: `ireland_public`
   - User: `irish_data` / Password: `secure_password`
   - Exposed on `localhost:5432`

2. **Entrypoint script initializes schema**
   - Waits for DB to be ready (healthcheck)
   - Runs `schema.sql` to create 30 tables + hypertables
   - Configures compression policies (7 days)
   - Configures retention policies (90 days auto-delete)

3. **Daemon service starts** (container: `irish_rail_daemon`)
   - Initializes stations (fetches all 171 stations from API)
   - Starts 3 concurrent fetch tasks:
     - `fetch_trains`: Every 30 seconds (live train positions)
     - `fetch_all_station_boards`: Every 30 seconds (arrival/departure data)
     - `fetch_stations`: Daily (refreshes station metadata)

### Verify Setup is Working

#### 1. Check Container Health
```bash
docker compose ps
# Expected output:
# irish_rail_db    timescaledb:latest-pg16-alpine  Up (healthy)
# irish_rail_daemon  Build successful               Up
```

#### 2. Check Database Schema
```bash
# Connect to database
psql -h localhost -U irish_data -d ireland_public

# List tables
\dt

# Expected tables (sample):
#  public | stations
#  public | train_snapshots
#  public | station_events
#  public | train_routes
#  public | fetch_history

# Exit
\q
```

#### 3. Verify Initial Data Population
```bash
psql -h localhost -U irish_data -d ireland_public << 'SQL'
SELECT COUNT(*) as stations FROM stations;
SELECT COUNT(*) as recent_trains FROM train_snapshots WHERE fetched_at > NOW() - INTERVAL '5 minutes';
SELECT COUNT(*) as recent_events FROM station_events WHERE fetched_at > NOW() - INTERVAL '5 minutes';
SQL
```

Expected results after 5 minutes:
- `stations`: 171 (all Irish Rail stations)
- `recent_trains`: 30-50 train records
- `recent_events`: 1000-2000 station event records

#### 4. Monitor Daemon Logs
```bash
docker compose logs daemon --tail=50 -f

# Expected log output:
# 2025-03-10 12:34:56,123 - INFO - Daemon initialized
# 2025-03-10 12:34:57,456 - INFO - Stations: 171 records
# 2025-03-10 12:35:27,789 - INFO - Trains: 42 records
# 2025-03-10 12:35:28,012 - INFO - Station boards: 1847 records from 171 stations
```

#### 5. Check Data Growth Over Time
```bash
# Run every 10 minutes to see growth
watch -n 600 'psql -h localhost -U irish_data -d ireland_public -c "SELECT (SELECT COUNT(*) FROM train_snapshots) as trains, (SELECT COUNT(*) FROM station_events) as events;"'
```

### Troubleshooting

**Daemon won't start**
```bash
# Check full logs
docker compose logs daemon

# Rebuild fresh
docker compose down
docker compose up --build --no-cache
```

**Database connection error**
```bash
# Verify DB is healthy
docker compose logs db

# Check if port 5432 is available
lsof -i :5432

# Wait longer for DB to initialize (may take 30s)
docker compose restart db
```

**No data appearing**
```bash
# Check if Irish Rail API is responsive
curl -s "http://api.irishrail.ie/realtime/realtime.asmx/getAllStationsXML" | head -5

# Check fetch_history table for errors
psql -h localhost -U irish_data -d ireland_public -c "SELECT endpoint, status, error_msg, COUNT(*) FROM fetch_history GROUP BY endpoint, status, error_msg ORDER BY 1;"
```

---

## Phase 2: Persistence & 24-Hour Test

### Stop and Restart Without Data Loss
```bash
# Stop daemon (database persists)
docker compose stop

# Resume
docker compose start

# Data is still there!
docker compose logs daemon --tail=20
```

### 24-Hour Uptime Test
Run this to validate 24 hours of continuous collection:

```bash
# Start and background
docker compose up -d

# Check every hour
for i in {1..24}; do
  sleep 3600
  echo "Hour $i:"
  psql -h localhost -U irish_data -d ireland_public -c "SELECT COUNT(*) as train_records, COUNT(DISTINCT train_code) as unique_trains FROM train_snapshots WHERE fetched_at > NOW() - INTERVAL '1 hour';"
done
```

**Expected pattern:**
- Each hour: 120 new train snapshots (30 per fetch, every 30s = 120/hour)
- Each hour: 1000-2000 new station events
- Zero crashes or restarts
- Logs clean with no error spikes

### Database Size Tracking
```bash
# Check size growth
du -sh $(docker volume inspect irish_rail_nabber_postgres_data -f '{{.Mountpoint}}')

# Expected growth:
# Day 1: ~200MB
# Day 7: ~1.4GB (compression kicks in after 7 days)
# Day 90: ~5-10GB (compressed, will auto-delete after 90 days)
```

---

## Phase 2.5: Pre-Deployment Checklist

Before deploying to VPS, verify:

- [ ] `docker compose up --build` succeeds (zero errors)
- [ ] 24-hour test shows zero crashes
- [ ] Database has 171 stations
- [ ] Fetch success rate >99% in `fetch_history`
- [ ] No duplicate rows in hypertables
- [ ] Compression policies are active after 7 days
- [ ] Logs are clean with no error spikes

Run this final validation:
```bash
psql -h localhost -U irish_data -d ireland_public << 'SQL'
-- Check data completeness
SELECT 'Stations' as metric, COUNT(*) as count FROM stations
UNION ALL
SELECT 'Train snapshots (last 24h)', COUNT(*) FROM train_snapshots WHERE fetched_at > NOW() - INTERVAL '1 day'
UNION ALL
SELECT 'Station events (last 24h)', COUNT(*) FROM station_events WHERE fetched_at > NOW() - INTERVAL '1 day'
UNION ALL
SELECT 'Fetch successes', COUNT(*) FROM fetch_history WHERE status = 'success'
UNION ALL
SELECT 'Fetch failures', COUNT(*) FROM fetch_history WHERE status = 'failed';
SQL
```

---

## Phase 3: VPS Deployment (DigitalOcean)

### Setup Instructions

#### 1. Create Droplet
- **Provider**: DigitalOcean
- **Size**: 2GB RAM / 2 CPU / 50GB SSD (€5/month)
- **Region**: Europe (Frankfurt or London)
- **OS**: Ubuntu 24.04 LTS
- **Auth**: SSH key (generate locally)

#### 2. Initial Setup
```bash
# SSH into droplet
ssh root@<droplet_ip>

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Create non-root user
useradd -m -s /bin/bash deploy
usermod -aG docker deploy
su - deploy

# Clone repo
git clone https://github.com/YOUR_USERNAME/irish-rail-nabber.git
cd irish-rail-nabber

# Create .env for production
cat > .env.prod << 'ENV'
DATABASE_URL=postgresql://irish_data:STRONG_PASSWORD@localhost:5432/ireland_public
POSTGRES_USER=irish_data
POSTGRES_PASSWORD=STRONG_PASSWORD
POSTGRES_DB=ireland_public
ENV
```

#### 3. Deploy with Systemd
Create `/etc/systemd/system/irish-rail.service`:
```ini
[Unit]
Description=Irish Rail Data Collection Daemon
After=docker.service
Requires=docker.service

[Service]
Type=simple
User=deploy
WorkingDirectory=/home/deploy/irish-rail-nabber
ExecStart=/usr/bin/docker compose -f docker-compose.yml up
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Start service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable irish-rail
sudo systemctl start irish-rail

# Check status
sudo systemctl status irish-rail
```

#### 4. Monitor Production
```bash
# View live logs
docker compose logs -f daemon

# Set up log rotation
docker compose up -d --log-opt max-size=10m --log-opt max-file=3

# Monitor disk usage
watch -n 60 'df -h && du -sh /home/deploy/irish-rail-nabber/postgres_data 2>/dev/null || echo "Data dir not mounted yet"'
```

---

## Phase 4: Backup Strategy

### Daily Database Backups to S3
Create `/home/deploy/backup.sh`:
```bash
#!/bin/bash

DB_USER="irish_data"
DB_PASSWORD="STRONG_PASSWORD"
DB_NAME="ireland_public"
BACKUP_PATH="/home/deploy/backups"
S3_BUCKET="s3://irish-rail-backups"

mkdir -p $BACKUP_PATH

# Backup to file
BACKUP_FILE="$BACKUP_PATH/ireland_public_$(date +%Y%m%d_%H%M%S).sql.gz"
pg_dump -h localhost -U $DB_USER $DB_NAME | gzip > $BACKUP_FILE

# Upload to S3 (requires aws-cli)
aws s3 cp $BACKUP_FILE $S3_BUCKET/

# Keep only last 30 days locally
find $BACKUP_PATH -name "*.sql.gz" -mtime +30 -delete

echo "Backup complete: $BACKUP_FILE"
```

Add to crontab:
```bash
0 2 * * * /home/deploy/backup.sh >> /home/deploy/backup.log 2>&1
```

Cost: ~€0.05/month for S3 (assuming 30GB backups)

---

## Phase 5: Performance Tuning

### After First 7 Days
Compression kicks in automatically. Monitor:
```bash
# Check compression status
SELECT
  schema_name,
  table_name,
  (SELECT pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)))
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY table_name;
```

### Query Performance
```bash
# Test common queries
EXPLAIN ANALYZE
SELECT train_code, COUNT(*) as snapshots
FROM train_snapshots
WHERE fetched_at > NOW() - INTERVAL '7 days'
GROUP BY train_code
ORDER BY snapshots DESC
LIMIT 10;
```

Expected: <1 second for 1 week of data.

---

## Rollback / Recovery

### Stop and Inspect
```bash
docker compose stop
docker compose logs daemon --tail=200 > debug.log
```

### Roll Back Schema
```bash
docker compose exec db psql -U irish_data -d ireland_public << 'SQL'
DROP TABLE fetch_history CASCADE;
DROP TABLE station_events CASCADE;
DROP TABLE train_snapshots CASCADE;
-- ... repeat for other tables
SQL

# Re-initialize
docker compose restart
```

### Full Reset (Nuclear Option)
```bash
# Stop everything
docker compose down -v

# Remove all data
rm -rf postgres_data/

# Restart fresh
docker compose up --build
```

---

## Success Metrics (Week 1)

- [x] Services start without errors
- [x] All 171 stations loaded
- [x] >99% API fetch success rate
- [x] Zero duplicate rows in hypertables
- [x] Logs clean and informative
- [ ] 24-hour continuous uptime (run before VPS deploy)
- [ ] Database grows at expected rate (~70-100MB/day)
- [ ] No memory leaks (daemon process stable)
