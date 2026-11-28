"""weather and road traffic context, collected inside the rail daemon.

sources, all free. Met Éireann and TII's bulk files are CC BY 4.0, TII's map
backend publishes no licence, so its data is for private analysis:
- Met Éireann live hourly observations (prodapi.metweb.ie), today and
  yesterday for 25 synoptic stations, not quality controlled
- Met Éireann quality-controlled hourly archive (clidata.met.ie), one CSV per
  station, refreshed monthly up to the end of the previous month
- Met Éireann weather warnings (met.ie Open_Data)
- TII traffic counters (trafficdata.tii.ie dataserver): site list, yearly
  AADT, and a rolling seven-day count and speed profile per site
- TII bulk daily counts by vehicle class (data.tii.ie), which stop in 2021

TII's per-site hourly dashboards sit behind reCAPTCHA. we don't go near them.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import os
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping, Optional
from zoneinfo import ZoneInfo

import aiohttp

logger = logging.getLogger(__name__)

DUBLIN = ZoneInfo("Europe/Dublin")
USER_AGENT = "irish-rail-nabber-context/1.0"

MET_LIVE_URL = "https://prodapi.metweb.ie/observations/{slug}/{day}"
MET_ARCHIVE_URL = "https://clidata.met.ie/cli/climate_data/webdata/hly{station}.csv"
MET_WARNINGS_URL = "https://www.met.ie/Open_Data/json/warning_IRELAND.json"
TII_DATASERVER = "https://trafficdata.tii.ie/dataserver"
TII_DAILY_CLASS_URL = (
    "https://data.tii.ie/Datasets/TrafficCountData/{d:%Y/%m/%d}/per-site-class-aggr-{d:%Y-%m-%d}.csv"
)

# the archive goes back to the 1940s. 2013 lines up with the first TII counts
WEATHER_ARCHIVE_FROM = date.fromisoformat(os.getenv("WEATHER_ARCHIVE_FROM", "2013-06-01"))
TII_BULK_FIRST_DAY = date(2013, 6, 1)
# data.tii.ie stopped publishing daily files in April 2021
TII_BULK_LAST_DAY = date(2021, 4, 15)
TII_BULK_DAYS_PER_RUN = 20
# a day the bucket is known to serve, used to tell a block from a gap
TII_BULK_KNOWN_DAY = date(2019, 6, 4)
# TII's dataserver is a public map backend, so go gently
TII_REQUEST_GAP_SECONDS = 2.0
# Met Éireann revises recent archive hours, so each refresh re-reads this much
WEATHER_ARCHIVE_REPLAY = timedelta(days=45)
# after a 403, 429 or server error every TII task waits this long
TII_COOLDOWN_SECONDS = 1800
# a site or station that failed waits this long before it is tried again
RETRY_AFTER_FAILURE = timedelta(hours=6)
# TII reports speeds in millimetres per second
MM_PER_S_TO_KMH = 0.0036


@dataclass(frozen=True)
class WeatherStation:
    station_id: int
    slug: str
    name: str
    lat: float
    lon: float


# live slugs matched to archive station numbers and coordinates from
# clidata.met.ie StationDetails.csv
WEATHER_STATIONS = (
    WeatherStation(532, "dublinairport", "Dublin Airport", 53.42778, -6.24083),
    WeatherStation(3723, "casement", "Casement", 53.30556, -6.43889),
    WeatherStation(175, "phoenix-park", "Phoenix Park", 53.36361, -6.34972),
    WeatherStation(1075, "roches-point", "Roches Point", 51.79306, -8.24444),
    WeatherStation(375, "oak-park", "Oak Park", 52.86111, -6.91528),
    WeatherStation(1875, "athenry", "Athenry", 53.28917, -8.78556),
    WeatherStation(575, "moore-park", "Moore Park", 52.16389, -8.26389),
    WeatherStation(518, "shannon-airport", "Shannon Airport", 52.69028, -8.91806),
    WeatherStation(2175, "claremorris", "Claremorris", 53.71083, -8.9925),
    WeatherStation(1475, "gurteen", "Gurteen", 53.035, -8.00861),
    WeatherStation(1275, "markree", "Markree", 54.175, -8.45556),
    WeatherStation(4935, "knock-airport", "Knock Airport", 53.90611, -8.81722),
    WeatherStation(2275, "valentia-observatory", "Valentia Observatory", 51.93833, -10.24083),
    WeatherStation(2375, "belmullet", "Belmullet", 54.2275, -10.00694),
    WeatherStation(3904, "cork-airport", "Cork Airport", 51.84722, -8.48611),
    WeatherStation(1175, "newport", "Newport", 53.92361, -9.57278),
    WeatherStation(275, "mace-head", "Mace Head", 53.32583, -9.90083),
    WeatherStation(1775, "johnstown-castle", "Johnstown Castle", 52.29778, -6.49667),
    WeatherStation(1575, "malin-head", "Malin Head", 55.37194, -7.33917),
    WeatherStation(875, "mullingar", "Mullingar", 53.53722, -7.36222),
    WeatherStation(675, "ballyhaise", "Ballyhaise", 54.05139, -7.30972),
    WeatherStation(775, "sherkin-island", "Sherkin Island", 51.47639, -9.42778),
    WeatherStation(1375, "dunsany", "Dunsany", 53.51583, -6.66),
    WeatherStation(2075, "finner", "Finner", 54.49389, -8.24306),
    WeatherStation(1975, "mount-dillon", "Mount Dillon", 53.72694, -7.98083),
)


# ============================================================================
# parsing (pure)
# ============================================================================


def _number(value: object) -> Optional[float]:
    """Met Éireann pads numbers with spaces and uses '-', blanks or -99 for
    missing. -99 is out of range for every field the live feed reports"""
    if value is None or isinstance(value, bool):
        return None
    text = str(value).strip()
    if not text or text.lower() in {"-", "n/a", "-99"}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_live_observations(station_id: int, payload: object) -> list[tuple]:
    """rows from prodapi /observations/<slug>/<day>. reportTime is Irish local time"""
    rows = []
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, Mapping):
            continue
        try:
            local = datetime.strptime(
                f"{item.get('date')} {item.get('reportTime')}", "%d-%m-%Y %H:%M"
            ).replace(tzinfo=DUBLIN)
        except (TypeError, ValueError):
            continue
        description = str(item.get("weatherDescription") or "").strip()
        if description.lower() in {"", "n/a"}:
            description = None
        rows.append(
            (
                station_id,
                local.astimezone(timezone.utc),
                _number(item.get("temperature")),
                _number(item.get("rainfall")),
                _number(item.get("windSpeed")),
                _number(item.get("windGust")),
                _number(item.get("windDirection")),
                _number(item.get("humidity")),
                _number(item.get("pressure")),
                None,
                description,
                "live",
            )
        )
    return rows


def parse_archive_header(line: str) -> Optional[list[str]]:
    """the clidata header block ends at the line starting 'date,'. duplicate
    'ind' columns get their position so lookups stay exact"""
    if not line.startswith("date,"):
        return None
    columns = line.strip().split(",")
    # Phoenix Park and Markree publish no wind columns, so only these are required
    if not {"rain", "temp"} <= set(columns):
        return None
    return [
        f"{name}{index}" if name == "ind" else name
        for index, name in enumerate(columns)
    ]


def parse_archive_row(station_id: int, header: list[str], line: str) -> Optional[tuple]:
    """one clidata hourly row. dates are UTC like 01-nov-2026 00:00"""
    values = line.rstrip("\r\n").split(",")
    if len(values) != len(header):
        return None
    row = dict(zip(header, values))
    try:
        observed = datetime.strptime(row["date"], "%d-%b-%Y %H:%M").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    return (
        station_id,
        observed,
        _number(row.get("temp")),
        _number(row.get("rain")),
        _number(row.get("wdsp")),
        None,
        _number(row.get("wddir")),
        _number(row.get("rhum")),
        _number(row.get("msl")),
        _number(row.get("vis")),
        None,
        "archive",
    )


def parse_tii_sites(payload: object) -> list[tuple]:
    data = payload.get("data") if isinstance(payload, Mapping) else None
    rows = []
    for site in (data or {}).values() if isinstance(data, Mapping) else []:
        if not isinstance(site, Mapping) or not site.get("id"):
            continue
        location = site.get("location") if isinstance(site.get("location"), Mapping) else {}
        params = site.get("parameters") if isinstance(site.get("parameters"), Mapping) else {}
        speed_limit = _number(site.get("speedLimit"))
        rows.append(
            (
                str(site["id"]),
                str(site.get("cosit") or "") or None,
                str(site.get("name") or "") or None,
                str(site.get("description") or "") or None,
                str(params.get("category") or "") or None,
                str(params.get("county") or "") or None,
                _number(location.get("lat")),
                _number(location.get("lng")),
                round(speed_limit * MM_PER_S_TO_KMH) if speed_limit else None,
                _number(site.get("bearing")),
                bool(site.get("isDisabled")),
            )
        )
    return rows


def parse_tii_yearly(site_id: str, payload: object) -> list[tuple]:
    data = payload.get("data") if isinstance(payload, Mapping) else None
    rows = []
    for year in data if isinstance(data, list) else []:
        if not isinstance(year, Mapping) or _number(year.get("year")) is None:
            continue
        rows.append(
            (
                site_id,
                int(year["year"]),
                _number(year.get("aadt")),
                _number(year.get("coverage")),
                _number(year.get("totalCount")),
                _number(year.get("hgvPml")),
            )
        )
    return rows


def parse_tii_week(site_id: str, captured_on: date, payload: object) -> Optional[tuple]:
    data = payload.get("data") if isinstance(payload, Mapping) else None
    if not isinstance(data, Mapping) or not isinstance(data.get("total"), Mapping):
        return None
    total = data["total"]
    days = sorted(
        {
            str(day)[:10]
            for day in (data.get("sourceDays") or {}).values()
            if isinstance(day, str)
        }
    )

    def kmh(value: object) -> Optional[float]:
        speed = _number(value)
        return round(speed * MM_PER_S_TO_KMH, 1) if speed is not None else None

    directions = [
        {
            "direction": d.get("direction"),
            "count": d.get("count"),
            "avg_kmh": kmh(d.get("averageSpeed")),
            "workday_avg_kmh": kmh(d.get("workDayAverageSpeed")),
            "speed_distribution": d.get("speedDistribution"),
        }
        for d in data.get("byDirection") or []
        if isinstance(d, Mapping)
    ]
    bins = [
        [kmh(edge) for edge in pair] if isinstance(pair, list) else None
        for pair in data.get("speedBins") or []
    ]
    return (
        site_id,
        captured_on,
        days,
        _number(total.get("count")),
        kmh(total.get("averageSpeed")),
        kmh(total.get("workDayAverageSpeed")),
        json.dumps({"bins_kmh": bins, "distribution": total.get("speedDistribution")}),
        json.dumps(directions),
    )


def parse_tii_daily_class(text: str) -> list[tuple]:
    """rows of one bulk file. any row that doesn't parse raises, so a damaged
    file can't be recorded as a complete day"""
    rows = []
    for line_number, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        try:
            rows.append(
                (
                    row["cosit"],
                    date(int(row["year"]), int(row["month"]), int(row["day"])),
                    int(row["class"]),
                    int(row["VehicleCount"]),
                )
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"line {line_number} does not parse") from error
    return rows


def warning_rows(payload: object) -> list[tuple]:
    """Met Éireann warnings carry an id. anything without one is keyed on its text"""
    rows = []
    for item in payload if isinstance(payload, list) else []:
        if not isinstance(item, Mapping):
            continue
        key = str(item.get("id") or item.get("cap_id") or "") or json.dumps(
            [item.get("headline"), item.get("onset"), item.get("regions")], sort_keys=True
        )
        rows.append(
            (
                key,
                str(item.get("level") or item.get("severity") or "") or None,
                str(item.get("type") or "") or None,
                str(item.get("headline") or "") or None,
                str(item.get("description") or "") or None,
                item.get("onset"),
                item.get("expiry"),
                json.dumps(item.get("regions") or []),
                json.dumps(item, sort_keys=True),
            )
        )
    return rows


# ============================================================================
# collector
# ============================================================================

WEATHER_UPSERT = """
INSERT INTO weather_hourly (
    station_id, observed_at, temp_c, rain_mm, wind_kt, gust_kt, wind_dir_deg,
    humidity_pct, pressure_hpa, visibility_m, weather_text, source
) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (station_id, observed_at) DO UPDATE SET
    temp_c = EXCLUDED.temp_c, rain_mm = EXCLUDED.rain_mm, wind_kt = EXCLUDED.wind_kt,
    gust_kt = COALESCE(EXCLUDED.gust_kt, weather_hourly.gust_kt),
    wind_dir_deg = EXCLUDED.wind_dir_deg, humidity_pct = EXCLUDED.humidity_pct,
    pressure_hpa = EXCLUDED.pressure_hpa,
    visibility_m = COALESCE(EXCLUDED.visibility_m, weather_hourly.visibility_m),
    weather_text = COALESCE(EXCLUDED.weather_text, weather_hourly.weather_text),
    source = EXCLUDED.source
-- quality-controlled archive rows replace live ones, never the other way round
WHERE weather_hourly.source = 'live' OR EXCLUDED.source = 'archive'
"""


class TiiUnavailable(Exception):
    """TII refused or failed. the current pass stops and the next run retries.
    site_failed is false when no request was made because of a cooldown"""

    def __init__(self, message: str, site_failed: bool = True) -> None:
        super().__init__(message)
        self.site_failed = site_failed


class ContextCollector:
    def __init__(self, pool: Any, record_fetch: Any) -> None:
        self.pool = pool
        self.record_fetch = record_fetch
        self.session: Optional[aiohttp.ClientSession] = None
        self._stations_ready = False
        # every TII call shares one gap, whichever task makes it
        self._tii_lock = asyncio.Lock()
        self._tii_last_call = 0.0
        # set by a refusal, honoured by every task until it passes
        self._tii_blocked_until = 0.0

    async def open(self) -> None:
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=600, connect=20, sock_read=120),
            headers={"User-Agent": USER_AGENT},
        )

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()

    async def _get_json(self, url: str) -> object:
        async with self.session.get(url) as resp:
            resp.raise_for_status()
            return await resp.json(content_type=None)

    async def _tii(self, method: str, path: str, body: Optional[dict] = None) -> object:
        """one paced call to TII's map backend. a 429 or server error raises
        TiiUnavailable so the caller stops its pass instead of hammering on"""
        headers = {"X-Requested-With": "XMLHttpRequest"}
        url = f"{TII_DATASERVER}/{path}"
        async with self._tii_lock:
            loop = asyncio.get_running_loop()
            if loop.time() < self._tii_blocked_until:
                raise TiiUnavailable(f"{path}: cooling down after a refusal", site_failed=False)
            wait = self._tii_last_call + TII_REQUEST_GAP_SECONDS - loop.time()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                if method == "GET":
                    request = self.session.get(url, headers=headers)
                else:
                    request = self.session.post(url, headers=headers, json=body or {})
                async with request as resp:
                    if resp.status in (403, 429) or resp.status >= 500:
                        retry_after = resp.headers.get("Retry-After", "")
                        cooldown = int(retry_after) if retry_after.isdigit() else TII_COOLDOWN_SECONDS
                        self._tii_blocked_until = loop.time() + cooldown
                        raise TiiUnavailable(f"{path}: HTTP {resp.status}")
                    resp.raise_for_status()
                    return await resp.json(content_type=None)
            except (
                aiohttp.ClientConnectionError,
                aiohttp.ClientPayloadError,
                asyncio.TimeoutError,
            ) as error:
                self._tii_blocked_until = loop.time() + TII_COOLDOWN_SECONDS
                raise TiiUnavailable(f"{path}: {error}") from error
            finally:
                self._tii_last_call = loop.time()

    # ---- weather -----------------------------------------------------------

    async def ensure_weather_stations(self) -> None:
        if self._stations_ready:
            return
        async with self.pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.executemany(
                    """INSERT INTO weather_stations (station_id, slug, name, lat, lon)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (station_id) DO UPDATE SET
                           slug = EXCLUDED.slug, name = EXCLUDED.name,
                           lat = EXCLUDED.lat, lon = EXCLUDED.lon""",
                    [(s.station_id, s.slug, s.name, s.lat, s.lon) for s in WEATHER_STATIONS],
                )
            await conn.commit()
        self._stations_ready = True

    async def fetch_live_weather(self) -> None:
        """today and yesterday for every station, so a missed hour heals itself"""
        await self.ensure_weather_stations()
        rows: list[tuple] = []
        failed = 0
        for station in WEATHER_STATIONS:
            for day in ("today", "yesterday"):
                try:
                    payload = await self._get_json(MET_LIVE_URL.format(slug=station.slug, day=day))
                except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
                    failed += 1
                    continue
                rows.extend(parse_live_observations(station.station_id, payload))
        if rows:
            async with self.pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.executemany(WEATHER_UPSERT, rows)
                await conn.commit()
        await self.record_fetch(
            "met/observations", len(rows), "success" if not failed else "partial",
            f"{failed} station-days failed" if failed else None,
        )

    async def import_weather_archive(self) -> None:
        """one station per run, only when its CSV changed. a changed file is
        re-read from WEATHER_ARCHIVE_REPLAY before the last import so revised
        hours land too. rows stream from the response, a 60 MB file never sits
        in memory"""
        await self.ensure_weather_stations()
        async with self.pool.connection() as conn:
            pending = await (
                await conn.execute(
                    """SELECT s.station_id, p.last_modified, p.imported_through
                       FROM weather_stations s
                       LEFT JOIN weather_archive_progress p USING (station_id)
                       WHERE p.checked_at IS NULL OR p.checked_at < NOW() - INTERVAL '1 day'
                       ORDER BY p.checked_at NULLS FIRST
                       LIMIT 1"""
                )
            ).fetchone()
            await conn.commit()
        if pending is None:
            return
        station_id, last_modified, imported_through = pending
        archive_from = datetime.combine(WEATHER_ARCHIVE_FROM, datetime.min.time(), timezone.utc)
        replay_from = (
            max(archive_from, imported_through - WEATHER_ARCHIVE_REPLAY)
            if imported_through else archive_from
        )

        rows_written, newest, modified, status, error = 0, imported_through, last_modified, "success", None
        try:
            headers = {"If-Modified-Since": last_modified} if last_modified else {}
            async with self.session.get(
                MET_ARCHIVE_URL.format(station=station_id), headers=headers
            ) as resp:
                if resp.status != 304:
                    resp.raise_for_status()
                    header: Optional[list[str]] = None
                    batch: list[tuple] = []
                    newest_seen: Optional[datetime] = None
                    async for raw in resp.content:
                        line = raw.decode("latin-1")
                        if header is None:
                            header = parse_archive_header(line)
                            continue
                        row = parse_archive_row(station_id, header, line)
                        if row is None:
                            continue
                        newest_seen = row[1] if newest_seen is None else max(newest_seen, row[1])
                        if row[1] < replay_from:
                            continue
                        batch.append(row)
                        if len(batch) >= 5000:
                            rows_written += await self._write_weather(batch)
                            batch = []
                    if header is None or newest_seen is None:
                        raise ValueError("no hourly rows, the file format may have changed")
                    rows_written += await self._write_weather(batch)
                    newest, modified = newest_seen, resp.headers.get("Last-Modified")
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as failure:
            # progress stays put but the station goes to the back of the queue
            status, error = "failed", str(failure)[:200]
            logger.warning(f"weather archive {station_id}: {failure}")

        async with self.pool.connection() as conn:
            await conn.execute(
                """INSERT INTO weather_archive_progress
                       (station_id, last_modified, imported_through, checked_at)
                   VALUES (%s, %s, %s, NOW())
                   ON CONFLICT (station_id) DO UPDATE SET
                       last_modified = EXCLUDED.last_modified,
                       imported_through = EXCLUDED.imported_through,
                       checked_at = NOW()""",
                (station_id, modified, newest or archive_from),
            )
            await conn.commit()
        await self.record_fetch(f"met/archive/{station_id}", rows_written, status, error)

    async def _write_weather(self, rows: list[tuple]) -> int:
        if not rows:
            return 0
        async with self.pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.executemany(WEATHER_UPSERT, rows)
            await conn.commit()
        return len(rows)

    async def fetch_weather_warnings(self) -> None:
        payload = await self._get_json(MET_WARNINGS_URL)
        rows = warning_rows(payload)
        if rows:
            async with self.pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.executemany(
                        """INSERT INTO weather_warnings (
                               warning_key, level, warning_type, headline, description,
                               onset, expiry, regions, raw
                           ) VALUES (%s, %s, %s, %s, %s, %s::timestamptz, %s::timestamptz,
                                     %s::jsonb, %s::jsonb)
                           ON CONFLICT (warning_key) DO UPDATE SET
                               level = EXCLUDED.level, warning_type = EXCLUDED.warning_type,
                               headline = EXCLUDED.headline,
                               description = EXCLUDED.description,
                               onset = EXCLUDED.onset, expiry = EXCLUDED.expiry,
                               regions = EXCLUDED.regions, raw = EXCLUDED.raw,
                               last_seen = NOW()""",
                        rows,
                    )
                await conn.commit()
        await self.record_fetch("met/warnings", len(rows), "success", None)

    # ---- TII ---------------------------------------------------------------

    async def refresh_tii_sites(self) -> None:
        """runs hourly but only refreshes once a day, so a failed first call
        doesn't leave the other TII tasks without sites for a day"""
        async with self.pool.connection() as conn:
            fresh = await (
                await conn.execute(
                    "SELECT max(updated_at) > NOW() - INTERVAL '1 day' FROM traffic_sites"
                )
            ).fetchone()
            await conn.commit()
        if fresh and fresh[0]:
            return
        payload = await self._tii(
            "POST",
            "sites",
            {
                "array": 0,
                "hasLocation": 1,
                "isPed": 0,
                "fields": ["id", "location", "name", "description", "cosit",
                           "bearing", "parameters", "speedLimit"],
            },
        )
        rows = parse_tii_sites(payload)
        async with self.pool.connection() as conn:
            async with conn.cursor() as cur:
                await cur.executemany(
                    """INSERT INTO traffic_sites (
                           site_id, cosit, name, description, road_category, county,
                           lat, lon, speed_limit_kmh, bearing, is_disabled
                       ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (site_id) DO UPDATE SET
                           cosit = EXCLUDED.cosit, name = EXCLUDED.name,
                           description = EXCLUDED.description,
                           road_category = EXCLUDED.road_category,
                           county = EXCLUDED.county, lat = EXCLUDED.lat, lon = EXCLUDED.lon,
                           speed_limit_kmh = EXCLUDED.speed_limit_kmh,
                           bearing = EXCLUDED.bearing, is_disabled = EXCLUDED.is_disabled,
                           updated_at = NOW()""",
                    rows,
                )
            await conn.commit()
        await self.record_fetch("tii/sites", len(rows), "success", None)

    async def _active_site_ids(self, query: str, params: tuple = ()) -> list[str]:
        async with self.pool.connection() as conn:
            rows = await (await conn.execute(query, params)).fetchall()
            await conn.commit()
        return [row[0] for row in rows]

    async def refresh_tii_weekly(self) -> None:
        """one rolling seven-day snapshot per site per Irish day. a site is
        tried once a day whether or not it answers"""
        today = datetime.now(DUBLIN).date()
        site_ids = await self._active_site_ids(
            """SELECT site_id FROM traffic_sites
               WHERE NOT is_disabled
                 AND (weekly_checked_on IS NULL OR weekly_checked_on < %s)
               ORDER BY site_id""",
            (today,),
        )
        written = 0
        error = None
        for site_id in site_ids:
            try:
                payload = await self._tii("GET", f"siteDashboard/latestSpeed/{site_id}")
            except TiiUnavailable as failure:
                error = str(failure)
                if failure.site_failed:
                    # this site has had its try today, so it can't block the rest
                    async with self.pool.connection() as conn:
                        await conn.execute(
                            "UPDATE traffic_sites SET weekly_checked_on = %s WHERE site_id = %s",
                            (today, site_id),
                        )
                        await conn.commit()
                break
            except (aiohttp.ClientError, ValueError):
                payload = None
            row = parse_tii_week(site_id, today, payload)
            async with self.pool.connection() as conn:
                if row:
                    await conn.execute(
                        """INSERT INTO traffic_site_weekly (
                               site_id, captured_on, source_days, total_count,
                               avg_speed_kmh, workday_avg_speed_kmh, speed_profile,
                               by_direction
                           ) VALUES (%s, %s, %s::date[], %s, %s, %s, %s::jsonb, %s::jsonb)
                           ON CONFLICT (site_id, captured_on) DO NOTHING""",
                        row,
                    )
                    written += 1
                await conn.execute(
                    "UPDATE traffic_sites SET weekly_checked_on = %s WHERE site_id = %s",
                    (today, site_id),
                )
                await conn.commit()
        if site_ids:
            await self.record_fetch(
                "tii/latestSpeed", written, "failed" if error else "success", error
            )

    async def refresh_tii_yearly(self) -> None:
        """AADT by year changes at most monthly, so each site is checked weekly.
        a site that fails waits RETRY_AFTER_FAILURE rather than jumping the queue"""
        site_ids = await self._active_site_ids(
            """SELECT site_id FROM traffic_sites
               WHERE yearly_checked_at IS NULL OR yearly_checked_at < NOW() - INTERVAL '7 days'
               ORDER BY yearly_checked_at NULLS FIRST
               LIMIT 60"""
        )
        written = 0
        error = None
        for site_id in site_ids:
            try:
                rows = parse_tii_yearly(site_id, await self._tii("POST", f"summary/yearly/{site_id}"))
            except TiiUnavailable as failure:
                error = str(failure)
                if failure.site_failed:
                    async with self.pool.connection() as conn:
                        await conn.execute(
                            """UPDATE traffic_sites
                               SET yearly_checked_at = NOW() - INTERVAL '7 days' + %s
                               WHERE site_id = %s""",
                            (RETRY_AFTER_FAILURE, site_id),
                        )
                        await conn.commit()
                break
            except (aiohttp.ClientError, ValueError):
                rows = None
            async with self.pool.connection() as conn:
                if rows:
                    async with conn.cursor() as cur:
                        await cur.executemany(
                            """INSERT INTO traffic_site_yearly (
                                   site_id, year, aadt, coverage, total_count, hgv_per_mille
                               ) VALUES (%s, %s, %s, %s, %s, %s)
                               ON CONFLICT (site_id, year) DO UPDATE SET
                                   aadt = EXCLUDED.aadt, coverage = EXCLUDED.coverage,
                                   total_count = EXCLUDED.total_count,
                                   hgv_per_mille = EXCLUDED.hgv_per_mille""",
                            rows,
                        )
                    written += len(rows)
                # a failed site comes back in RETRY_AFTER_FAILURE, not next run
                await conn.execute(
                    """UPDATE traffic_sites SET yearly_checked_at =
                           CASE WHEN %s THEN NOW()
                                ELSE NOW() - INTERVAL '7 days' + %s END
                       WHERE site_id = %s""",
                    (rows is not None, RETRY_AFTER_FAILURE, site_id),
                )
                await conn.commit()
        if site_ids:
            await self.record_fetch("tii/yearly", written, "failed" if error else "success", error)

    async def _fetch_tii_day(self, day: date) -> Optional[list[tuple]]:
        """rows for one bulk day, None when the bucket answers 403 or 404.
        anything else raises, so the day is retried"""
        async with self.session.get(TII_DAILY_CLASS_URL.format(d=day)) as resp:
            if resp.status in (403, 404):
                return None
            if resp.status != 200:
                raise ValueError(f"{day}: HTTP {resp.status}")
            text = await resp.text()
        if not text.startswith('"cosit","class"'):
            raise ValueError(f"{day}: unexpected file contents")
        rows = parse_tii_daily_class(text)
        if any(row[1] != day for row in rows):
            raise ValueError(f"{day}: file holds counts for another date")
        return rows

    async def _record_tii_days(self, days: list[tuple[date, list[tuple]]]) -> None:
        async with self.pool.connection() as conn:
            async with conn.transaction():
                for day, rows in days:
                    async with conn.cursor() as cur:
                        await cur.executemany(
                            """INSERT INTO traffic_daily_class (cosit, day, vehicle_class, vehicles)
                               VALUES (%s, %s, %s, %s)
                               ON CONFLICT (cosit, day, vehicle_class) DO UPDATE SET
                                   vehicles = EXCLUDED.vehicles""",
                            rows,
                        )
                    await conn.execute(
                        """INSERT INTO traffic_bulk_days (day, rows) VALUES (%s, %s)
                           ON CONFLICT (day) DO UPDATE SET rows = EXCLUDED.rows""",
                        (day, len(rows)),
                    )

    async def backfill_tii_daily_class(self) -> None:
        """2013-2021 daily counts per site and vehicle class, a few days per run.
        a refused day only counts as missing when a day known to exist still
        downloads with rows afterwards, so a block, even one starting mid-run,
        never marks days done. a damaged file is skipped and retried without
        holding up older days"""
        async with self.pool.connection() as conn:
            days = await (
                await conn.execute(
                    """SELECT d::date FROM generate_series(%s::date, %s::date, INTERVAL '1 day') d
                       WHERE NOT EXISTS (SELECT 1 FROM traffic_bulk_days b WHERE b.day = d::date)
                       ORDER BY d DESC LIMIT %s""",
                    (TII_BULK_FIRST_DAY, TII_BULK_LAST_DAY, TII_BULK_DAYS_PER_RUN),
                )
            ).fetchall()
            await conn.commit()
        if not days:
            return
        served: list[tuple[date, list[tuple]]] = []
        refused: list[date] = []
        problems: list[str] = []
        try:
            for (day,) in days:
                try:
                    rows = await self._fetch_tii_day(day)
                except ValueError as damaged:
                    problems.append(str(damaged))
                    continue
                if rows is None:
                    refused.append(day)
                else:
                    served.append((day, rows))
                await asyncio.sleep(TII_REQUEST_GAP_SECONDS / 2)
            if refused:
                probe = await self._fetch_tii_day(TII_BULK_KNOWN_DAY)
                if not probe:
                    problems.append("known day refused or empty, treating refusals as a block")
                    refused = []
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as failure:
            problems.append(str(failure))
            refused = []
        await self._record_tii_days(served + [(day, []) for day in refused])
        await self.record_fetch(
            "tii/bulk",
            sum(len(rows) for _day, rows in served),
            "failed" if problems else "success",
            "; ".join(problems)[:200] or None,
        )
