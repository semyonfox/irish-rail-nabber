"""Opt-in tests against an isolated Docker TimescaleDB, never DATABASE_URL.

BUS_HISTORY_TEST_CONTAINER=irish-rail-bus-history-test python3 -m unittest test_bus_history_integration
The container must have no production volumes; create database bus_history_test first.
"""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import gzip
import os
from pathlib import Path
import re
import subprocess
import unittest

from psycopg import sql
from bus_daemon import NtaBusDaemon
import test_bus_daemon as fixtures
from test_bus_daemon import _AsyncContext

CONTAINER = os.environ.get("BUS_HISTORY_TEST_CONTAINER")


def run_sql(statement):
    if CONTAINER != "irish-rail-bus-history-test":
        raise RuntimeError("Only the explicitly named disposable container is supported")
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "bus_history_test", "-v", "ON_ERROR_STOP=1", "-XAt"],
        input=statement, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


class SQLRecorder:
    def __init__(self):
        self.statements = []

    def connection(self):
        return _AsyncContext(self)

    def transaction(self):
        return _AsyncContext(self)

    def cursor(self):
        return _AsyncContext(self)

    async def execute(self, statement, parameters=()):
        parts = statement.split("%s")
        if len(parts) != len(parameters) + 1:
            raise AssertionError("Parameter count mismatch")
        self.statements.append("".join(
            part + (sql.Literal(parameters[i]).as_string() if i < len(parameters) else "")
            for i, part in enumerate(parts)
        ) + ";")

    async def executemany(self, statement, rows):
        for row in rows:
            await self.execute(statement, row)

    def flush(self):
        run_sql("BEGIN;\n" + "\n".join(self.statements) + "\nCOMMIT;")
        self.statements.clear()


@unittest.skipUnless(CONTAINER == "irish-rail-bus-history-test", "requires a disposable TimescaleDB container")
class BusHistoryIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_observations_rollups_compression_and_api_sql(self):
        # This schema is disposable, contains only synthetic fixtures, and is reset for reruns.
        run_sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        run_sql("CREATE EXTENSION timescaledb;")
        run_sql(Path("migrations/011_bus_gtfs.sql").read_text())
        migration = Path("migrations/013_bus_history.sql").read_text()
        run_sql(migration)
        run_sql(migration)
        analysis = Path("migrations/014_bus_analysis.sql").read_text()
        run_sql(analysis)
        run_sql(analysis)
        run_sql("""
          INSERT INTO transit_feed_versions(id, source, content_sha256, downloaded_at, imported_at, is_active)
          VALUES (1,'test','one',NOW(),NOW(),true), (2,'test','two',NOW(),NOW(),false);
          INSERT INTO bus_agencies VALUES (1,'agency','Test Bus',NULL,NULL),(2,'agency','Old Bus',NULL,NULL);
          INSERT INTO bus_routes(feed_version_id,route_id,agency_id,route_short_name,route_long_name)
          VALUES (1,'route','agency','409','Eyre Square to Parkmore'),(2,'route','agency','404','Old route');
          INSERT INTO bus_stops(feed_version_id,stop_id,stop_name) VALUES (1,'stop','Eyre Square');
          INSERT INTO bus_trips(feed_version_id,trip_id,route_id,trip_headsign) VALUES (1,'trip','route','Parkmore');
        """)
        recorder = SQLRecorder()
        daemon = NtaBusDaemon("unused")
        daemon.pool = recorder
        now = datetime.now(timezone.utc).replace(minute=10, second=0, microsecond=0)
        for minutes, delay in [(0, 60), (2, 600), (4, 60), (4, 60)]:
            feed = fixtures.StopUpdatePersistenceTests._feed(delay)
            updates = [replace(u, arrival_time=now + timedelta(hours=1)) for u in feed.stop_updates]
            await daemon._insert_trip_updates(1, updates, feed.trip_freshness, now + timedelta(minutes=minutes))
            await daemon._upsert_vehicle_positions(1, fixtures.VehiclePositionPersistenceTests._position(53.0 + minutes / 100), now + timedelta(minutes=minutes))
            recorder.flush()
        # A cancellation with no stop predictions is archived as a trip status.
        # It must not improve or worsen delay averages.
        feed = fixtures.StopUpdatePersistenceTests._feed(9000)
        await daemon._insert_trip_updates(1, [], [replace(t, schedule_relationship="CANCELED") for t in feed.trip_freshness], now + timedelta(minutes=6))
        recorder.flush()
        # Reused route IDs remain separate across schedule versions.
        feed = fixtures.StopUpdatePersistenceTests._feed(-120)
        await daemon._insert_trip_updates(2, feed.stop_updates, feed.trip_freshness, now + timedelta(minutes=8))
        recorder.flush()
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_stop_observations"), "4")
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_vehicle_observations"), "3")
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_vehicle_positions"), "1")
        self.assertEqual(run_sql("SELECT sample_count, delay_sum, on_time_count, late_count FROM bus_hourly_delays WHERE feed_version_id=1"), "3|720|2|1")
        self.assertEqual(run_sql("SELECT sample_count, early_count FROM bus_hourly_delays WHERE feed_version_id=2"), "1|1")
        self.assertEqual(run_sql("SELECT SUM(sample_count) FROM bus_delay_histogram WHERE scope_kind='route' AND feed_version_id=1"), "3")
        self.assertEqual(run_sql("SELECT bus_histogram_percentile(array_agg(delay_seconds),array_agg(sample_count),0.95) FROM bus_delay_histogram WHERE scope_kind='stop' AND feed_version_id=1"), "546")
        self.assertEqual(run_sql("SELECT SUM(sample_count) FROM bus_delay_histogram WHERE scope_kind='network'"), "4")
        self.assertEqual(run_sql("SELECT bus_histogram_percentile(ARRAY[1,1,2,10],ARRAY[2,1,1,1]::bigint[],0.95) = (SELECT percentile_cont(0.95) WITHIN GROUP(ORDER BY x) FROM unnest(ARRAY[1,1,1,2,10]) x)"), "t")
        # Snapshot removal leaves archived positions intact.
        await daemon._upsert_vehicle_positions(1, [], now + timedelta(minutes=10))
        recorder.flush()
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_vehicle_positions"), "0")
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_vehicle_observations"), "3")
        payload = b'{"futureField":{"value":123},"entity":[]}'
        await daemon._archive_realtime_payload(1, "nta_vehicles", payload, now)
        recorder.flush()
        encoded = run_sql("SELECT encode(payload_gzip,'hex') FROM bus_realtime_feeds")
        self.assertEqual(gzip.decompress(bytes.fromhex(encoded)), payload)
        # Refresh and compression must preserve the same aggregates.
        run_sql("CALL refresh_continuous_aggregate('bus_hourly_delays', NULL, NULL);")
        run_sql("SELECT compress_chunk(c) FROM show_chunks('bus_stop_observations') c;")
        self.assertEqual(run_sql("SELECT COUNT(*) FROM bus_stop_observations"), "4")
        self.assertEqual(run_sql("SELECT sample_count, delay_sum FROM bus_hourly_delays WHERE feed_version_id=1"), "3|720")
        run_sql(migration)
        # Execute the exact parameterized SQL used by each new resolver.
        source = Path("api/src/schema/bus_history.rs").read_text()
        statements = re.findall(r'query_as::<_,\s*(Bus\w+)>\(\s*"((?:[^"\\]|\\.)*)"', source)
        arguments = {
            "BusRoute": "NULL::bigint, NULL::text, '%409%'::text, 200::bigint",
            "BusHistoryPoint": "72::int4, 1::bigint, 'route'::text, '1 hour'::text, 'route'::text, NULL::timestamptz",
            "BusStopStats": "72::int4, NULL::text, 1::bigint, 'stop'::text, 200::bigint",
            "BusJourney": "1::bigint, 'route'::text, NULL::text, 72::int4, 200::bigint",
            "BusRouteStopDelay": "1::bigint, 'route'::text, 200::bigint",
        }
        self.assertEqual(len(statements), 6)
        ranking_source = Path("api/src/schema/bus.rs").read_text()
        ranking_match = re.search(r'query_as::<_, BusRouteDelayRow>\(\s*"((?:[^"\\]|\\.)*)"', ranking_source)
        self.assertIsNotNone(ranking_match)
        ranking_query = ranking_match.group(1).replace('\\"', '"')
        ranking = run_sql(f"PREPARE rankings AS {ranking_query}; EXECUTE rankings(72::int4, 100::bigint);")
        self.assertIn("409", ranking)
        for model, statement in statements:
            query = statement.replace('\\"', '"')
            args = arguments[model]
            if model == "BusRouteStopDelay" and "bus_stop_observations" in query:
                key = run_sql("SELECT trip_instance_key FROM bus_stop_observations WHERE feed_version_id=1 LIMIT 1")
                args = f"1::bigint, '{key}'::text, 72::int4"
            result = run_sql(f"PREPARE api_query AS {query}; EXECUTE api_query({args});")
            if model == "BusHistoryPoint":
                self.assertIn("|546|", result)
            if model == "BusStopStats":
                self.assertIn("Eyre Square|240|546|600|",result)
            if model == "BusRouteStopDelay" and "bus_trip_observations" in query:
                self.assertIn("CANCELED", result)
            if model == "BusJourney":
                self.assertIn("Parkmore",result)
