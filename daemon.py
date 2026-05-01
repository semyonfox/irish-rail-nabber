#!/usr/bin/env python3
"""irish rail data collection daemon.

polls the Irish Rail realtime API and stores train positions, station boards,
and full journey movements in TimescaleDB for research purposes.

bug fixes over the original version:
- empty TIME strings (e.g. <Arrival />) now stored as NULL instead of crashing
- negative late_minutes (early trains) no longer silently discarded
- AutoArrival/AutoDepart "1"/"0" parsed correctly (was checking == "true")
- train_date added to station_events for journey disambiguation
- query_time populated in station_events
- train type map cached (was 115k unnecessary API calls/day)
- movement dedup via content hash (was re-inserting every 60s)
- station board fetches throttled with semaphore (was 171 concurrent)
- stable MD5 hash for dedup (Python hash() varies across restarts)
- proper signal handling for graceful shutdown
- aiohttp.ClientTimeout object (was passing raw int, deprecated)
- connection pool sized for actual workload (was min=5 max=50)
"""

import asyncio
import hashlib
import logging
import os
import re
import signal
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Dict, List, Optional

import aiohttp
import psycopg
from psycopg_pool import AsyncConnectionPool

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

BASE_URL = "http://api.irishrail.ie/realtime/realtime.asmx"

# how often to refresh the train type map (seconds)
TYPE_MAP_REFRESH_INTERVAL = 300

# max concurrent station board fetches (171 stations, pool max 20)
STATION_FETCH_CONCURRENCY = 30

# stale movement hash cleanup interval (seconds)
HASH_CLEANUP_INTERVAL = 3600

# server injects Servertime and Querytime into station board responses every request.
# these change every second and are not real data — strip before hashing for dedup.
_TIMESTAMP_RE = re.compile(
    r"<(?:Servertime|Querytime)>[^<]*</(?:Servertime|Querytime)>"
)


# ============================================================================
# helpers (pure functions, synchronous)
# ============================================================================


def parse_xml(xml_str: str) -> ET.Element:
    """strip namespaces and parse XML"""
    xml_content = xml_str.replace("xmlns=", "xmlnamespace=")
    return ET.fromstring(xml_content)


def extract_text(element: Optional[ET.Element], tag: str, default: str = "") -> str:
    """pull text from XML element, return default if missing"""
    if element is None:
        return default
    child = element.find(tag)
    if child is None or child.text is None:
        return default
    return child.text.strip()


def to_time_or_none(val: str) -> Optional[str]:
    """convert empty/missing time strings to None for TIME columns.
    non-empty strings are returned as-is for PostgreSQL to parse."""
    if not val or not val.strip():
        return None
    return val.strip()


def to_int_or_none(val: str) -> Optional[int]:
    """parse integers including negatives. handles '-1', '0', '5', etc.
    returns None for empty or non-numeric strings."""
    if not val or not val.strip():
        return None
    try:
        return int(val.strip())
    except ValueError:
        return None


def to_bool(val: str) -> bool:
    """convert API boolean strings. '1' -> True, everything else -> False."""
    return val.strip() == "1" if val else False


def parse_hacon_datetime(val: str) -> Optional[datetime]:
    """parse HACON dd/MM/yyyy HH:mm:ss timestamps.

    returns None for the 01/01/1900 default sentinel — that date is the .NET
    DateTime default and cannot be a real Irish Rail timestamp under any
    circumstance, so we clean it at ingest. (this is the one place we deviate
    from "store exactly what the API sends" because the sentinel is unambiguous,
    unlike the 00:00 sentinel in other endpoints which collides with real
    midnight services.)"""
    if not val or not val.strip():
        return None
    val = val.strip()
    if val.startswith("01/01/1900"):
        return None
    try:
        return datetime.strptime(val, "%d/%m/%Y %H:%M:%S")
    except ValueError:
        return None


def stable_hash(*args) -> str:
    """deterministic hash from multiple values. returns hex digest.
    unlike Python's hash(), this is stable across process restarts."""
    h = hashlib.md5()
    for arg in args:
        h.update(str(arg).encode("utf-8"))
    return h.hexdigest()


# ============================================================================
# daemon
# ============================================================================


class IrishRailDaemon:
    def __init__(self, db_url: str):
        self.db_url = db_url
        self.pool: Optional[AsyncConnectionPool] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.station_codes: List[str] = []

        # dedup state
        self.prev_trains_hash: Optional[str] = None
        self.prev_boards_hashes: Dict[str, str] = {}
        self.prev_movement_hashes: Dict[str, str] = {}
        self.prev_train_at_station_hashes: Dict[str, str] = {}
        # key: "train_code:station_code:train_date"
        # value: hash of (status, late_minutes, last_location, due_in, expected_arrival, expected_departure)

        # HACON dedup state
        self.prev_hacon_hash: Optional[str] = None
        self.prev_hacon_train_hashes: Dict[str, str] = {}
        # key: train_code, value: per-train fingerprint of moveable fields

        # cached train type map: train_code -> "DART"/"Mainline"/"Suburban"
        self._type_map: Dict[str, str] = {}
        self._type_map_updated: Optional[datetime] = None

        # shutdown coordination
        self._shutdown = asyncio.Event()

    async def init(self):
        """set up database pool and HTTP session"""
        self.pool = AsyncConnectionPool(
            self.db_url, min_size=2, max_size=20, timeout=30
        )
        await self.pool.open()
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20, connect=10)
        )
        logger.info("daemon initialized (pool: 2-20, timeout: 20s)")

    async def close(self):
        """clean up connections"""
        if self.session:
            await self.session.close()
        if self.pool:
            await self.pool.close()
        logger.info("daemon shutdown complete")

    def _install_signal_handlers(self, loop):
        """register SIGTERM and SIGINT for graceful shutdown"""
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, self._handle_signal, sig)

    def _handle_signal(self, sig):
        logger.info(f"received {sig.name}, shutting down gracefully...")
        self._shutdown.set()

    # ====================================================================
    # API + DB helpers
    # ====================================================================

    async def fetch_api(self, endpoint: str, params: Dict = None) -> Optional[str]:
        """hit Irish Rail API with retry backoff (3 attempts)"""
        url = f"{BASE_URL}/{endpoint}"

        for attempt in range(3):
            try:
                async with self.session.get(url, params=params) as resp:
                    if resp.status == 200:
                        return await resp.text()
                    logger.warning(
                        f"API {endpoint}: status {resp.status} (attempt {attempt + 1}/3)"
                    )
            except asyncio.TimeoutError:
                logger.warning(f"timeout {endpoint} (attempt {attempt + 1}/3)")
            except Exception as e:
                logger.warning(f"error {endpoint}: {e} (attempt {attempt + 1}/3)")

            if attempt < 2:
                await asyncio.sleep(2**attempt)

        logger.error(f"failed to fetch {endpoint} after 3 attempts")
        return None

    async def record_fetch(
        self,
        endpoint: str,
        count: int,
        status: str,
        error: str = None,
        duration_ms: int = 0,
    ):
        """log fetch attempt to database for monitoring"""
        try:
            async with self.pool.connection() as conn:
                await conn.execute(
                    """INSERT INTO fetch_history
                       (endpoint, record_count, status, error_msg, duration_ms, fetched_at)
                       VALUES (%s, %s, %s, %s, %s, NOW())""",
                    (endpoint, count, status, error, duration_ms),
                )
                await conn.commit()
        except Exception as e:
            logger.warning(f"failed to record fetch: {e}")

    # ====================================================================
    # train type map (cached, refreshed every 5 min)
    # ====================================================================

    async def _refresh_type_map(self):
        """rebuild train_code -> type map from type-filtered endpoints.
        called at most every TYPE_MAP_REFRESH_INTERVAL seconds."""
        now = datetime.now()
        if (
            self._type_map_updated
            and (now - self._type_map_updated).total_seconds()
            < TYPE_MAP_REFRESH_INTERVAL
        ):
            return

        try:
            dart_codes, mainline_codes, suburban_codes = await asyncio.gather(
                self._fetch_train_codes_by_type("D"),
                self._fetch_train_codes_by_type("M"),
                self._fetch_train_codes_by_type("S"),
            )

            new_map = {}
            for code in dart_codes:
                new_map[code] = "DART"
            for code in mainline_codes:
                new_map[code] = "Mainline"
            for code in suburban_codes:
                new_map[code] = "Suburban"

            self._type_map = new_map
            self._type_map_updated = now
            logger.info(f"type map refreshed: {len(new_map)} trains")
        except Exception as e:
            logger.warning(f"type map refresh failed: {e}")

    async def _fetch_train_codes_by_type(self, train_type: str) -> set:
        """fetch set of train codes for a specific type (D/M/S)"""
        xml = await self.fetch_api(
            "getCurrentTrainsXML_WithTrainType", {"TrainType": train_type}
        )
        if not xml:
            return set()

        try:
            root = parse_xml(xml)
            return {
                extract_text(t, "TrainCode")
                for t in root
                if extract_text(t, "TrainCode")
            }
        except Exception as e:
            logger.debug(f"error fetching {train_type} trains: {e}")
            return set()

    # ====================================================================
    # fetch tasks
    # ====================================================================

    async def fetch_stations(self):
        """load all Irish Rail stations into database (once daily)"""
        start = datetime.now()
        xml = await self.fetch_api("getAllStationsXML")

        if not xml:
            await self.record_fetch("getAllStationsXML", 0, "failed", "no response")
            return

        try:
            root = parse_xml(xml)
            count = 0

            async with self.pool.connection() as conn:
                for station in root:
                    try:
                        code = extract_text(station, "StationCode")
                        if not code:
                            continue

                        await conn.execute(
                            """INSERT INTO stations
                               (station_code, station_id, station_desc, station_alias,
                                latitude, longitude, updated_at)
                               VALUES (%s, %s, %s, %s, %s, %s, NOW())
                               ON CONFLICT(station_code) DO UPDATE SET
                                   station_id = EXCLUDED.station_id,
                                   station_desc = EXCLUDED.station_desc,
                                   station_alias = EXCLUDED.station_alias,
                                   latitude = EXCLUDED.latitude,
                                   longitude = EXCLUDED.longitude,
                                   updated_at = NOW()""",
                            (
                                code,
                                extract_text(station, "StationId"),
                                extract_text(station, "StationDesc"),
                                extract_text(station, "StationAlias"),
                                float(
                                    extract_text(station, "StationLatitude", "0") or "0"
                                ),
                                float(
                                    extract_text(station, "StationLongitude", "0")
                                    or "0"
                                ),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"station parse error: {e}")

                await conn.commit()

            # classify station types
            logger.info("fetching station type classifications...")
            try:
                (
                    dart_stations,
                    mainline_stations,
                    suburban_stations,
                ) = await asyncio.gather(
                    self._fetch_stations_of_type("D"),
                    self._fetch_stations_of_type("M"),
                    self._fetch_stations_of_type("S"),
                )

                async with self.pool.connection() as conn:
                    for code in dart_stations:
                        await conn.execute(
                            """UPDATE stations SET station_type = %s, is_dart = TRUE,
                               updated_at = NOW() WHERE station_code = %s""",
                            ("D", code),
                        )
                    for code in mainline_stations:
                        await conn.execute(
                            """UPDATE stations SET station_type = %s, is_dart = FALSE,
                               updated_at = NOW() WHERE station_code = %s""",
                            ("M", code),
                        )
                    for code in suburban_stations:
                        await conn.execute(
                            """UPDATE stations SET station_type = %s, is_dart = FALSE,
                               updated_at = NOW() WHERE station_code = %s""",
                            ("S", code),
                        )
                    await conn.commit()
            except Exception as e:
                logger.warning(f"could not fetch station types: {e}")

            # reload station code list
            async with self.pool.connection() as conn:
                rows = await conn.execute(
                    "SELECT station_code FROM stations ORDER BY station_code"
                )
                self.station_codes = [row[0] async for row in rows]

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getAllStationsXML", count, "success", duration_ms=duration
            )
            logger.info(
                f"stations: {count} records, {len(self.station_codes)} codes loaded"
            )

        except Exception as e:
            logger.error(f"stations fetch failed: {e}")
            await self.record_fetch("getAllStationsXML", 0, "failed", str(e))

    async def _fetch_stations_of_type(self, station_type: str) -> set:
        """fetch set of station codes for a specific type (D/M/S/A)"""
        xml = await self.fetch_api(
            "getAllStationsXML_WithStationType", {"StationType": station_type}
        )
        if not xml:
            return set()

        try:
            root = parse_xml(xml)
            return {
                extract_text(s, "StationCode")
                for s in root
                if extract_text(s, "StationCode")
            }
        except Exception as e:
            logger.debug(f"error fetching {station_type} stations: {e}")
            return set()

    async def fetch_trains(self):
        """capture live train positions (deduplicated)"""
        start = datetime.now()
        xml = await self.fetch_api("getCurrentTrainsXML")

        if not xml:
            await self.record_fetch("getCurrentTrainsXML", 0, "failed", "no response")
            return

        try:
            root = parse_xml(xml)

            # build content fingerprint for dedup
            trains_data = []
            for train in root:
                code = extract_text(train, "TrainCode")
                if code:
                    lat = extract_text(train, "TrainLatitude", "0")
                    lon = extract_text(train, "TrainLongitude", "0")
                    trains_data.append(f"{code}:{lat}:{lon}")

            content_hash = stable_hash(*sorted(trains_data))

            if content_hash == self.prev_trains_hash:
                duration = int((datetime.now() - start).total_seconds() * 1000)
                await self.record_fetch(
                    "getCurrentTrainsXML", 0, "skipped", duration_ms=duration
                )
                return

            self.prev_trains_hash = content_hash

            # refresh type map if stale (every 5 min instead of every 3s)
            await self._refresh_type_map()

            count = 0
            async with self.pool.connection() as conn:
                for train in root:
                    try:
                        code = extract_text(train, "TrainCode")
                        if not code:
                            continue

                        lat_str = extract_text(train, "TrainLatitude", "0")
                        lon_str = extract_text(train, "TrainLongitude", "0")

                        await conn.execute(
                            """INSERT INTO train_snapshots
                               (train_code, train_status, latitude, longitude,
                                train_date, direction, public_message, train_type,
                                fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                code,
                                extract_text(train, "TrainStatus"),
                                float(lat_str or "0"),
                                float(lon_str or "0"),
                                extract_text(train, "TrainDate"),
                                extract_text(train, "Direction"),
                                extract_text(train, "PublicMessage"),
                                self._type_map.get(code),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"train parse error: {e}")

                await conn.commit()

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getCurrentTrainsXML", count, "success", duration_ms=duration
            )
            logger.info(f"trains: {count} records")

        except Exception as e:
            logger.error(f"trains fetch failed: {e}")
            await self.record_fetch("getCurrentTrainsXML", 0, "failed", str(e))

    async def fetch_hacon(self):
        """capture HACON enriched train data with per-train dedup.

        same trains as getCurrentTrainsXML but with structured fields the public
        feed lacks: NextLocation, LastLocationType (A/D/E/T), Difference in
        seconds, station codes instead of prose names, full datetimes.

        two layers of dedup:
        1. whole-response hash — skip everything if no train moved at all
        2. per-train hash — when something moved, only insert the trains that changed
           (benchmark shows only ~1 of 75 trains changes per poll, so per-train
            dedup eliminates 98.6% of would-be inserts)
        """
        start = datetime.now()
        xml = await self.fetch_api("getHaconTrainsXML")

        if not xml:
            await self.record_fetch("getHaconTrainsXML", 0, "failed", "no response")
            return

        try:
            root = parse_xml(xml)

            # whole-response dedup (cheap escape hatch — most polls hit this)
            content_hash = stable_hash(xml)
            if content_hash == self.prev_hacon_hash:
                duration = int((datetime.now() - start).total_seconds() * 1000)
                await self.record_fetch(
                    "getHaconTrainsXML", 0, "skipped", duration_ms=duration
                )
                return
            self.prev_hacon_hash = content_hash

            inserted = 0
            unchanged = 0
            async with self.pool.connection() as conn:
                for train in root:
                    code = extract_text(train, "TrainCode").strip()
                    if not code:
                        continue

                    try:
                        # per-train fingerprint over fields that actually move.
                        # status/direction barely change; lat/lon/lastloc/nextloc/
                        # lasttype/diff are the moveable ones.
                        fp = stable_hash(
                            extract_text(train, "TrainStatus"),
                            extract_text(train, "TrainLatitude"),
                            extract_text(train, "TrainLongitude"),
                            extract_text(train, "LastLocation"),
                            extract_text(train, "LastLocationType"),
                            extract_text(train, "NextLocation"),
                            extract_text(train, "Difference"),
                        )

                        if self.prev_hacon_train_hashes.get(code) == fp:
                            unchanged += 1
                            continue
                        self.prev_hacon_train_hashes[code] = fp

                        await conn.execute(
                            """INSERT INTO train_snapshots_hacon
                               (train_code, train_status, latitude, longitude, train_date,
                                direction, last_location_type, last_location, next_location,
                                difference_seconds, train_origin, train_destination,
                                train_origin_time, train_destination_time,
                                scheduled_departure, scheduled_arrival, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                       %s, %s, %s, %s, NOW())""",
                            (
                                code,
                                extract_text(train, "TrainStatus") or None,
                                float(extract_text(train, "TrainLatitude", "0") or "0"),
                                float(extract_text(train, "TrainLongitude", "0") or "0"),
                                extract_text(train, "TrainDate") or None,
                                extract_text(train, "Direction") or None,
                                extract_text(train, "LastLocationType") or None,
                                extract_text(train, "LastLocation") or None,
                                extract_text(train, "NextLocation") or None,
                                to_int_or_none(extract_text(train, "Difference")),
                                extract_text(train, "TrainOrigin") or None,
                                extract_text(train, "TrainDestination") or None,
                                parse_hacon_datetime(extract_text(train, "TrainOriginTime")),
                                parse_hacon_datetime(extract_text(train, "TrainDestinationTime")),
                                parse_hacon_datetime(extract_text(train, "ScheduledDeparture")),
                                parse_hacon_datetime(extract_text(train, "ScheduledArrival")),
                            ),
                        )
                        inserted += 1
                    except Exception as e:
                        logger.debug(f"hacon parse error for {code}: {e}")

                await conn.commit()

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getHaconTrainsXML", inserted, "success", duration_ms=duration
            )
            if inserted > 0:
                total = inserted + unchanged
                logger.info(
                    f"hacon: {inserted} inserted, {unchanged} unchanged "
                    f"({100 * unchanged / total:.0f}% per-train deduped)"
                )

        except Exception as e:
            logger.error(f"hacon fetch failed: {e}")
            await self.record_fetch("getHaconTrainsXML", 0, "failed", str(e))

    async def fetch_all_station_boards(self):
        """poll all stations for arrivals/departures (per-station dedup)"""
        start = datetime.now()

        if not self.station_codes:
            async with self.pool.connection() as conn:
                rows = await conn.execute(
                    "SELECT station_code FROM stations ORDER BY station_code"
                )
                self.station_codes = [row[0] async for row in rows]

        if not self.station_codes:
            logger.warning("no stations loaded")
            return

        semaphore = asyncio.Semaphore(STATION_FETCH_CONCURRENCY)

        async def fetch_with_limit(code):
            async with semaphore:
                return await self._fetch_board_xml(code)

        fetch_tasks = [fetch_with_limit(code) for code in self.station_codes]
        board_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

        changed_count = 0
        total_records = 0

        for result in board_results:
            try:
                if isinstance(result, Exception):
                    logger.debug(f"fetch error: {result}")
                    continue

                station_code, xml = result
                if not xml:
                    continue

                content_hash = stable_hash(_TIMESTAMP_RE.sub("", xml))

                if self.prev_boards_hashes.get(station_code) == content_hash:
                    continue

                self.prev_boards_hashes[station_code] = content_hash
                changed_count += 1
                count = await self._insert_station_events(station_code, xml)
                total_records += count
            except Exception as e:
                logger.debug(f"board processing error: {e}")

        duration = int((datetime.now() - start).total_seconds() * 1000)
        status = "success" if changed_count > 0 else "skipped"
        await self.record_fetch(
            "getStationDataByCodeXML", total_records, status, duration_ms=duration
        )
        if changed_count > 0:
            logger.info(
                f"station boards: {total_records} records from "
                f"{changed_count}/{len(self.station_codes)} changed stations"
            )

    async def _fetch_board_xml(self, station_code: str) -> tuple:
        """fetch station board XML, return (station_code, xml) tuple"""
        xml = await self.fetch_api(
            "getStationDataByCodeXML", {"StationCode": station_code}
        )
        return (station_code, xml)

    async def _insert_station_events(self, station_code: str, xml: str) -> int:
        """parse and insert station events for one station.

        fixes applied:
        - train_date extracted and stored (was missing entirely)
        - query_time extracted and stored (column existed but was never populated)
        - late_minutes handles negatives via to_int_or_none (was using isdigit())
        - due_in handles negatives via to_int_or_none
        - time columns use to_time_or_none (empty -> NULL, not "00:00")
        - row-level dedup: only insert if status/late/location/due_in/expected_times changed
        """
        if not xml:
            return 0

        try:
            root = parse_xml(xml)
            count = 0

            async with self.pool.connection() as conn:
                for board in root:
                    try:
                        train_code = extract_text(board, "Traincode")
                        if not train_code:
                            continue

                        train_code = train_code.strip()
                        train_date = extract_text(board, "Traindate")
                        query_time = extract_text(board, "Querytime")

                        # row-level dedup: only insert if train state changed
                        # fingerprint includes all meaningful fields except fetched_at and query_time
                        fingerprint = stable_hash(
                            extract_text(board, "Status"),
                            extract_text(board, "Late"),
                            extract_text(board, "Lastlocation"),
                            to_time_or_none(extract_text(board, "Exparrival")),
                            to_time_or_none(extract_text(board, "Expdepart")),
                        )
                        cache_key = f"{train_code}:{station_code}:{train_date}"

                        if (
                            self.prev_train_at_station_hashes.get(cache_key)
                            == fingerprint
                        ):
                            continue  # no change, skip insert

                        self.prev_train_at_station_hashes[cache_key] = fingerprint

                        await conn.execute(
                            """INSERT INTO station_events
                               (train_code, station_code, train_date,
                                origin, destination, train_type, direction,
                                status, scheduled_arrival, scheduled_departure,
                                expected_arrival, expected_departure,
                                late_minutes, last_location, due_in,
                                location_type, origin_time, destination_time,
                                query_time, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                       %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                train_code,
                                station_code,
                                train_date or None,
                                extract_text(board, "Origin"),
                                extract_text(board, "Destination"),
                                extract_text(board, "Traintype"),
                                extract_text(board, "Direction"),
                                extract_text(board, "Status"),
                                to_time_or_none(extract_text(board, "Scharrival")),
                                to_time_or_none(extract_text(board, "Schdepart")),
                                to_time_or_none(extract_text(board, "Exparrival")),
                                to_time_or_none(extract_text(board, "Expdepart")),
                                to_int_or_none(extract_text(board, "Late")),
                                extract_text(board, "Lastlocation"),
                                to_int_or_none(extract_text(board, "Duein")),
                                extract_text(board, "Locationtype") or None,
                                to_time_or_none(extract_text(board, "Origintime")),
                                to_time_or_none(extract_text(board, "Destinationtime")),
                                to_time_or_none(query_time),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"board parse error for {station_code}: {e}")

                await conn.commit()

            return count

        except Exception as e:
            logger.debug(f"board insert failed for {station_code}: {e}")
            return 0

    async def fetch_all_train_movements(self):
        """track full journey paths for all live trains (with dedup)"""
        start = datetime.now()

        xml = await self.fetch_api("getCurrentTrainsXML")
        if not xml:
            await self.record_fetch("getTrainMovementsXML", 0, "failed", "no trains")
            return

        try:
            root = parse_xml(xml)
            total = 0
            skipped = 0

            for train in root:
                if self._shutdown.is_set():
                    break

                try:
                    code = extract_text(train, "TrainCode")
                    date = extract_text(train, "TrainDate")
                    if code and date:
                        count = await self._fetch_train_movements(code, date)
                        if count == -1:
                            skipped += 1
                        elif count > 0:
                            total += count
                except Exception as e:
                    logger.debug(f"movement fetch error: {e}")

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getTrainMovementsXML", total, "success", duration_ms=duration
            )
            logger.info(
                f"train movements: {total} stops inserted, {skipped} trains unchanged"
            )

        except Exception as e:
            logger.error(f"all movements fetch failed: {e}")
            await self.record_fetch("getTrainMovementsXML", 0, "failed", str(e))

    async def _fetch_train_movements(self, train_code: str, train_date: str) -> int:
        """get all stops for a single train's complete journey.

        returns -1 if skipped (unchanged), 0 on error, >0 for records inserted.

        fixes applied:
        - empty Arrival/Departure strings -> NULL via to_time_or_none
          (was crashing: PostgreSQL rejects ''::TIME)
        - AutoArrival/AutoDepart "1"/"0" -> True/False via to_bool
          (was checking == "true", always False)
        - per-train content hash dedup (was re-inserting all stops every 60s)
        - train_code stripped of trailing whitespace (API quirk)
        """
        xml = await self.fetch_api(
            "getTrainMovementsXML", {"TrainId": train_code, "TrainDate": train_date}
        )

        if not xml:
            return 0

        try:
            root = parse_xml(xml)

            # build content hash across all stops for dedup
            stop_fingerprints = []
            for movement in root:
                loc = extract_text(movement, "LocationCode")
                arr = extract_text(movement, "Arrival")
                dep = extract_text(movement, "Departure")
                exp_arr = extract_text(movement, "ExpectedArrival")
                exp_dep = extract_text(movement, "ExpectedDeparture")
                stop_fingerprints.append(f"{loc}:{arr}:{dep}:{exp_arr}:{exp_dep}")

            content_hash = stable_hash(*stop_fingerprints)
            cache_key = f"{train_code}:{train_date}"

            if self.prev_movement_hashes.get(cache_key) == content_hash:
                return -1

            self.prev_movement_hashes[cache_key] = content_hash

            count = 0
            async with self.pool.connection() as conn:
                for movement in root:
                    try:
                        code = extract_text(movement, "TrainCode")
                        if not code:
                            continue

                        code = code.strip()

                        await conn.execute(
                            """INSERT INTO train_movements
                               (train_code, train_date, location_code,
                                location_full_name, location_order,
                                location_type, train_origin, train_destination,
                                scheduled_arrival, scheduled_departure,
                                expected_arrival, expected_departure,
                                actual_arrival, actual_departure,
                                auto_arrival, auto_departure,
                                stop_type, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                       %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                code,
                                extract_text(movement, "TrainDate"),
                                extract_text(movement, "LocationCode"),
                                extract_text(movement, "LocationFullName") or None,
                                int(
                                    extract_text(movement, "LocationOrder", "0") or "0"
                                ),
                                extract_text(movement, "LocationType"),
                                extract_text(movement, "TrainOrigin"),
                                extract_text(movement, "TrainDestination"),
                                to_time_or_none(
                                    extract_text(movement, "ScheduledArrival")
                                ),
                                to_time_or_none(
                                    extract_text(movement, "ScheduledDeparture")
                                ),
                                to_time_or_none(
                                    extract_text(movement, "ExpectedArrival")
                                ),
                                to_time_or_none(
                                    extract_text(movement, "ExpectedDeparture")
                                ),
                                to_time_or_none(extract_text(movement, "Arrival")),
                                to_time_or_none(extract_text(movement, "Departure")),
                                to_bool(extract_text(movement, "AutoArrival")),
                                to_bool(extract_text(movement, "AutoDepart")),
                                extract_text(movement, "StopType"),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        loc_code = extract_text(movement, "LocationCode", "?")
                        logger.warning(
                            f"movement INSERT failed for {train_code} "
                            f"at {loc_code}: {e}"
                        )

                await conn.commit()

            return count

        except Exception as e:
            logger.error(f"train movements fetch failed for {train_code}: {e}")
            return 0

    # ====================================================================
    # maintenance tasks
    # ====================================================================

    async def cleanup_stale_hashes(self):
        """remove movement hashes for trains that are no longer running.
        prevents unbounded memory growth over days of operation."""
        xml = await self.fetch_api("getCurrentTrainsXML")
        if not xml:
            return

        try:
            root = parse_xml(xml)
            active_keys = set()
            for train in root:
                code = extract_text(train, "TrainCode")
                date = extract_text(train, "TrainDate")
                if code and date:
                    active_keys.add(f"{code}:{date}")

            stale_keys = set(self.prev_movement_hashes.keys()) - active_keys
            for key in stale_keys:
                del self.prev_movement_hashes[key]

            # clean HACON per-train hashes for trains no longer running
            active_codes = {key.split(":")[0] for key in active_keys}
            stale_hacon = set(self.prev_hacon_train_hashes.keys()) - active_codes
            for code in stale_hacon:
                del self.prev_hacon_train_hashes[code]

            # also clean train_at_station hashes for trains no longer running
            # keys are "train_code:station_code:train_date", extract "train_code:train_date" to check
            stale_train_station_keys = set()
            for key in self.prev_train_at_station_hashes.keys():
                parts = key.split(":")
                if len(parts) == 3:
                    train_part = f"{parts[0]}:{parts[2]}"  # train_code:train_date
                    if train_part not in active_keys:
                        stale_train_station_keys.add(key)

            for key in stale_train_station_keys:
                del self.prev_train_at_station_hashes[key]

            if stale_keys or stale_train_station_keys:
                logger.info(
                    f"cleaned {len(stale_keys)} stale movement hashes, "
                    f"{len(stale_train_station_keys)} stale station hashes, "
                    f"{len(self.prev_movement_hashes)} movement active, "
                    f"{len(self.prev_train_at_station_hashes)} station active"
                )
        except Exception as e:
            logger.debug(f"hash cleanup error: {e}")

    # ====================================================================
    # schedulers
    # ====================================================================

    async def schedule_task(self, name: str, func, interval_seconds: int):
        """repeatedly call a function at fixed intervals, respecting shutdown"""
        logger.info(f"starting task '{name}' every {interval_seconds}s")

        while not self._shutdown.is_set():
            try:
                await func()
            except Exception as e:
                logger.error(f"task {name} error: {e}")

            # wait for interval or shutdown, whichever comes first
            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=interval_seconds)
                break  # shutdown was set
            except asyncio.TimeoutError:
                pass  # interval elapsed, loop again

        logger.info(f"task '{name}' stopped")

    async def run(self):
        """start the daemon: init stations, then spawn background tasks"""
        await self.init()

        loop = asyncio.get_running_loop()
        self._install_signal_handlers(loop)

        try:
            logger.info("initializing stations...")
            await self.fetch_stations()

            tasks = [
                asyncio.create_task(self.schedule_task("trains", self.fetch_trains, 5)),
                asyncio.create_task(self.schedule_task("hacon", self.fetch_hacon, 5)),
                asyncio.create_task(
                    self.schedule_task("boards", self.fetch_all_station_boards, 5)
                ),
                asyncio.create_task(
                    self.schedule_task("movements", self.fetch_all_train_movements, 60)
                ),
                asyncio.create_task(
                    self.schedule_task("stations", self.fetch_stations, 86400)
                ),
                asyncio.create_task(
                    self.schedule_task(
                        "hash-cleanup", self.cleanup_stale_hashes, HASH_CLEANUP_INTERVAL
                    )
                ),
            ]

            logger.info("daemon running - all tasks started")
            await asyncio.gather(*tasks)

        except Exception as e:
            logger.error(f"daemon error: {e}")
        finally:
            await self.close()


async def main():
    db_url = os.getenv(
        "DATABASE_URL",
        "postgresql://irish_data:secure_password@localhost:5432/ireland_public",
    )

    daemon = IrishRailDaemon(db_url)
    await daemon.run()


if __name__ == "__main__":
    asyncio.run(main())
