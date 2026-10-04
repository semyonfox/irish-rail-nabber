"""Run against an explicitly selected disposable PostgreSQL container."""
import json
import os
from pathlib import Path
import re
import subprocess
import unittest

CONTAINER = os.environ.get("BUS_STOP_BOARD_TEST_CONTAINER")

@unittest.skipUnless(CONTAINER, "set BUS_STOP_BOARD_TEST_CONTAINER to a disposable database container")
class BusStopBoardIntegration(unittest.TestCase):
    def test_stop_scope_freshness_and_prediction_identity(self):
        command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "bus_stop_test", "-XAt", "-v", "ON_ERROR_STOP=1"]
        def execute(sql):
            result = subprocess.run(command, input=sql.encode(), capture_output=True, check=True)
            return result.stdout.decode()
        execute(Path("migrations/011_bus_gtfs.sql").read_text())
        source = Path("api/src/schema/bus.rs").read_text().split("async fn bus_stop_board(", 1)[1].split("async fn bus_vehicles(", 1)[0]
        query = re.search(r'query_as::<_, BusDepartureRow>\(\s*"(.*?)",\s*\)', source, re.S).group(1)
        query = query.replace("$1", "'target'").replace("$2", "30")
        # Fixed fixture identifiers are rolled back so a replay cannot duplicate them.
        fixture = """
        BEGIN;
        SET LOCAL max_parallel_workers_per_gather=0;
        CREATE TEMP TABLE fetch_schedules (endpoint text, interval_seconds integer);
        INSERT INTO transit_feed_versions (id,source,content_sha256,downloaded_at,is_active)
        VALUES (901,'stop-board-test','stop-board-test',NOW(),true),
               (902,'stop-board-old','stop-board-old',NOW(),false);
        INSERT INTO bus_routes (feed_version_id,route_id) VALUES (901,'route'),(902,'route');
        INSERT INTO bus_stops (feed_version_id,stop_id) VALUES (901,'target'),(901,'elsewhere'),(902,'target');
        INSERT INTO bus_trips (feed_version_id,trip_id,route_id)
        SELECT 901,id,'route' FROM unnest(ARRAY['direct','fallback','mismatch','stale','cancelled','skipped','unchanged','revised']) id;
        INSERT INTO bus_stop_times (feed_version_id,trip_id,stop_sequence,stop_id)
        SELECT 901,trip_id,1,'target' FROM bus_trips WHERE feed_version_id=901;
        INSERT INTO bus_trip_update_freshness (feed_version_id,trip_instance_key,last_seen_at,schedule_relationship)
        SELECT 901,trip_id,CASE WHEN trip_id='stale' THEN NOW()-INTERVAL '1 hour' ELSE NOW() END,
               CASE WHEN trip_id='cancelled' THEN 'CANCELED' ELSE 'SCHEDULED' END
        FROM bus_trips WHERE feed_version_id=901;
        INSERT INTO bus_trip_update_freshness (feed_version_id,trip_instance_key,last_seen_at) VALUES (902,'old',NOW());
        INSERT INTO bus_stop_updates (feed_version_id,trip_instance_key,entity_id,trip_id,stop_id,stop_sequence,
          departure_time,departure_delay_seconds,schedule_relationship,update_hash,fetched_at,last_seen_at)
        SELECT 901,trip_id,trip_id,trip_id,
          CASE WHEN trip_id='fallback' THEN NULL WHEN trip_id='mismatch' THEN 'elsewhere' ELSE 'target' END,1,
          NOW()+INTERVAL '10 minutes',60,
          CASE WHEN trip_id='skipped' THEN 'SKIPPED' ELSE 'SCHEDULED' END,trip_id,
          NOW()-INTERVAL '2 hours',NOW()-INTERVAL '2 hours'
        FROM bus_trips WHERE feed_version_id=901;
        INSERT INTO bus_stop_updates (feed_version_id,trip_instance_key,entity_id,trip_id,stop_id,stop_sequence,
          departure_time,departure_delay_seconds,schedule_relationship,update_hash,fetched_at,last_seen_at)
        VALUES (901,'revised','revised','revised','target',1,NOW()+INTERVAL '15 minutes',120,'SCHEDULED','revised-new',NOW(),NOW()),
               (902,'old','old',NULL,'target',1,NOW()+INTERVAL '10 minutes',60,'SCHEDULED','old',NOW(),NOW());
        """
        output = execute(fixture + "SELECT jsonb_agg(board) FROM (" + query + ") board; ROLLBACK;")
        rows = next(json.loads(line) for line in output.splitlines() if line.startswith("["))
        self.assertEqual({row["entity_id"] for row in rows}, {"direct", "fallback", "unchanged", "revised"})
        self.assertEqual(len(rows), 4)
        self.assertEqual(next(row["delay_seconds"] for row in rows if row["entity_id"] == "revised"), 120)

if __name__ == "__main__":
    unittest.main()
