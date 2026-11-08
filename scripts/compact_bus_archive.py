"""Rebuild the bus observation archive in its compact layout.

update_hash becomes the bigint the collector writes once the column is bigint,
and compressed hourly chunks merge into daily ones. The archive is insert-only,
so closed hours are copied while the collector keeps writing to the old table.
The swap then locks both tables for the last few minutes of rows only.

Phases, each resumable and safe to rerun:
  copy  create <archive>_compact and copy every closed hour into it
  swap  catch up, copy the open hour under lock and swap the names
  drop  drop <archive>_legacy once its row count matches

Set DATABASE_URL and name the intended database with --expected-db. On the
production host run it inside the collector image, for example
  docker exec -i irish_bus_daemon python - --expected-db ireland_public \\
      --phase copy < scripts/compact_bus_archive.py
"""

import argparse
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta

import psycopg
from psycopg import sql

# same expression as bus_daemon.ARCHIVE_HASH_SQL
HASH_SQL = "('x' || left({}, 16))::bit(64)::bigint"

# rows arrive with fetched_at at poll time and commit within seconds, so an
# hour this far behind now can no longer gain rows
SETTLE = timedelta(minutes=10)
STEP = timedelta(hours=1)
LOCK_ATTEMPTS = 10


@dataclass(frozen=True)
class Archive:
    name: str
    time_column: str
    identity: tuple[str, ...]
    hashed: bool

    @property
    def compact(self) -> str:
        return f"{self.name}_compact"

    @property
    def legacy(self) -> str:
        return f"{self.name}_legacy"

    @property
    def progress(self) -> str:
        return f"compact:{self.name}"


# identities match the collector's ON CONFLICT targets
ARCHIVES = {
    archive.name: archive
    for archive in (
        Archive(
            "bus_stop_observations",
            "fetched_at",
            ("fetched_at", "feed_version_id", "update_hash"),
            True,
        ),
        Archive(
            "bus_vehicle_observations",
            "fetched_at",
            ("fetched_at", "feed_version_id", "vehicle_instance_key"),
            True,
        ),
        Archive(
            "bus_trip_observations",
            "last_seen_at",
            ("last_seen_at", "feed_version_id", "trip_instance_key"),
            False,
        ),
    )
}


def regclass(conn: psycopg.Connection, name: str) -> bool:
    return conn.execute("SELECT to_regclass(%s) IS NOT NULL", (name,)).fetchone()[0]


def columns(conn: psycopg.Connection, table: str) -> list[tuple[str, str]]:
    return conn.execute(
        """SELECT attname, format_type(atttypid, atttypmod) FROM pg_attribute
           WHERE attrelid = %s::regclass AND attnum > 0 AND NOT attisdropped
           ORDER BY attnum""",
        (table,),
    ).fetchall()


def progress(conn: psycopg.Connection, archive: Archive) -> tuple[datetime, datetime | None]:
    """Return the copied-through time and the swap time."""

    row = conn.execute(
        """SELECT to_timestamp(last_id), as_of FROM bus_storage_backfill_progress
           WHERE name = %s""",
        (archive.progress,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"{archive.name}: run the copy phase first")
    return row[0], row[1]


def prepare(conn: psycopg.Connection, archive: Archive) -> None:
    if regclass(conn, archive.compact):
        return
    swapped = conn.execute(
        "SELECT as_of FROM bus_storage_backfill_progress WHERE name = %s", (archive.progress,)
    ).fetchone()
    if swapped is not None and swapped[0] is not None:
        print(f"{archive.name}: already compacted at {swapped[0]}, skipping", flush=True)
        return
    hash_type = dict(columns(conn, archive.name)).get("update_hash")
    if archive.hashed and hash_type != "text":
        print(f"{archive.name}: update_hash is already {hash_type}, skipping", flush=True)
        return

    settings = conn.execute(
        """SELECT segmentby, orderby FROM timescaledb_information.hypertable_columnstore_settings
           WHERE hypertable = %s::regclass""",
        (archive.name,),
    ).fetchone()
    if settings is None:
        raise RuntimeError(f"{archive.name}: compression is not enabled")
    first = conn.execute(
        sql.SQL("SELECT {time} FROM {source} ORDER BY {time} LIMIT 1").format(
            time=sql.Identifier(archive.time_column), source=sql.Identifier(archive.name)
        )
    ).fetchone()
    start = conn.execute(
        "SELECT date_trunc('hour', COALESCE(%s, NOW()))", (first[0] if first else None,)
    ).fetchone()[0]

    compact = sql.Identifier(archive.compact)
    with conn.transaction():
        conn.execute(
            sql.SQL("CREATE TABLE {} (LIKE {} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)").format(
                compact, sql.Identifier(archive.name)
            )
        )
        if archive.hashed:
            conn.execute(
                sql.SQL(
                    "ALTER TABLE {} ALTER COLUMN update_hash TYPE BIGINT USING "
                    + HASH_SQL.format("update_hash")
                ).format(compact)
            )
        conn.execute(
            "SELECT create_hypertable(%s, %s, chunk_time_interval => INTERVAL '1 hour')",
            (archive.compact, archive.time_column),
        )
        conn.execute(
            sql.SQL("CREATE UNIQUE INDEX {} ON {} ({})").format(
                sql.Identifier(f"{archive.compact}_identity"),
                compact,
                sql.SQL(", ").join(map(sql.Identifier, archive.identity)),
            )
        )
        conn.execute(
            sql.SQL(
                """ALTER TABLE {} SET (
                       timescaledb.compress,
                       timescaledb.compress_segmentby = {},
                       timescaledb.compress_orderby = {},
                       timescaledb.compress_chunk_time_interval = '1 day')"""
            ).format(compact, sql.Literal(settings[0]), sql.Literal(settings[1]))
        )
        conn.execute(
            """INSERT INTO bus_storage_backfill_progress (name, last_id, target_id, as_of)
               VALUES (%s, extract(epoch FROM %s::timestamptz)::bigint, 0, NULL)
               ON CONFLICT (name) DO UPDATE SET
                   last_id = EXCLUDED.last_id, target_id = 0, as_of = NULL,
                   updated_at = NOW()""",
            (archive.progress, start),
        )
    print(f"{archive.name}: created {archive.compact} from {start}", flush=True)


def copy_range(
    conn: psycopg.Connection, archive: Archive, start: datetime, end: datetime | None
) -> int:
    """Copy [start, end) and check that both sides hold the same rows.

    Runs inside the caller's transaction. The checksum covers every column, so
    a lost row, a duplicate or a wrong hash conversion fails the step.
    """

    names = [name for name, _ in columns(conn, archive.compact)]
    source = [
        sql.SQL(HASH_SQL.format("{}")).format(sql.Identifier(name))
        if archive.hashed and name == "update_hash"
        else sql.Identifier(name)
        for name in names
    ]
    time_column = sql.Identifier(archive.time_column)
    window = sql.SQL("{} >= %(start)s").format(time_column)
    if end is not None:
        window = sql.SQL("{} AND {} < %(end)s").format(window, time_column)
    params = {"start": start, "end": end}

    written = conn.execute(
        sql.SQL("INSERT INTO {} ({}) SELECT {} FROM {} WHERE {}").format(
            sql.Identifier(archive.compact),
            sql.SQL(", ").join(map(sql.Identifier, names)),
            sql.SQL(", ").join(source),
            sql.Identifier(archive.name),
            window,
        ),
        params,
    ).rowcount

    def checksum(table: str, select: list[sql.Composable]) -> tuple[int, int]:
        return conn.execute(
            sql.SQL(
                "SELECT count(*), COALESCE(sum(hashtextextended(ROW({})::text, 0)), 0) "
                "FROM {} WHERE {}"
            ).format(sql.SQL(", ").join(select), sql.Identifier(table), window),
            params,
        ).fetchone()

    expected = checksum(archive.name, source)
    actual = checksum(archive.compact, [sql.Identifier(name) for name in names])
    if written != expected[0] or actual != expected:
        raise RuntimeError(
            f"{archive.name} {start}..{end}: copied {written}, "
            f"source {expected}, compact {actual}"
        )
    return written


def compress_closed(conn: psycopg.Connection, archive: Archive, before: datetime) -> None:
    """Compress copied chunks oldest first so each day merges into one chunk."""

    chunks = conn.execute(
        """SELECT format('%%I.%%I', chunk_schema, chunk_name)
           FROM timescaledb_information.chunks
           WHERE hypertable_name = %s AND NOT is_compressed AND range_end <= %s
           ORDER BY range_start""",
        (archive.compact, before),
    ).fetchall()
    for (chunk,) in chunks:
        conn.execute("SELECT compress_chunk(%s::regclass, if_not_compressed => TRUE)", (chunk,))


def catch_up(conn: psycopg.Connection, archive: Archive, limit_hours: int | None) -> datetime:
    copied, swapped = progress(conn, archive)
    if swapped is not None:
        raise RuntimeError(f"{archive.name}: already swapped at {swapped}")
    boundary = conn.execute(
        "SELECT date_trunc('hour', NOW() - %s::interval)", (SETTLE,)
    ).fetchone()[0]
    steps = 0
    while copied < boundary and (limit_hours is None or steps < limit_hours):
        end = min(copied + STEP, boundary)
        started = time.monotonic()
        with conn.transaction():
            written = copy_range(conn, archive, copied, end)
            conn.execute(
                """UPDATE bus_storage_backfill_progress
                   SET last_id = extract(epoch FROM %s::timestamptz)::bigint,
                       target_id = extract(epoch FROM %s::timestamptz)::bigint,
                       updated_at = NOW()
                   WHERE name = %s""",
                (end, boundary, archive.progress),
            )
        if end.hour == 0 or end == boundary:
            compress_closed(conn, archive, end)
        print(
            f"{archive.name}: {copied:%Y-%m-%d %H:%M} {written} rows "
            f"in {time.monotonic() - started:.1f}s",
            flush=True,
        )
        copied = end
        steps += 1
    return copied


def rename_indexes(conn: psycopg.Connection, table: str, old_prefix: str, new_prefix: str) -> None:
    for (index,) in conn.execute(
        "SELECT indexrelid::regclass::text FROM pg_index WHERE indrelid = %s::regclass",
        (table,),
    ).fetchall():
        if index.startswith(old_prefix):
            conn.execute(
                sql.SQL("ALTER INDEX {} RENAME TO {}").format(
                    sql.Identifier(index), sql.Identifier(new_prefix + index[len(old_prefix):])
                )
            )


def swap(conn: psycopg.Connection, archive: Archive) -> None:
    copied = catch_up(conn, archive, None)
    for attempt in range(1, LOCK_ATTEMPTS + 1):
        try:
            with conn.transaction():
                # a short timeout keeps a waiting lock from queueing the
                # collector behind it
                conn.execute("SET LOCAL lock_timeout = '5s'")
                conn.execute(
                    sql.SQL("LOCK TABLE {}, {} IN ACCESS EXCLUSIVE MODE").format(
                        sql.Identifier(archive.name), sql.Identifier(archive.compact)
                    )
                )
                tail = copy_range(conn, archive, copied, None)
                conn.execute(
                    "SELECT remove_compression_policy(%s::regclass, if_exists => TRUE)",
                    (archive.name,),
                )
                conn.execute(
                    sql.SQL("ALTER TABLE {} RENAME TO {}").format(
                        sql.Identifier(archive.name), sql.Identifier(archive.legacy)
                    )
                )
                rename_indexes(conn, archive.legacy, archive.name, archive.legacy)
                conn.execute(
                    sql.SQL("ALTER TABLE {} RENAME TO {}").format(
                        sql.Identifier(archive.compact), sql.Identifier(archive.name)
                    )
                )
                rename_indexes(conn, archive.name, archive.compact, archive.name)
                # the same policy migration 014 creates
                conn.execute(
                    """SELECT add_compression_policy(%s::regclass, INTERVAL '3 hours',
                           schedule_interval => INTERVAL '30 minutes')""",
                    (archive.name,),
                )
                conn.execute(
                    """UPDATE bus_storage_backfill_progress
                       SET as_of = NOW(), updated_at = NOW() WHERE name = %s""",
                    (archive.progress,),
                )
            print(f"{archive.name}: swapped, {tail} tail rows copied under lock", flush=True)
            return
        except psycopg.errors.LockNotAvailable:
            print(f"{archive.name}: lock busy, attempt {attempt}/{LOCK_ATTEMPTS}", flush=True)
            time.sleep(2)
    raise RuntimeError(f"{archive.name}: could not take the swap lock")


def drop(conn: psycopg.Connection, archive: Archive) -> None:
    if not regclass(conn, archive.legacy):
        print(f"{archive.name}: no {archive.legacy} to drop", flush=True)
        return
    _, swapped = progress(conn, archive)
    if swapped is None:
        raise RuntimeError(f"{archive.name}: not swapped yet")

    def count(table: str) -> int:
        return conn.execute(
            sql.SQL("SELECT count(*) FROM {} WHERE {} < %s").format(
                sql.Identifier(table), sql.Identifier(archive.time_column)
            ),
            (swapped,),
        ).fetchone()[0]

    legacy_rows, compact_rows = count(archive.legacy), count(archive.name)
    if compact_rows < legacy_rows:
        raise RuntimeError(
            f"{archive.name}: {compact_rows} rows before the swap, legacy has {legacy_rows}"
        )
    with conn.transaction():
        conn.execute(sql.SQL("DROP TABLE {}").format(sql.Identifier(archive.legacy)))
    print(f"{archive.name}: dropped {archive.legacy} ({legacy_rows} rows)", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--expected-db", required=True)
    parser.add_argument("--phase", choices=("copy", "swap", "drop"), required=True)
    parser.add_argument(
        "--archive", choices=sorted(ARCHIVES), action="append",
        help="limit to one archive, repeatable (default all)",
    )
    parser.add_argument("--limit-hours", type=int, help="stop the copy after this many hours")
    args = parser.parse_args()
    if args.limit_hours is not None and args.limit_hours < 1:
        parser.error("limit-hours must be positive")

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        database = conn.execute("SELECT current_database()").fetchone()[0]
        if database != args.expected_db:
            raise RuntimeError(f"expected database {args.expected_db}, found {database}")
        if not conn.execute("SELECT pg_try_advisory_lock(2026110801)").fetchone()[0]:
            raise RuntimeError("another archive compaction is running")
        conn.execute("SET work_mem = '64MB'")
        for name in args.archive or ARCHIVES:
            archive = ARCHIVES[name]
            if args.phase == "copy":
                prepare(conn, archive)
                if regclass(conn, archive.compact):
                    catch_up(conn, archive, args.limit_hours)
            elif args.phase == "swap":
                if regclass(conn, archive.compact):
                    swap(conn, archive)
                else:
                    print(f"{archive.name}: nothing to swap", flush=True)
            else:
                drop(conn, archive)


if __name__ == "__main__":
    main()
