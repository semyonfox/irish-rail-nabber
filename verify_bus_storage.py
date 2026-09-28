"""Read-only checks for the bus archive and API projections after backfill."""

import argparse
import os
from datetime import datetime, timedelta, timezone

import psycopg

from backfill_bus_storage import STOP_KEY


ARCHIVE_PROGRESS = """SELECT last_id, target_id
FROM bus_storage_backfill_progress WHERE name = 'stop_archive'"""

ARCHIVE_MISSING = """SELECT COUNT(*) FROM bus_stop_updates u
WHERE NOT EXISTS (
    SELECT 1 FROM bus_stop_observations archive
    WHERE archive.fetched_at = u.fetched_at
      AND archive.feed_version_id = u.feed_version_id
      AND archive.update_hash = u.update_hash
)"""

ARCHIVE_SAMPLE_MISSING = """WITH sampled AS MATERIALIZED (
    SELECT fetched_at, feed_version_id, update_hash
    FROM bus_stop_updates TABLESAMPLE SYSTEM (0.1)
)
SELECT COUNT(*) FROM sampled u
WHERE NOT EXISTS (
    SELECT 1 FROM bus_stop_observations archive
    WHERE archive.fetched_at = u.fetched_at
      AND archive.feed_version_id = u.feed_version_id
      AND archive.update_hash = u.update_hash
)"""

TRIP_ARCHIVE_MISSING = """SELECT COUNT(*) FROM bus_trip_update_freshness f
WHERE NOT EXISTS (
    SELECT 1 FROM bus_trip_observations archive
    WHERE archive.last_seen_at = f.last_seen_at
      AND archive.feed_version_id = f.feed_version_id
      AND archive.trip_instance_key = f.trip_instance_key
)"""

TRIP_ARCHIVE_SAMPLE_MISSING = """WITH sampled AS MATERIALIZED (
    SELECT feed_version_id, trip_instance_key, last_seen_at
    FROM bus_trip_update_freshness TABLESAMPLE SYSTEM (1)
)
SELECT COUNT(*) FROM sampled f
WHERE NOT EXISTS (
    SELECT 1 FROM bus_trip_observations archive
    WHERE archive.last_seen_at = f.last_seen_at
      AND archive.feed_version_id = f.feed_version_id
      AND archive.trip_instance_key = f.trip_instance_key
)"""

LIVE_MISMATCHES = f"""WITH expected AS (
    SELECT DISTINCT ON (u.feed_version_id, u.trip_instance_key, {STOP_KEY})
           u.feed_version_id, u.trip_instance_key, {STOP_KEY} AS stop_key,
           u.update_hash
    FROM bus_stop_updates u
    JOIN bus_trip_update_freshness f
      ON f.feed_version_id = u.feed_version_id
     AND f.trip_instance_key = u.trip_instance_key
    JOIN transit_feed_versions feed
      ON feed.id = u.feed_version_id AND feed.is_active
    WHERE f.last_seen_at >= %s AND f.last_seen_at <= %s
    ORDER BY u.feed_version_id, u.trip_instance_key, {STOP_KEY},
             u.last_seen_at DESC, u.id DESC
), eligible_live AS (
    SELECT live.feed_version_id, live.trip_instance_key, live.stop_key,
           live.update_hash
    FROM bus_stop_live live
    JOIN bus_trip_update_freshness f
      ON f.feed_version_id = live.feed_version_id
     AND f.trip_instance_key = live.trip_instance_key
    JOIN transit_feed_versions feed
      ON feed.id = live.feed_version_id AND feed.is_active
    WHERE f.last_seen_at >= %s AND f.last_seen_at <= %s
)
SELECT COUNT(*) FROM expected
FULL JOIN eligible_live live
  ON live.feed_version_id = expected.feed_version_id
 AND live.trip_instance_key = expected.trip_instance_key
 AND live.stop_key = expected.stop_key
WHERE expected.update_hash IS DISTINCT FROM live.update_hash"""

STATS_MISMATCHES = f"""WITH candidates AS MATERIALIZED (
    SELECT DISTINCT ON (u.feed_version_id, u.trip_instance_key, {STOP_KEY})
           u.feed_version_id,
           COALESCE(u.route_id, trip.route_id) AS route_id,
           COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds)
               AS delay_seconds,
           f.last_seen_at AS fetched_at
    FROM bus_trip_update_freshness f
    JOIN bus_stop_updates u
      ON u.feed_version_id = f.feed_version_id
     AND u.trip_instance_key = f.trip_instance_key
    LEFT JOIN bus_trips trip
      ON trip.feed_version_id = u.feed_version_id AND trip.trip_id = u.trip_id
    WHERE f.last_seen_at > %s AND f.last_seen_at <= %s
      AND (hashtext(f.trip_instance_key) & %s) = %s
      AND UPPER(f.schedule_relationship) NOT IN
          ('CANCELED', 'CANCELLED', 'DELETED')
      AND COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds)
          IS NOT NULL
      AND COALESCE(u.route_id, trip.route_id) IS NOT NULL
    ORDER BY u.feed_version_id, u.trip_instance_key, {STOP_KEY},
             u.last_seen_at DESC, u.id DESC
), windows AS (
    SELECT hours FROM (VALUES (1), (24), (72), (168)) AS value(hours)
), old_stats AS (
    SELECT windows.hours, feed_version_id, route_id, COUNT(*) AS samples,
           SUM(delay_seconds)::numeric AS delay_total,
           COUNT(*) FILTER (WHERE delay_seconds <= 300) AS on_time,
           MAX(fetched_at) AS last_updated
    FROM candidates CROSS JOIN windows
    WHERE fetched_at > %s - make_interval(hours => windows.hours)
    GROUP BY windows.hours, feed_version_id, route_id
), new_stats AS (
    SELECT windows.hours, sample.feed_version_id, sample.route_id,
           COUNT(*) AS samples,
           SUM(sample.delay_seconds)::numeric AS delay_total,
           COUNT(*) FILTER (WHERE sample.delay_seconds <= 300) AS on_time,
           MAX(f.last_seen_at) AS last_updated
    FROM bus_trip_update_freshness f
    JOIN bus_delay_samples sample
      ON sample.feed_version_id = f.feed_version_id
     AND sample.trip_instance_key = f.trip_instance_key
    CROSS JOIN windows
    WHERE f.last_seen_at > %s AND f.last_seen_at <= %s
      AND (hashtext(f.trip_instance_key) & %s) = %s
      AND f.last_seen_at > %s - make_interval(hours => windows.hours)
      AND UPPER(f.schedule_relationship) NOT IN
          ('CANCELED', 'CANCELLED', 'DELETED')
    GROUP BY windows.hours, sample.feed_version_id, sample.route_id
)
SELECT COUNT(*) FROM old_stats old
FULL JOIN new_stats new
  ON new.hours = old.hours
 AND new.feed_version_id = old.feed_version_id
 AND new.route_id = old.route_id
WHERE old.samples IS DISTINCT FROM new.samples
   OR old.delay_total IS DISTINCT FROM new.delay_total
   OR old.on_time IS DISTINCT FROM new.on_time
   OR old.last_updated IS DISTINCT FROM new.last_updated"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-db", required=True)
    parser.add_argument("--as-of", help="UTC timestamp of the restored snapshot")
    parser.add_argument("--current", action="store_true", help="compare the current live database")
    parser.add_argument("--full-archive-check", action="store_true")
    parser.add_argument("--stats-only", action="store_true")
    parser.add_argument("--stats-sample", action="store_true")
    args = parser.parse_args()
    if args.current and args.as_of:
        parser.error("choose --current or --as-of")
    as_of = (
        datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        if args.as_of
        else datetime.now(timezone.utc)
    )
    if as_of.tzinfo is None:
        parser.error("as-of must include a timezone")

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        database = conn.execute("SELECT current_database()").fetchone()[0]
        if database != args.expected_db:
            raise RuntimeError(f"expected database {args.expected_db}, found {database}")
        # Production ingestion continues during verification. Compare all
        # projections against one MVCC snapshot so a poll cannot split checks.
        conn.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        progress = conn.execute(ARCHIVE_PROGRESS).fetchone()
        if progress is None:
            raise RuntimeError("archive backfill has not started")
        last_id, target_id = progress
        print(f"archive progress {last_id}/{target_id}", flush=True)
        if last_id != target_id:
            raise RuntimeError("archive backfill is incomplete")
        sample_progress = conn.execute(
            """SELECT last_id, target_id, as_of, updated_at
               FROM bus_storage_backfill_progress
               WHERE name = 'delay_samples'"""
        ).fetchone()
        if sample_progress is None:
            raise RuntimeError("delay-sample backfill has not started")
        sample_last_id, sample_target_id, sample_as_of, sample_updated_at = sample_progress
        print(
            f"delay-sample progress {sample_last_id}/{sample_target_id}",
            flush=True,
        )
        if sample_last_id != sample_target_id:
            raise RuntimeError("delay-sample backfill is incomplete")
        if args.current:
            refresh = conn.execute(
                """SELECT last_id, target_id, updated_at
                   FROM bus_storage_backfill_progress
                   WHERE name = 'delay_refresh'"""
            ).fetchone()
            if (
                refresh is None
                or refresh[0] != refresh[1]
                or refresh[2] < sample_updated_at
            ):
                raise RuntimeError("current delay-sample refresh is incomplete")
        elif sample_as_of != as_of:
            raise RuntimeError("delay-sample backfill is incomplete for this snapshot")
        if not args.stats_only:
            archive_check = (
                ARCHIVE_MISSING if args.full_archive_check else ARCHIVE_SAMPLE_MISSING
            )
            missing = conn.execute(archive_check).fetchone()[0]
            scope = "all" if args.full_archive_check else "sampled"
            print(f"{scope} legacy states missing from archive: {missing}", flush=True)
            if missing:
                raise RuntimeError("archive sample coverage failed")
            trip_archive_check = (
                TRIP_ARCHIVE_MISSING
                if args.full_archive_check
                else TRIP_ARCHIVE_SAMPLE_MISSING
            )
            missing_trips = conn.execute(trip_archive_check).fetchone()[0]
            print(f"{scope} trip-presence rows missing from archive: {missing_trips}", flush=True)
            if missing_trips:
                raise RuntimeError("trip-presence archive coverage failed")

            live_mismatches = conn.execute(
                LIVE_MISMATCHES,
                (
                    as_of - timedelta(minutes=30),
                    as_of,
                    as_of - timedelta(minutes=30),
                    as_of,
                ),
            ).fetchone()[0]
            print(f"live-state mismatches: {live_mismatches}", flush=True)
            if live_mismatches:
                raise RuntimeError("live-state comparison failed")

        mask = 4095 if args.stats_sample else 31
        buckets = (
            (0, 511, 1023, 1535, 2047, 2559, 3071, 3583)
            if args.stats_sample
            else range(32)
        )
        for position, bucket in enumerate(buckets, start=1):
            # An indexed trip lookup and bounded sort avoid spilling the whole
            # seven-day source table to the nearly full NAS restore volume.
            conn.execute("SET LOCAL enable_hashjoin = off")
            conn.execute("SET LOCAL enable_mergejoin = off")
            conn.execute("SET LOCAL work_mem = '64MB'")
            mismatches = conn.execute(
                STATS_MISMATCHES,
                (
                    as_of - timedelta(hours=168), as_of, mask, bucket, as_of,
                    as_of - timedelta(hours=168), as_of, mask, bucket, as_of,
                ),
            ).fetchone()[0]
            print(
                f"route-stat bucket {position}/{len(buckets)} mismatches: {mismatches}",
                flush=True,
            )
            if mismatches:
                raise RuntimeError(f"route statistics differ in bucket {bucket}")
        conn.execute("COMMIT")


if __name__ == "__main__":
    main()
