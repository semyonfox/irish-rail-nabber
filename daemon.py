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
import json
import logging
import os
import re
import signal
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path
from typing import Dict, List, Optional

import aiohttp
import psycopg
from psycopg_pool import AsyncConnectionPool

from context_collector import ContextCollector

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

# customer notices live on the API behind irishrail.ie, not the legacy ASMX feed.
# its key is the public one the website ships to every browser, so we read it
# from the homepage instead of pinning a copy that breaks when they rotate it.
# the irishrail.ie terms forbid copying site content without written
# permission, so this stays off unless RAIL_NOTICES=1
RAIL_NOTICES_ENABLED = os.getenv("RAIL_NOTICES", "0") == "1"
# after a refusal or an outage, wait this long, doubling up to the cap
CONNECT_BACKOFF_START_SECONDS = 600
CONNECT_BACKOFF_MAX_SECONDS = 6 * 3600
DUBLIN_TZ = ZoneInfo("Europe/Dublin")
CONNECT_BASE_URL = "https://connect.irishrail.ie"
CONNECT_KEY_PAGE = "https://www.irishrail.ie/en-ie/"
_CONNECT_KEY_RE = re.compile(r'apiKey:"([A-Za-z0-9_-]{16,})"')

# categories whose delay effect is worth measuring against the rollups
ALERT_IMPACT_CATEGORIES = ["delay", "disruption", "works"]

# first match wins, head is checked before body
_ALERT_CATEGORY_RULES = (
    # lift notices often blame works, they are still accessibility
    ("accessibility", re.compile(r"\blifts?\b|escalator", re.I)),
    (
        "disruption",
        re.compile(
            r"cancel|suspend|no (?:train )?services?|bus transfer|replacement bus"
            r"|disrupt|line (?:is )?(?:closed|blocked)",
            re.I,
        ),
    ),
    ("delay", re.compile(r"\bdelay|\blate\b|\+\s*\d+\s*min", re.I)),
    ("works", re.compile(r"\bworks\b|engineering|closure", re.I)),
    ("capacity", re.compile(r"capacity", re.I)),
    ("booking", re.compile(r"\bbook|ticket", re.I)),
)

# an alert names its endpoints (e.g. MHIDE, GSTNS), not every station between.
# the corridor is every stop between those endpoints on trains that ran through
# both that day, so a Malahide-Greystones notice also covers Connolly and Bray.
# delays then come from the hourly rollups, which keeps this around a
# second where scanning station_events for four weeks took over a minute.
ALERT_IMPACT_SQL = """
WITH stops AS (
    SELECT DISTINCT m.train_code, m.location_code, m.location_order
    FROM train_movements m
    WHERE m.train_date = %(service_date)s
      AND m.fetched_at >= %(movements_from)s
      AND m.fetched_at < %(movements_to)s
      AND m.location_type <> 'T'
      AND m.location_code IS NOT NULL
), spans AS (
    SELECT train_code, MIN(location_order) AS lo, MAX(location_order) AS hi
    FROM stops
    WHERE location_code = ANY(%(codes)s::text[])
    GROUP BY train_code
    HAVING cardinality(%(codes)s::text[]) > 1
       AND COUNT(DISTINCT location_code) = cardinality(%(codes)s::text[])
), corridor AS (
    SELECT array_agg(DISTINCT code ORDER BY code) AS codes
    FROM (
        SELECT s.location_code AS code
        FROM stops s JOIN spans p USING (train_code)
        WHERE s.location_order BETWEEN p.lo AND p.hi
        UNION
        SELECT unnest(%(codes)s::text[])
    ) c
), w (label, weeks_back, s, f) AS (
    SELECT 'during', 0, %(h0)s::timestamp, %(t1)s::timestamp
    UNION ALL SELECT 'pre', 0, %(h0)s::timestamp - INTERVAL '2 hours', %(h0)s::timestamp
    UNION ALL SELECT 'baseline', g, %(h0)s::timestamp, %(t1)s::timestamp
        FROM generate_series(1, 4) g
    UNION ALL SELECT 'pre_baseline', g, %(h0)s::timestamp - INTERVAL '2 hours', %(h0)s::timestamp
        FROM generate_series(1, 4) g
)
SELECT c.codes, w.label, SUM(d.event_count)::bigint,
       SUM(d.avg_late_minutes * d.event_count) / NULLIF(SUM(d.event_count), 0),
       MAX(d.max_late_minutes)
FROM corridor c
CROSS JOIN w
JOIN delay_history_hourly d
  ON d.scope_code = ANY(c.codes)
 AND d.bucket >= w.s - w.weeks_back * INTERVAL '7 days'
 AND d.bucket < w.f - w.weeks_back * INTERVAL '7 days'
GROUP BY c.codes, w.label
"""

# rail segment rollups. a service day is final once its late trains have
# finished, so a day is rolled up from 04:00 the next morning
RAIL_SEGMENT_DAYS_PER_RUN = 3
RAIL_SEGMENT_LOOKBACK_DAYS = 400

# seconds late from two time-of-day values, wrapped into +-12h so a 23:58
# schedule and an 00:03 actual reads as 5 minutes late, not 23h55 early.
# %% is how psycopg spells a literal % once the query has parameters
_LATE = "((EXTRACT(EPOCH FROM {a} - {s})::int + 129600) %% 86400 - 43200)"
_RUN = "((EXTRACT(EPOCH FROM {b} - {a})::int + 86400) %% 86400)"

# last known state of every station call for one service date. 00:00 is the
# feed's placeholder for an origin arrival or destination departure
RAIL_CALLS_SQL = """
CREATE TEMP TABLE rail_calls ON COMMIT DROP AS
SELECT train_code, location_order, location_code, location_type,
       NULLIF(scheduled_arrival, TIME '00:00') AS sa,
       NULLIF(scheduled_departure, TIME '00:00') AS sd,
       actual_arrival AS aa, actual_departure AS ad
FROM (
    SELECT DISTINCT ON (train_code, location_order)
           train_code, location_order, location_code, location_type,
           scheduled_arrival, scheduled_departure, actual_arrival, actual_departure
    FROM train_movements
    WHERE train_date = %(service_date)s
      AND fetched_at >= %(movements_from)s
      AND fetched_at < %(movements_to)s
      AND location_code IS NOT NULL
    ORDER BY train_code, location_order, fetched_at DESC
) latest
WHERE location_type <> 'T'
"""

RAIL_SEGMENT_INSERT_SQL = f"""
INSERT INTO rail_segment_delay_hourly (
    service_date, hour_local, from_code, to_code, trains, gain_sum_s,
    gain_pos_sum_s, gain_sq_sum, max_gain_s, run_sum_s, sched_run_sum_s
)
SELECT %(service_date)s, hour_local, from_code, to_code, count(*), sum(gain),
       sum(GREATEST(gain, 0)), sum(gain::bigint * gain), max(gain),
       sum(sched_run + gain), sum(sched_run)
FROM (
    SELECT from_code, to_code, EXTRACT(HOUR FROM sd)::smallint AS hour_local,
           {_LATE.format(a="naa", s="nsa")} - {_LATE.format(a="ad", s="sd")} AS gain,
           {_RUN.format(a="sd", b="nsa")} AS sched_run
    FROM (
        SELECT location_code AS from_code, sd, ad,
               lead(location_code) OVER w AS to_code,
               lead(sa) OVER w AS nsa,
               lead(aa) OVER w AS naa
        FROM rail_calls
        WINDOW w AS (PARTITION BY train_code ORDER BY location_order)
    ) legs
    WHERE to_code IS NOT NULL
      AND sd IS NOT NULL AND ad IS NOT NULL
      AND nsa IS NOT NULL AND naa IS NOT NULL
) segs
-- an hour gained between neighbouring stations is a bad actual, not a stretch
WHERE abs(gain) <= 3600 AND sched_run <= 21600 AND sched_run + gain >= 0
GROUP BY hour_local, from_code, to_code
"""

RAIL_DWELL_INSERT_SQL = f"""
INSERT INTO rail_dwell_delay_hourly (
    service_date, hour_local, station_code, trains, gain_sum_s, gain_pos_sum_s,
    max_gain_s, dwell_sum_s, sched_dwell_sum_s
)
SELECT %(service_date)s, hour_local, location_code, count(*), sum(gain),
       sum(GREATEST(gain, 0)), max(gain), sum(sched_dwell + gain), sum(sched_dwell)
FROM (
    SELECT location_code, EXTRACT(HOUR FROM sd)::smallint AS hour_local,
           {_LATE.format(a="ad", s="sd")} - {_LATE.format(a="aa", s="sa")} AS gain,
           {_RUN.format(a="sa", b="sd")} AS sched_dwell
    FROM rail_calls
    WHERE location_type = 'S'
      AND sa IS NOT NULL AND sd IS NOT NULL AND aa IS NOT NULL AND ad IS NOT NULL
) calls
WHERE abs(gain) <= 3600 AND sched_dwell <= 3600 AND sched_dwell + gain >= 0
GROUP BY hour_local, location_code
"""

# fetch_history only backs the latest-status checks and the 14-day analysis
# report. it grew by about 50k rows a day with no limit
FETCH_HISTORY_RETENTION_DAYS = 30
FETCH_HISTORY_DELETE_BATCH = 50_000

IE_LAT_MIN = 51.0
IE_LAT_MAX = 56.0
IE_LON_MIN = -11.0
IE_LON_MAX = -5.0

PROJECT_ROOT = Path(__file__).resolve().parent
CANONICAL_STATIONS_FILE = PROJECT_ROOT / "network_graphs" / "irish_rail_stations.json"

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


def _parse_float_or_none(val: str) -> Optional[float]:
    if not val or not val.strip():
        return None
    try:
        return float(val.strip())
    except ValueError:
        return None


def is_valid_irish_coordinate(lat: Optional[float], lon: Optional[float]) -> bool:
    """Reject the upstream (0,0) sentinel and impossible Irish coordinates."""
    if lat is None or lon is None:
        return False
    if lat == 0 and lon == 0:
        return False
    return IE_LAT_MIN <= lat <= IE_LAT_MAX and IE_LON_MIN <= lon <= IE_LON_MAX


def to_irish_coordinate_pair(lat_val: str, lon_val: str) -> tuple[Optional[float], Optional[float]]:
    lat = _parse_float_or_none(lat_val)
    lon = _parse_float_or_none(lon_val)
    if not is_valid_irish_coordinate(lat, lon):
        return None, None
    return lat, lon


def _time_to_minutes(val: Optional[str]) -> Optional[int]:
    if not val:
        return None
    parts = val.strip().split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]) * 60 + int(parts[1])
    except ValueError:
        return None


def normalize_late_minutes(
    late: Optional[int],
    scheduled_arrival: Optional[str],
    scheduled_departure: Optional[str],
    expected_arrival: Optional[str],
    expected_departure: Optional[str],
) -> Optional[int]:
    """Drop unambiguous upstream delay garbage before it reaches analytics.

    Irish Rail board times are time-only fields. Around midnight the feed can
    wrap expected times onto the wrong date and emit impossible negative delays
    such as -1079 minutes. Keep normal early trains; reject only clear wraps and
    a hard 12-hour outlier guard.
    """
    if late is None:
        return None
    if abs(late) > 720:
        return None

    scheduled = (
        _time_to_minutes(scheduled_arrival if scheduled_arrival != "00:00" else None)
        or _time_to_minutes(scheduled_departure if scheduled_departure != "00:00" else None)
        or _time_to_minutes(scheduled_arrival)
        or _time_to_minutes(scheduled_departure)
    )
    expected = _time_to_minutes(expected_arrival) or _time_to_minutes(expected_departure)

    if late < -60 and scheduled is not None and expected is not None and expected < scheduled:
        return None

    return late


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


def classify_service_alert(head: str, body: str) -> str:
    for text in (head, body):
        for category, pattern in _ALERT_CATEGORY_RULES:
            if pattern.search(text):
                return category
    return "other"


def _local_iso_or_none(val) -> Optional[str]:
    """upstream sends naive Europe/Dublin times, postgres converts them on insert"""
    if not isinstance(val, str):
        return None
    try:
        return datetime.fromisoformat(val).isoformat(timespec="minutes")
    except ValueError:
        return None


def rail_day_params(service_date) -> Dict:
    """bounds for one service date's movements, bound as plain values so
    timescale skips every other chunk at plan time"""
    day_start = datetime.combine(service_date, datetime.min.time())
    return {
        "service_date": service_date,
        "movements_from": day_start - timedelta(days=1),
        "movements_to": day_start + timedelta(days=2),
    }


def alert_impact_params(codes: List[str], starts_at: datetime, ends_at: datetime) -> Dict:
    """bind plain values so timescale can skip chunks at plan time. bounds
    derived inside the SQL made the planner scan every train_movements chunk"""
    return {
        **rail_day_params(starts_at.astimezone(DUBLIN_TZ).date()),
        "codes": codes,
        # rollup buckets and fetched_at are naive UTC
        "h0": starts_at.astimezone(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0),
        "t1": ends_at.astimezone(timezone.utc).replace(tzinfo=None),
    }


def parse_service_alert(raw) -> Optional[Dict]:
    """turn one /realtime/messages item into a row, or None if it is unusable"""
    if not isinstance(raw, dict):
        return None
    head = (raw.get("head") or "").strip()
    body = (raw.get("text") or "").strip()
    starts = _local_iso_or_none(raw.get("start"))
    ends = _local_iso_or_none(raw.get("end"))
    if not head or not starts or not ends:
        return None

    codes = sorted(
        {c.strip().upper() for c in raw.get("locationCodes") or [] if isinstance(c, str) and c.strip()}
    )
    products = sorted({p for p in raw.get("products") or [] if isinstance(p, str)})
    stops = [s for s in raw.get("eventStops") or [] if isinstance(s, dict)]
    stops_json = json.dumps(stops, sort_keys=True)

    return {
        # identity survives body edits so a revised notice updates in place
        "alert_key": stable_hash("\x1f".join([head, starts, ",".join(codes)])),
        "head": head,
        "body": body,
        "category": classify_service_alert(head, body),
        "starts_local": starts,
        "ends_local": ends,
        "location_codes": codes,
        "products": products,
        "event_stops": stops_json,
        "content_hash": stable_hash(
            "\x1f".join([head, body, starts, ends, ",".join(codes), ",".join(products), stops_json])
        ),
    }


def load_canonical_station_coords() -> Dict[str, tuple[float, float]]:
    """Load local station coordinates as a fallback for broken upstream rows."""
    if not CANONICAL_STATIONS_FILE.exists():
        return {}

    try:
        with CANONICAL_STATIONS_FILE.open("r", encoding="utf-8") as handle:
            stations = json.load(handle)
    except Exception as error:
        logger.warning(f"could not load canonical stations: {error}")
        return {}

    coords: Dict[str, tuple[float, float]] = {}
    for station in stations:
        code = str(station.get("code", "")).strip().upper()
        lat = _parse_float_or_none(str(station.get("latitude", "")))
        lon = _parse_float_or_none(str(station.get("longitude", "")))
        if code and is_valid_irish_coordinate(lat, lon):
            coords[code] = (lat, lon)
    return coords


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
        self.prev_movement_hashes: Dict[tuple[str, str, str, int], str] = {}
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

        # local station coordinates are only used when upstream sends invalid
        # coordinates, e.g. the known 0,0 sentinel stations.
        self.canonical_station_coords = load_canonical_station_coords()

        # shutdown coordination
        self._shutdown = asyncio.Event()

        self._connect_api_key: Optional[str] = None
        self._connect_backoff_seconds = 0
        self._connect_blocked_until = 0.0

        # weather and road traffic, off with CONTEXT_COLLECTION=0
        self.context: Optional[ContextCollector] = None

    async def init(self):
        """set up database pool and HTTP session"""
        self.pool = AsyncConnectionPool(
            self.db_url, min_size=2, max_size=20, timeout=30
        )
        await self.pool.open()
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=20, connect=10)
        )
        if os.getenv("CONTEXT_COLLECTION", "1") != "0":
            self.context = ContextCollector(self.pool, self.record_fetch)
            await self.context.open()
        logger.info("daemon initialized (pool: 2-20, timeout: 20s)")

    async def close(self):
        """clean up connections"""
        if self.context:
            await self.context.close()
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
                        code = code.strip().upper()

                        lat, lon = to_irish_coordinate_pair(
                            extract_text(station, "StationLatitude", "0"),
                            extract_text(station, "StationLongitude", "0"),
                        )
                        if lat is None or lon is None:
                            fallback = self.canonical_station_coords.get(code)
                            if fallback:
                                lat, lon = fallback

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
                                lat,
                                lon,
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
                        lat, lon = to_irish_coordinate_pair(lat_str, lon_str)

                        values = (
                            code,
                            extract_text(train, "TrainStatus"),
                            lat,
                            lon,
                            extract_text(train, "TrainDate"),
                            extract_text(train, "Direction"),
                            extract_text(train, "PublicMessage"),
                            self._type_map.get(code),
                        )
                    except Exception as e:
                        logger.debug(f"train parse error: {e}")
                        continue

                    await conn.execute(
                        """INSERT INTO train_snapshots
                           (train_code, train_status, latitude, longitude,
                            train_date, direction, public_message, train_type,
                            fetched_at)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                        values,
                    )
                    count += 1

                await conn.commit()

            self.prev_trains_hash = content_hash
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

            pending_hashes: Dict[str, str] = {}
            inserted = 0
            unchanged = 0
            async with self.pool.connection() as conn:
                for train in root:
                    code = extract_text(train, "TrainCode").strip()
                    if not code:
                        continue

                    try:
                        lat, lon = to_irish_coordinate_pair(
                            extract_text(train, "TrainLatitude", "0"),
                            extract_text(train, "TrainLongitude", "0"),
                        )

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

                        previous = pending_hashes.get(
                            code, self.prev_hacon_train_hashes.get(code)
                        )
                        if previous == fp:
                            unchanged += 1
                            continue

                        values = (
                            code,
                            extract_text(train, "TrainStatus") or None,
                            lat,
                            lon,
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
                        )
                    except Exception as e:
                        logger.debug(f"hacon parse error for {code}: {e}")
                        continue

                    await conn.execute(
                        """INSERT INTO train_snapshots_hacon
                           (train_code, train_status, latitude, longitude, train_date,
                            direction, last_location_type, last_location, next_location,
                            difference_seconds, train_origin, train_destination,
                            train_origin_time, train_destination_time,
                            scheduled_departure, scheduled_arrival, fetched_at)
                           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                   %s, %s, %s, %s, NOW())""",
                        values,
                    )
                    pending_hashes[code] = fp
                    inserted += 1

                await conn.commit()

            self.prev_hacon_train_hashes.update(pending_hashes)
            self.prev_hacon_hash = content_hash
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
        write_error = None

        for result in board_results:
            if isinstance(result, Exception):
                logger.debug(f"fetch error: {result}")
                continue

            station_code, xml = result
            if not xml:
                continue

            content_hash = stable_hash(_TIMESTAMP_RE.sub("", xml))
            if self.prev_boards_hashes.get(station_code) == content_hash:
                continue

            try:
                count = await self._insert_station_events(station_code, xml)
            except ET.ParseError as e:
                logger.debug(f"board parse error for {station_code}: {e}")
                continue
            except Exception as e:
                logger.warning(f"board insert failed for {station_code}: {e}")
                write_error = write_error or f"{station_code}: {e}"
                continue

            self.prev_boards_hashes[station_code] = content_hash
            changed_count += 1
            total_records += count

        duration = int((datetime.now() - start).total_seconds() * 1000)
        status = "success" if changed_count > 0 else "skipped"
        if write_error is not None:
            status = "failed"
        await self.record_fetch(
            "getStationDataByCodeXML",
            total_records,
            status,
            error=write_error,
            duration_ms=duration,
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

        return the committed row count. XML and storage errors reach the batch caller.

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

        root = parse_xml(xml)
        pending_hashes: Dict[str, str] = {}
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
                    scheduled_arrival = to_time_or_none(
                        extract_text(board, "Scharrival")
                    )
                    scheduled_departure = to_time_or_none(
                        extract_text(board, "Schdepart")
                    )
                    expected_arrival = to_time_or_none(
                        extract_text(board, "Exparrival")
                    )
                    expected_departure = to_time_or_none(
                        extract_text(board, "Expdepart")
                    )
                    late_minutes = normalize_late_minutes(
                        to_int_or_none(extract_text(board, "Late")),
                        scheduled_arrival,
                        scheduled_departure,
                        expected_arrival,
                        expected_departure,
                    )

                    # row-level dedup: only insert if train state changed
                    fingerprint = stable_hash(
                        extract_text(board, "Status"),
                        late_minutes,
                        extract_text(board, "Lastlocation"),
                        expected_arrival,
                        expected_departure,
                    )
                    cache_key = f"{train_code}:{station_code}:{train_date}"
                    previous = pending_hashes.get(
                        cache_key, self.prev_train_at_station_hashes.get(cache_key)
                    )
                    if previous == fingerprint:
                        continue

                    values = (
                        train_code,
                        station_code,
                        train_date or None,
                        extract_text(board, "Origin"),
                        extract_text(board, "Destination"),
                        extract_text(board, "Traintype"),
                        extract_text(board, "Direction"),
                        extract_text(board, "Status"),
                        scheduled_arrival,
                        scheduled_departure,
                        expected_arrival,
                        expected_departure,
                        late_minutes,
                        extract_text(board, "Lastlocation"),
                        to_int_or_none(extract_text(board, "Duein")),
                        extract_text(board, "Locationtype") or None,
                        to_time_or_none(extract_text(board, "Origintime")),
                        to_time_or_none(extract_text(board, "Destinationtime")),
                        to_time_or_none(query_time),
                    )
                except Exception as e:
                    logger.debug(f"board parse error for {station_code}: {e}")
                    continue

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
                    values,
                )
                pending_hashes[cache_key] = fingerprint
                count += 1

            await conn.commit()

        self.prev_train_at_station_hashes.update(pending_hashes)
        return count

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
        - per-stop content hash dedup, published only after a successful commit
        - train_code stripped of trailing whitespace (API quirk)
        """
        xml = await self.fetch_api(
            "getTrainMovementsXML", {"TrainId": train_code, "TrainDate": train_date}
        )

        if not xml:
            return 0

        try:
            root = parse_xml(xml)

            pending_hashes: Dict[tuple[str, str, str, int], str] = {}
            count = 0
            async with self.pool.connection() as conn:
                for movement in root:
                    try:
                        code = extract_text(movement, "TrainCode").strip()
                        if not code:
                            continue

                        location_code = extract_text(movement, "LocationCode").strip().upper()
                        stop_type = extract_text(movement, "StopType") or None
                        if stop_type == "-":
                            stop_type = None

                        values = (
                            code,
                            (extract_text(movement, "TrainDate") or train_date).strip(),
                            location_code,
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
                            stop_type,
                        )
                    except (ValueError, TypeError) as error:
                        logger.warning("invalid movement for %s: %s", train_code, error)
                        continue

                    # LocationOrder distinguishes repeated visits to the same station.
                    cache_key = (code, values[1], location_code, values[4])
                    fingerprint = stable_hash(*values)
                    previous = pending_hashes.get(
                        cache_key, self.prev_movement_hashes.get(cache_key)
                    )
                    if previous == fingerprint:
                        continue
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
                        values,
                    )
                    pending_hashes[cache_key] = fingerprint
                    count += 1
                await conn.commit()

            self.prev_movement_hashes.update(pending_hashes)
            return count if count else -1

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
                    active_keys.add(f"{code.strip()}:{date.strip()}")

            stale_keys = {
                key for key in self.prev_movement_hashes
                if f"{key[0]}:{key[1]}" not in active_keys
            }
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

    async def prune_fetch_history(self):
        """drop fetch log rows past the retention window, in batches so no
        single delete holds its locks for long"""
        deleted = 0
        while not self._shutdown.is_set():
            async with self.pool.connection() as conn:
                cursor = await conn.execute(
                    """DELETE FROM fetch_history WHERE id IN (
                           SELECT id FROM fetch_history
                           WHERE fetched_at < (NOW() AT TIME ZONE 'UTC') - %s * INTERVAL '1 day'
                           ORDER BY id
                           LIMIT %s
                       )""",
                    (FETCH_HISTORY_RETENTION_DAYS, FETCH_HISTORY_DELETE_BATCH),
                )
                await conn.commit()
            deleted += cursor.rowcount
            if cursor.rowcount < FETCH_HISTORY_DELETE_BATCH:
                break
        if deleted:
            logger.info(f"pruned {deleted} fetch_history rows")

    # ====================================================================
    # customer notices (connect.irishrail.ie)
    # ====================================================================

    async def _refresh_connect_api_key(self) -> Optional[str]:
        async with self.session.get(CONNECT_KEY_PAGE) as resp:
            if resp.status != 200:
                logger.warning(f"connect key page: status {resp.status}")
                return None
            match = _CONNECT_KEY_RE.search(await resp.text())
        if not match:
            logger.warning("connect key not found on irishrail.ie homepage")
            return None
        self._connect_api_key = match.group(1)
        return self._connect_api_key

    def _connect_back_off(self, retry_after: Optional[str] = None) -> None:
        self._connect_backoff_seconds = min(
            max(self._connect_backoff_seconds * 2, CONNECT_BACKOFF_START_SECONDS),
            CONNECT_BACKOFF_MAX_SECONDS,
        )
        wait = self._connect_backoff_seconds
        if retry_after and retry_after.isdigit():
            wait = max(wait, int(retry_after))
        self._connect_blocked_until = time.monotonic() + wait
        logger.warning(f"connect.irishrail.ie backing off for {wait}s")

    async def fetch_connect_json(self, path: str):
        """GET a connect.irishrail.ie path. re-reads the key once on 401/403,
        then backs off on any refusal or outage instead of retrying every poll"""
        if time.monotonic() < self._connect_blocked_until:
            return None
        for attempt in range(2):
            key = self._connect_api_key
            if key is None or attempt == 1:
                key = await self._refresh_connect_api_key()
            if key is None:
                self._connect_back_off()
                return None
            async with self.session.get(
                f"{CONNECT_BASE_URL}{path}",
                headers={"x-api-key": key, "Accept": "application/json"},
            ) as resp:
                if resp.status in (401, 403):
                    continue
                if resp.status != 200:
                    logger.warning(f"connect {path}: status {resp.status}")
                    self._connect_back_off(resp.headers.get("Retry-After"))
                    return None
                payload = await resp.json(content_type=None)
                self._connect_backoff_seconds = 0
                return payload
        self._connect_back_off()
        return None

    async def fetch_service_alerts(self):
        if time.monotonic() < self._connect_blocked_until:
            return
        start = datetime.now()
        try:
            payload = await self.fetch_connect_json("/realtime/messages")
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
            self._connect_back_off()
            await self.record_fetch("connect/messages", 0, "failed", str(e)[:200])
            return
        if not isinstance(payload, list):
            await self.record_fetch("connect/messages", 0, "failed", "unexpected payload")
            return

        alerts = {}
        for raw in payload:
            row = parse_service_alert(raw)
            if row:
                alerts[row["alert_key"]] = row

        if alerts:
            async with self.pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        """INSERT INTO rail_service_alerts (
                               alert_key, head, body, category, starts_at, ends_at,
                               location_codes, products, event_stops, content_hash
                           ) VALUES (
                               %(alert_key)s, %(head)s, %(body)s, %(category)s,
                               %(starts_local)s::timestamp AT TIME ZONE 'Europe/Dublin',
                               %(ends_local)s::timestamp AT TIME ZONE 'Europe/Dublin',
                               %(location_codes)s, %(products)s, %(event_stops)s::jsonb,
                               %(content_hash)s
                           )
                           ON CONFLICT (alert_key) DO UPDATE SET
                               last_seen = NOW(),
                               body = EXCLUDED.body,
                               category = EXCLUDED.category,
                               ends_at = EXCLUDED.ends_at,
                               products = EXCLUDED.products,
                               event_stops = EXCLUDED.event_stops,
                               content_hash = EXCLUDED.content_hash,
                               revisions = rail_service_alerts.revisions
                                   + (rail_service_alerts.content_hash <> EXCLUDED.content_hash)::int,
                               -- an edit, or reappearing after a gap (republished, or the
                               -- daemon was down), means the measured window was wrong
                               impact_computed_at = CASE
                                   WHEN rail_service_alerts.content_hash <> EXCLUDED.content_hash
                                     OR rail_service_alerts.last_seen < NOW() - INTERVAL '10 minutes'
                                   THEN NULL
                                   ELSE rail_service_alerts.impact_computed_at
                               END""",
                        list(alerts.values()),
                    )
                await conn.commit()

        duration = int((datetime.now() - start).total_seconds() * 1000)
        await self.record_fetch("connect/messages", len(alerts), "success", duration_ms=duration)

    async def compute_alert_impacts(self):
        """compare delays along each finished alert's corridor with the same
        window on the previous four weeks, using the hourly rollups"""
        async with self.pool.connection() as conn:
            pending = await (
                await conn.execute(
                    """SELECT alert_key, location_codes, starts_at,
                              LEAST(ends_at, last_seen, starts_at + INTERVAL '24 hours'),
                              LEAST(ends_at, last_seen) <= starts_at
                       FROM rail_service_alerts
                       WHERE impact_computed_at IS NULL
                         AND category = ANY(%s)
                         AND cardinality(location_codes) > 0
                         -- rollups rewrite the trailing two hours, wait until they settle
                         AND LEAST(ends_at, last_seen) < NOW() - INTERVAL '2 hours'
                       ORDER BY starts_at
                       LIMIT 20""",
                    (ALERT_IMPACT_CATEGORIES,),
                )
            ).fetchall()

            for alert_key, codes, starts_at, ends_at, never_ran in pending:
                if never_ran:
                    # withdrawn, or stopped being seen, before it was due to start
                    await conn.execute(
                        """UPDATE rail_service_alerts SET
                               corridor_codes = NULL, impact_events = NULL,
                               impact_avg_late = NULL, impact_max_late = NULL,
                               baseline_avg_late = NULL, pre_avg_late = NULL,
                               pre_baseline_avg_late = NULL, impact_window_end = NULL,
                               impact_computed_at = NOW()
                           WHERE alert_key = %s""",
                        (alert_key,),
                    )
                    await conn.commit()
                    continue
                rows = await (
                    await conn.execute(ALERT_IMPACT_SQL, alert_impact_params(codes, starts_at, ends_at))
                ).fetchall()
                stats = {label: (n, avg, max_late) for corridor, label, n, avg, max_late in rows}
                corridor = rows[0][0] if rows else codes
                during = stats.get("during", (0, None, None))
                await conn.execute(
                    """UPDATE rail_service_alerts SET
                           corridor_codes = %s, impact_events = %s,
                           impact_avg_late = %s, impact_max_late = %s,
                           baseline_avg_late = %s, pre_avg_late = %s,
                           pre_baseline_avg_late = %s, impact_window_end = %s,
                           impact_computed_at = NOW()
                       WHERE alert_key = %s""",
                    (
                        corridor,
                        during[0],
                        during[1],
                        during[2],
                        stats.get("baseline", (0, None, None))[1],
                        stats.get("pre", (0, None, None))[1],
                        stats.get("pre_baseline", (0, None, None))[1],
                        ends_at,
                        alert_key,
                    ),
                )
                await conn.commit()

            if pending:
                logger.info(f"alert impacts: {len(pending)} alerts matched to delays")

    async def rollup_rail_segments(self):
        """roll finished service days into segment and dwell totals, newest
        first, a few days per run so the backfill stays gentle"""
        async with self.pool.connection() as conn:
            days = await (
                await conn.execute(
                    """SELECT d::date
                       FROM generate_series(
                           (NOW() AT TIME ZONE 'Europe/Dublin')::date - %s,
                           (NOW() AT TIME ZONE 'Europe/Dublin' - INTERVAL '28 hours')::date,
                           INTERVAL '1 day'
                       ) d
                       WHERE NOT EXISTS (
                           SELECT 1 FROM rail_segment_rollup_days r
                           WHERE r.service_date = d::date
                       )
                       ORDER BY d DESC
                       LIMIT %s""",
                    (RAIL_SEGMENT_LOOKBACK_DAYS, RAIL_SEGMENT_DAYS_PER_RUN),
                )
            ).fetchall()
            # end the implicit transaction so each day below commits on its own
            # and its ON COMMIT DROP temp table goes with it
            await conn.commit()

            for (service_date,) in days:
                params = rail_day_params(service_date)
                async with conn.transaction():
                    await conn.execute(
                        "DELETE FROM rail_segment_delay_hourly WHERE service_date = %s",
                        (service_date,),
                    )
                    await conn.execute(
                        "DELETE FROM rail_dwell_delay_hourly WHERE service_date = %s",
                        (service_date,),
                    )
                    await conn.execute(RAIL_CALLS_SQL, params)
                    segments = await conn.execute(RAIL_SEGMENT_INSERT_SQL, params)
                    await conn.execute(RAIL_DWELL_INSERT_SQL, params)
                    await conn.execute(
                        """INSERT INTO rail_segment_rollup_days (service_date, legs)
                           VALUES (%s, %s)
                           ON CONFLICT (service_date) DO UPDATE SET
                               legs = EXCLUDED.legs, computed_at = NOW()""",
                        (service_date, segments.rowcount),
                    )
                logger.info(f"rail segments {service_date}: {segments.rowcount} segment-hours")

    # ====================================================================
    # schedulers
    # ====================================================================

    async def refresh_delay_history_rollups(self):
        """Recompute only recent mutable hourly history buckets."""
        async with self.pool.connection() as conn:
            cursor = await conn.execute(
                """INSERT INTO delay_history_hourly (
                       bucket, scope_code, avg_late_minutes, p95_late_minutes,
                       max_late_minutes, on_time_pct, event_count, refreshed_at
                   )
                   SELECT
                       date_trunc('hour', fetched_at),
                       CASE WHEN GROUPING(station_code) = 1 THEN '' ELSE station_code END,
                       AVG(late_minutes)::float8,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY late_minutes)::float8,
                       MAX(late_minutes),
                       (COUNT(*) FILTER (WHERE late_minutes <= 5) * 100.0 / COUNT(*))::float8,
                       COUNT(*),
                       NOW()
                   FROM station_events
                   WHERE fetched_at >= date_trunc('hour', NOW()) - INTERVAL '2 hours'
                       AND late_minutes IS NOT NULL
                       AND station_code IS NOT NULL
                       AND NOT (
                           ABS(late_minutes) > 720
                           OR (
                               late_minutes < -60
                               AND COALESCE(expected_arrival, expected_departure) IS NOT NULL
                               AND COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure) IS NOT NULL
                               AND COALESCE(expected_arrival, expected_departure) < COALESCE(NULLIF(scheduled_arrival, TIME '00:00'), NULLIF(scheduled_departure, TIME '00:00'), scheduled_arrival, scheduled_departure)
                           )
                       )
                   GROUP BY GROUPING SETS (
                       (date_trunc('hour', fetched_at), station_code),
                       (date_trunc('hour', fetched_at))
                   )
                   ON CONFLICT (scope_code, bucket) DO UPDATE SET
                       avg_late_minutes = EXCLUDED.avg_late_minutes,
                       p95_late_minutes = EXCLUDED.p95_late_minutes,
                       max_late_minutes = EXCLUDED.max_late_minutes,
                       on_time_pct = EXCLUDED.on_time_pct,
                       event_count = EXCLUDED.event_count,
                       refreshed_at = EXCLUDED.refreshed_at"""
            )
            logger.info(f"history rollups: {cursor.rowcount} hourly scopes refreshed")

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
                asyncio.create_task(
                    self.schedule_task(
                        "history-rollups", self.refresh_delay_history_rollups, 300
                    )
                ),
                asyncio.create_task(
                    self.schedule_task(
                        "fetch-history-retention", self.prune_fetch_history, 3600
                    )
                ),
                asyncio.create_task(
                    self.schedule_task("alert-impacts", self.compute_alert_impacts, 900)
                ),
                asyncio.create_task(
                    self.schedule_task("rail-segments", self.rollup_rail_segments, 3600)
                ),
            ]

            if RAIL_NOTICES_ENABLED:
                tasks.append(
                    asyncio.create_task(
                        self.schedule_task("service-alerts", self.fetch_service_alerts, 120)
                    )
                )

            if self.context:
                context = self.context
                for name, func, interval in (
                    ("weather-live", context.fetch_live_weather, 1800),
                    ("weather-warnings", context.fetch_weather_warnings, 600),
                    # one station per run, a 304 when its file hasn't changed
                    ("weather-archive", context.import_weather_archive, 600),
                    ("tii-sites", context.refresh_tii_sites, 3600),
                    ("tii-weekly", context.refresh_tii_weekly, 3600),
                    ("tii-yearly", context.refresh_tii_yearly, 3600),
                    ("tii-bulk", context.backfill_tii_daily_class, 3600),
                ):
                    tasks.append(asyncio.create_task(self.schedule_task(name, func, interval)))

            logger.info("daemon running - all tasks started")
            await asyncio.gather(*tasks)

        except Exception as e:
            logger.error(f"daemon error: {e}")
        finally:
            await self.close()


async def main():
    db_url = os.environ["DATABASE_URL"]

    daemon = IrishRailDaemon(db_url)
    await daemon.run()


if __name__ == "__main__":
    asyncio.run(main())
