"""Copy legacy bus states into the permanent archive and bounded read tables.

This script only inserts or updates data. It never removes legacy rows. Set
DATABASE_URL and name the intended database explicitly with --expected-db.
"""

import argparse
import os
import shutil
from datetime import datetime, timedelta, timezone

import psycopg


STOP_KEY = """CASE
    WHEN u.stop_sequence IS NOT NULL THEN 'sequence:' || u.stop_sequence::text
    WHEN u.stop_id IS NOT NULL THEN 'stop_id:' || u.stop_id
    ELSE 'unknown'
END"""

RESOLVED_ROUTE = """COALESCE(u.route_id, (
    SELECT trip.route_id FROM bus_trips trip
    WHERE trip.feed_version_id = u.feed_version_id
      AND trip.trip_id = u.trip_id
))"""

ARCHIVE_SQL = """INSERT INTO bus_stop_observations
    (feed_version_id, trip_instance_key, entity_id, trip_id, route_id,
     service_date, vehicle_id, stop_id, stop_sequence, schedule_relationship,
     arrival_time, departure_time, arrival_delay_seconds,
     departure_delay_seconds, update_hash, source_timestamp, fetched_at,
     last_seen_at, trip_schedule_relationship)
SELECT u.feed_version_id, u.trip_instance_key, u.entity_id, u.trip_id,
       u.route_id, u.service_date, u.vehicle_id, u.stop_id, u.stop_sequence,
       u.schedule_relationship, u.arrival_time, u.departure_time,
       u.arrival_delay_seconds, u.departure_delay_seconds, u.update_hash,
       u.source_timestamp, u.fetched_at, u.last_seen_at, 'SCHEDULED'
FROM bus_stop_updates u
WHERE u.id > %s AND u.id <= %s
ON CONFLICT (fetched_at, feed_version_id, update_hash) DO NOTHING"""

SAMPLES_SQL = f"""INSERT INTO bus_delay_samples
    (feed_version_id, trip_instance_key, stop_key, route_id,
     delay_seconds, last_seen_at)
SELECT DISTINCT ON (u.feed_version_id, u.trip_instance_key, {STOP_KEY})
       u.feed_version_id, u.trip_instance_key, {STOP_KEY},
       {RESOLVED_ROUTE},
       COALESCE(u.departure_delay_seconds,
                            u.arrival_delay_seconds), u.last_seen_at
FROM bus_stop_updates u
JOIN bus_trip_update_freshness f
  ON f.feed_version_id = u.feed_version_id
 AND f.trip_instance_key = u.trip_instance_key
WHERE u.id > %s AND u.id <= %s
  AND f.last_seen_at > %s AND f.last_seen_at <= %s
  AND COALESCE(u.departure_delay_seconds,
               u.arrival_delay_seconds) IS NOT NULL
  AND {RESOLVED_ROUTE} IS NOT NULL
ORDER BY u.feed_version_id, u.trip_instance_key, {STOP_KEY},
         u.last_seen_at DESC, u.id DESC
ON CONFLICT (feed_version_id, trip_instance_key, stop_key)
DO UPDATE SET
    route_id = EXCLUDED.route_id,
    delay_seconds = EXCLUDED.delay_seconds,
    last_seen_at = EXCLUDED.last_seen_at
WHERE bus_delay_samples.last_seen_at < EXCLUDED.last_seen_at
   OR (
       bus_delay_samples.last_seen_at = EXCLUDED.last_seen_at
       AND (bus_delay_samples.route_id, bus_delay_samples.delay_seconds)
           IS DISTINCT FROM (EXCLUDED.route_id, EXCLUDED.delay_seconds)
   )"""

REFRESH_SAMPLES_SQL = f"""INSERT INTO bus_delay_samples
    (feed_version_id, trip_instance_key, stop_key, route_id,
     delay_seconds, last_seen_at)
SELECT DISTINCT ON (u.feed_version_id, u.trip_instance_key, {STOP_KEY})
       u.feed_version_id, u.trip_instance_key, {STOP_KEY},
       {RESOLVED_ROUTE},
       COALESCE(u.departure_delay_seconds, u.arrival_delay_seconds),
       u.last_seen_at
FROM bus_trip_update_freshness f
JOIN bus_stop_updates u
  ON u.feed_version_id = f.feed_version_id
 AND u.trip_instance_key = f.trip_instance_key
WHERE f.last_seen_at > NOW() - INTERVAL '168 hours'
  AND f.last_seen_at > %s
  AND (hashtext(f.trip_instance_key) & 31) = %s
  AND COALESCE(u.departure_delay_seconds,
               u.arrival_delay_seconds) IS NOT NULL
  AND {RESOLVED_ROUTE} IS NOT NULL
ORDER BY u.feed_version_id, u.trip_instance_key, {STOP_KEY},
         u.last_seen_at DESC, u.id DESC
ON CONFLICT (feed_version_id, trip_instance_key, stop_key)
DO UPDATE SET
    route_id = EXCLUDED.route_id,
    delay_seconds = EXCLUDED.delay_seconds,
    last_seen_at = EXCLUDED.last_seen_at
WHERE bus_delay_samples.last_seen_at < EXCLUDED.last_seen_at
   OR (
       bus_delay_samples.last_seen_at = EXCLUDED.last_seen_at
       AND (bus_delay_samples.route_id, bus_delay_samples.delay_seconds)
           IS DISTINCT FROM (EXCLUDED.route_id, EXCLUDED.delay_seconds)
   )"""

LIVE_SQL = f"""INSERT INTO bus_stop_live
    (feed_version_id, trip_instance_key, stop_key, entity_id, trip_id,
     route_id, service_date, vehicle_id, stop_id, stop_sequence,
     schedule_relationship, arrival_time, departure_time,
     arrival_delay_seconds, departure_delay_seconds, update_hash,
     source_timestamp, fetched_at, last_seen_at)
SELECT DISTINCT ON (u.feed_version_id, u.trip_instance_key, {STOP_KEY})
       u.feed_version_id, u.trip_instance_key, {STOP_KEY}, u.entity_id,
       u.trip_id, u.route_id, u.service_date, u.vehicle_id, u.stop_id,
       u.stop_sequence, u.schedule_relationship, u.arrival_time,
       u.departure_time, u.arrival_delay_seconds, u.departure_delay_seconds,
       u.update_hash, u.source_timestamp, u.fetched_at, u.last_seen_at
FROM bus_trip_update_freshness f
JOIN transit_feed_versions feed
  ON feed.id = f.feed_version_id AND feed.is_active
JOIN bus_stop_updates u
  ON u.feed_version_id = f.feed_version_id
 AND u.trip_instance_key = f.trip_instance_key
WHERE f.last_seen_at >= %s AND f.last_seen_at <= %s
ORDER BY u.feed_version_id, u.trip_instance_key, {STOP_KEY},
         u.last_seen_at DESC, u.id DESC
ON CONFLICT (feed_version_id, trip_instance_key, stop_key)
DO UPDATE SET
    entity_id = EXCLUDED.entity_id,
    trip_id = EXCLUDED.trip_id,
    route_id = EXCLUDED.route_id,
    service_date = EXCLUDED.service_date,
    vehicle_id = EXCLUDED.vehicle_id,
    stop_id = EXCLUDED.stop_id,
    stop_sequence = EXCLUDED.stop_sequence,
    schedule_relationship = EXCLUDED.schedule_relationship,
    arrival_time = EXCLUDED.arrival_time,
    departure_time = EXCLUDED.departure_time,
    arrival_delay_seconds = EXCLUDED.arrival_delay_seconds,
    departure_delay_seconds = EXCLUDED.departure_delay_seconds,
    update_hash = EXCLUDED.update_hash,
    source_timestamp = EXCLUDED.source_timestamp,
    fetched_at = EXCLUDED.fetched_at,
    last_seen_at = EXCLUDED.last_seen_at
WHERE bus_stop_live.last_seen_at <= EXCLUDED.last_seen_at"""

TRIP_ARCHIVE_SQL = """INSERT INTO bus_trip_observations
    (feed_version_id, trip_instance_key, last_seen_at, source_timestamp,
     schedule_relationship)
SELECT f.feed_version_id, f.trip_instance_key, f.last_seen_at,
       f.source_timestamp, f.schedule_relationship
FROM bus_trip_update_freshness f
ON CONFLICT (last_seen_at, feed_version_id, trip_instance_key) DO NOTHING"""


def compress_completed_chunks(
    conn: psycopg.Connection,
    hypertable: str,
    before: datetime,
    min_free_bytes: int,
) -> None:
    chunks = conn.execute(
        """SELECT format('%%I.%%I', chunk_schema, chunk_name)
           FROM timescaledb_information.chunks
           WHERE hypertable_name = %s
             AND NOT is_compressed
             AND range_end <= %s
             AND range_end < NOW() - INTERVAL '3 hours'
           ORDER BY range_start""",
        (hypertable, before),
    ).fetchall()
    for (chunk,) in chunks:
        require_free_space(min_free_bytes)
        with conn.transaction():
            conn.execute("SELECT compress_chunk(%s::regclass, true)", (chunk,))
        print(f"compressed {chunk}", flush=True)


def require_free_space(min_free_bytes: int) -> None:
    if min_free_bytes and shutil.disk_usage("/").free < min_free_bytes:
        raise RuntimeError("free space is below the configured backfill floor")


def prepare_archive_chunks(
    conn: psycopg.Connection,
    first: datetime | None,
    last: datetime | None,
    min_free_bytes: int,
) -> None:
    if first is None or last is None:
        return
    chunks = conn.execute(
        """SELECT format('%%I.%%I', chunk_schema, chunk_name)
           FROM timescaledb_information.chunks
           WHERE hypertable_name = 'bus_stop_observations'
             AND is_compressed
             AND range_start <= %s AND range_end > %s
           ORDER BY range_start""",
        (last, first),
    ).fetchall()
    for (chunk,) in chunks:
        require_free_space(min_free_bytes)
        with conn.transaction():
            conn.execute("SELECT decompress_chunk(%s::regclass)", (chunk,))
        print(f"decompressed {chunk} for archive copy", flush=True)


def archive(
    conn: psycopg.Connection,
    batch_size: int,
    limit_batches: int | None,
    min_free_bytes: int,
) -> None:
    with conn.transaction():
        conn.execute(
            """INSERT INTO bus_storage_backfill_progress
               (name, last_id, target_id)
               SELECT 'stop_archive',
                      COALESCE((SELECT MIN(id) - 1 FROM bus_stop_updates), 0),
                      COALESCE((SELECT MAX(id) FROM bus_stop_updates), 0)
               ON CONFLICT (name) DO NOTHING"""
        )
    batches = 0
    while True:
        progress = conn.execute(
            """SELECT last_id, target_id
               FROM bus_storage_backfill_progress
               WHERE name = 'stop_archive'"""
        ).fetchone()
        if progress is None:
            raise RuntimeError("archive progress row is missing")
        last_id, target_id = progress
        if last_id >= target_id or (limit_batches is not None and batches >= limit_batches):
            if last_id >= target_id:
                compress_completed_chunks(
                    conn, "bus_stop_observations", datetime.now(timezone.utc), min_free_bytes
                )
            print(f"archive progress: {last_id}/{target_id}")
            return
        require_free_space(min_free_bytes)
        upper_id = min(last_id + batch_size, target_id)
        first_time, last_time = conn.execute(
            """SELECT MIN(fetched_at), MAX(fetched_at)
               FROM bus_stop_updates WHERE id > %s AND id <= %s""",
            (last_id, upper_id),
        ).fetchone()
        prepare_archive_chunks(conn, first_time, last_time, min_free_bytes)
        with conn.transaction():
            inserted = conn.execute(ARCHIVE_SQL, (last_id, upper_id)).rowcount
            conn.execute(
                """UPDATE bus_storage_backfill_progress
                   SET last_id = %s, updated_at = NOW()
                   WHERE name = 'stop_archive' AND last_id = %s""",
                (upper_id, last_id),
            )
        batches += 1
        print(f"archive IDs {last_id + 1}-{upper_id}: {inserted} rows inserted", flush=True)
        if batches % 10 == 0:
            if first_time is not None:
                compress_completed_chunks(
                    conn,
                    "bus_stop_observations",
                    first_time,
                    min_free_bytes,
                )


def samples(
    conn: psycopg.Connection,
    batch_size: int,
    as_of: datetime,
    min_free_bytes: int,
    limit_batches: int | None,
) -> None:
    with conn.transaction():
        conn.execute(
            """INSERT INTO bus_storage_backfill_progress
               (name, last_id, target_id, as_of)
               SELECT 'delay_samples',
                      COALESCE((SELECT MIN(id) - 1 FROM bus_stop_updates), 0),
                      COALESCE((SELECT MAX(id) FROM bus_stop_updates), 0),
                      %s
               ON CONFLICT (name) DO NOTHING""",
            (as_of,),
        )
    batches = 0
    while True:
        progress = conn.execute(
            """SELECT last_id, target_id, as_of
               FROM bus_storage_backfill_progress
               WHERE name = 'delay_samples'"""
        ).fetchone()
        if progress is None:
            raise RuntimeError("delay-sample progress row is missing")
        last_id, target_id, saved_as_of = progress
        if saved_as_of != as_of:
            raise RuntimeError("resume delay samples with the original --as-of")
        if last_id >= target_id or (limit_batches is not None and batches >= limit_batches):
            print(f"delay-sample progress: {last_id}/{target_id}", flush=True)
            return
        require_free_space(min_free_bytes)
        upper_id = min(last_id + batch_size, target_id)
        with conn.transaction():
            # The default plan rebuilds a multi-million-row freshness hash for
            # every ID batch. Trip keys repeat within a poll, so indexed and
            # memoized lookups are cheaper for this one-time backfill.
            conn.execute("SET LOCAL enable_hashjoin = off")
            conn.execute("SET LOCAL enable_mergejoin = off")
            conn.execute("SET LOCAL work_mem = '64MB'")
            written = conn.execute(
                SAMPLES_SQL,
                (last_id, upper_id, as_of - timedelta(hours=168), as_of),
            ).rowcount
            conn.execute(
                """UPDATE bus_storage_backfill_progress
                   SET last_id = %s, updated_at = NOW()
                   WHERE name = 'delay_samples' AND last_id = %s""",
                (upper_id, last_id),
            )
        batches += 1
        print(f"samples IDs {last_id + 1}-{upper_id}: {written} rows", flush=True)


def live(conn: psycopg.Connection, as_of: datetime) -> None:
    with conn.transaction():
        conn.execute("SET LOCAL work_mem = '64MB'")
        written = conn.execute(
            LIVE_SQL, (as_of - timedelta(minutes=30), as_of)
        ).rowcount
    print(f"live prediction rows inserted or updated: {written}")


def refresh_samples(conn: psycopg.Connection, min_free_bytes: int) -> None:
    """Catch active trips whose freshness advanced during the ID backfill."""

    sample_progress = conn.execute(
        """SELECT last_id, target_id, as_of
           FROM bus_storage_backfill_progress WHERE name = 'delay_samples'"""
    ).fetchone()
    if sample_progress is None or sample_progress[0] != sample_progress[1]:
        raise RuntimeError("finish the ID-based delay-sample backfill first")
    as_of = sample_progress[2]
    if as_of is None:
        raise RuntimeError("delay-sample snapshot time is missing")
    with conn.transaction():
        conn.execute(
            """INSERT INTO bus_storage_backfill_progress
               (name, last_id, target_id, as_of)
               VALUES ('delay_refresh', 0, 32, NOW())
               ON CONFLICT (name) DO UPDATE SET
                   last_id = 0, target_id = 32, as_of = NOW(),
                   updated_at = NOW()"""
        )
    for bucket in range(32):
        require_free_space(min_free_bytes)
        with conn.transaction():
            conn.execute("SET LOCAL enable_hashjoin = off")
            conn.execute("SET LOCAL enable_mergejoin = off")
            conn.execute("SET LOCAL work_mem = '64MB'")
            written = conn.execute(REFRESH_SAMPLES_SQL, (as_of, bucket)).rowcount
            conn.execute(
                """UPDATE bus_storage_backfill_progress
                   SET last_id = %s, updated_at = NOW()
                   WHERE name = 'delay_refresh' AND last_id = %s""",
                (bucket + 1, bucket),
            )
        print(f"refreshed delay samples bucket {bucket + 1}/32: {written}", flush=True)


def trip_archive(conn: psycopg.Connection, min_free_bytes: int) -> None:
    chunks = conn.execute(
        """SELECT format('%I.%I', chunk_schema, chunk_name)
           FROM timescaledb_information.chunks
           WHERE hypertable_name = 'bus_trip_observations' AND is_compressed
           ORDER BY range_start"""
    ).fetchall()
    for (chunk,) in chunks:
        require_free_space(min_free_bytes)
        with conn.transaction():
            conn.execute("SELECT decompress_chunk(%s::regclass)", (chunk,))
        print(f"decompressed {chunk} for trip-presence copy", flush=True)
    with conn.transaction():
        written = conn.execute(TRIP_ARCHIVE_SQL).rowcount
    print(f"historic trip-presence rows archived: {written}")
    compress_completed_chunks(
        conn, "bus_trip_observations", datetime.now(timezone.utc), min_free_bytes
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-db", required=True)
    parser.add_argument(
        "--phase",
        choices=("archive", "trip_archive", "samples", "refresh_samples", "live"),
        required=True,
    )
    parser.add_argument("--batch-size", type=int, default=100_000)
    parser.add_argument("--limit-batches", type=int)
    parser.add_argument("--min-free-bytes", type=int, default=0)
    parser.add_argument("--as-of", help="UTC timestamp for an isolated snapshot test")
    args = parser.parse_args()
    if args.batch_size < 1:
        parser.error("batch-size must be positive")
    if args.limit_batches is not None and args.limit_batches < 1:
        parser.error("limit-batches must be positive")
    if args.min_free_bytes < 0:
        parser.error("min-free-bytes must not be negative")
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
        locked = conn.execute("SELECT pg_try_advisory_lock(2026092301)").fetchone()[0]
        if not locked:
            raise RuntimeError("another bus storage backfill is running")
        print(f"working in database {database}; phase={args.phase}")
        require_free_space(args.min_free_bytes)
        if args.phase in ("archive", "trip_archive"):
            hypertable = (
                "bus_stop_observations"
                if args.phase == "archive"
                else "bus_trip_observations"
            )
            active_policies = conn.execute(
                """SELECT job_id FROM timescaledb_information.jobs
                   WHERE hypertable_name = %s
                     AND proc_name = 'policy_compression' AND scheduled""",
                (hypertable,),
            ).fetchall()
            if active_policies:
                raise RuntimeError(
                    f"pause the {hypertable} compression policy before backfill"
                )
        if args.phase == "archive":
            archive(conn, args.batch_size, args.limit_batches, args.min_free_bytes)
        elif args.phase == "trip_archive":
            trip_archive(conn, args.min_free_bytes)
        elif args.phase == "samples":
            samples(conn, args.batch_size, as_of, args.min_free_bytes, args.limit_batches)
        elif args.phase == "refresh_samples":
            refresh_samples(conn, args.min_free_bytes)
        else:
            live(conn, as_of)


if __name__ == "__main__":
    main()
