#!/bin/bash
# Severity 2 Schema Migration - Data-Preserving
# Fixes broken view and adds new columns without data loss

set -e

echo "=========================================="
echo "Severity 2 Schema Migration"
echo "=========================================="

cd "$(dirname "$0")"

# 1. Stop daemon (release locks)
echo -e "\n[1/5] Stopping daemon to release database locks..."
docker-compose stop daemon
sleep 3
echo "✅ Daemon stopped"

# 2. Run migration
echo -e "\n[2/5] Applying schema fixes and migrations..."
python3 << 'PYMIGRATION'
import psycopg
import sys

try:
    print("Connecting to localhost:9898...")
    conn = psycopg.connect(
        "postgresql://irish_data:secure_password@localhost:9898/ireland_public",
        connect_timeout=10
    )
    
    with conn.cursor() as cur:
        print("\n  Fixing latest_station_events view...")
        cur.execute("""
            CREATE OR REPLACE VIEW latest_station_events AS
            SELECT DISTINCT ON (train_code, station_code)
                train_code,
                station_code,
                status,
                late_minutes,
                expected_arrival,
                expected_departure,
                fetched_at
            FROM station_events
            ORDER BY train_code, station_code, fetched_at DESC
        """)
        print("  ✅ View fixed")
        
        print("\n  Adding stations.station_type...")
        cur.execute("ALTER TABLE stations ADD COLUMN IF NOT EXISTS station_type CHAR(1)")
        print("  ✅ Added")
        
        print("  Adding stations.is_dart...")
        cur.execute("ALTER TABLE stations ADD COLUMN IF NOT EXISTS is_dart BOOLEAN DEFAULT FALSE")
        print("  ✅ Added")
        
        print("  Adding station_events.origin_time...")
        cur.execute("ALTER TABLE station_events ADD COLUMN IF NOT EXISTS origin_time TIME")
        print("  ✅ Added")
        
        print("  Adding station_events.destination_time...")
        cur.execute("ALTER TABLE station_events ADD COLUMN IF NOT EXISTS destination_time TIME")
        print("  ✅ Added")
        
        print("\n  Creating indexes...")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_stations_type ON stations(station_type)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_stations_is_dart ON stations(is_dart)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_station_events_origin_time ON station_events(origin_time)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_station_events_destination_time ON station_events(destination_time)")
        print("  ✅ Indexes created")
    
    conn.commit()
    conn.close()
    print("\n✅ All schema updates applied successfully!")
    
except Exception as e:
    print(f"\n❌ Migration failed: {e}")
    sys.exit(1)
PYMIGRATION

# 3. Verify schema changes
echo -e "\n[3/5] Verifying schema changes..."
python3 << 'PYVERIFY'
import psycopg

conn = psycopg.connect("postgresql://irish_data:secure_password@localhost:9898/ireland_public")

with conn.cursor() as cur:
    # Check stations columns
    cur.execute("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'stations' 
        AND column_name IN ('station_type', 'is_dart')
    """)
    
    stations_cols = [row[0] for row in cur.fetchall()]
    if 'station_type' in stations_cols and 'is_dart' in stations_cols:
        print("  ✅ stations table has station_type and is_dart")
    else:
        print(f"  ⚠️  Missing columns: {stations_cols}")
    
    # Check station_events columns
    cur.execute("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'station_events' 
        AND column_name IN ('origin_time', 'destination_time')
    """)
    
    events_cols = [row[0] for row in cur.fetchall()]
    if 'origin_time' in events_cols and 'destination_time' in events_cols:
        print("  ✅ station_events table has origin_time and destination_time")
    else:
        print(f"  ⚠️  Missing columns: {events_cols}")
    
    # Check data integrity
    cur.execute("SELECT COUNT(*) FROM stations")
    station_count = cur.fetchone()[0]
    print(f"  ✅ {station_count} stations preserved")
    
    cur.execute("SELECT COUNT(*) FROM station_events")
    event_count = cur.fetchone()[0]
    print(f"  ✅ {event_count} station events preserved")
    
    cur.execute("SELECT COUNT(*) FROM train_snapshots")
    snapshot_count = cur.fetchone()[0]
    print(f"  ✅ {snapshot_count} train snapshots preserved")
    
    cur.execute("SELECT COUNT(*) FROM train_movements")
    movement_count = cur.fetchone()[0]
    print(f"  ✅ {movement_count} train movements preserved")

conn.close()
PYVERIFY

# 4. Restart daemon
echo -e "\n[4/5] Restarting daemon with latest code..."
docker-compose start daemon
sleep 5
echo "✅ Daemon started"

# 5. Verify daemon is running
echo -e "\n[5/5] Verifying daemon health..."
if docker-compose ps daemon | grep -q "Up"; then
    echo "✅ Daemon is running"
else
    echo "❌ Daemon failed to start - check logs below"
fi

echo -e "\n=========================================="
echo "Migration complete! Showing daemon logs..."
echo "=========================================="
docker-compose logs --tail=30 daemon
