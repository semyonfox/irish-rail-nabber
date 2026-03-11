#!/usr/bin/env python3
import asyncio
import logging
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import aiohttp
import psycopg
from psycopg_pool import AsyncConnectionPool

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

BASE_URL = "http://api.irishrail.ie/realtime/realtime.asmx"


class IrishRailDaemon:
    def __init__(self, db_url: str):
        self.db_url = db_url
        self.pool: Optional[AsyncConnectionPool] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.trains_interval: int = 1
        self.boards_interval: int = 3
        self.stations_interval: int = 86400
        self.prev_trains_hash: Optional[int] = None
        self.prev_boards_hashes: Dict[str, int] = {}
        self.station_codes: List[str] = []

    async def init(self):
        """Set up database pool and HTTP session"""
        self.pool = await AsyncConnectionPool.create(
            self.db_url, min_size=5, max_size=50, command_timeout=30
        )
        self.session = aiohttp.ClientSession()
        logger.info("Daemon initialized")

    async def close(self):
        """Clean up connections"""
        if self.session:
            await self.session.close()
        if self.pool:
            await self.pool.close()
        logger.info("Daemon shutdown complete")

    async def fetch_api(
        self, endpoint: str, params: Dict = None, timeout: int = 15
    ) -> Optional[str]:
        """Hit Irish Rail API with retry backoff (3 attempts)"""
        url = f"{BASE_URL}/{endpoint}"

        for attempt in range(3):
            try:
                async with self.session.get(
                    url, params=params, timeout=timeout
                ) as resp:
                    if resp.status == 200:
                        return await resp.text()
                    else:
                        logger.warning(
                            f"API {endpoint}: status {resp.status}, attempt {attempt + 1}/3"
                        )
                        if attempt < 2:
                            await asyncio.sleep(2**attempt)
            except asyncio.TimeoutError:
                logger.warning(f"Timeout {endpoint}, attempt {attempt + 1}/3")
                if attempt < 2:
                    await asyncio.sleep(2**attempt)
            except Exception as e:
                logger.warning(f"Error {endpoint}: {e}, attempt {attempt + 1}/3")
                if attempt < 2:
                    await asyncio.sleep(2**attempt)

        logger.error(f"Failed to fetch {endpoint} after 3 attempts")
        return None

    async def record_fetch(
        self,
        endpoint: str,
        count: int,
        status: str,
        error: str = None,
        duration_ms: int = 0,
    ):
        """Log fetch attempt to database (for monitoring)"""
        async with self.pool.connection() as conn:
            await conn.execute(
                """INSERT INTO fetch_history (endpoint, record_count, status, error_msg, duration_ms, fetched_at)
                   VALUES (%s, %s, %s, %s, %s, NOW())""",
                (endpoint, count, status, error, duration_ms),
            )
            await conn.commit()

    async def parse_xml(self, xml_str: str) -> ET.Element:
        """Strip namespaces and parse XML"""
        xml_content = xml_str.replace("xmlns=", "xmlnamespace=")
        return ET.fromstring(xml_content)

    async def extract_text(
        self, element: Optional[ET.Element], tag: str, default: str = ""
    ) -> str:
        """Pull text from XML element, return default if missing"""
        if element is None:
            return default
        child = element.find(tag)
        if child is None or child.text is None:
            return default
        return child.text.strip()

    async def fetch_train_codes_by_type(self, train_type: str) -> set:
        """Fetch set of train codes for a specific type (D/M/S/A)"""
        xml = await self.fetch_api(
            "getCurrentTrainsXML_WithTrainType", {"TrainType": train_type}
        )
        if not xml:
            return set()

        try:
            root = await self.parse_xml(xml)
            codes = set()
            for train in root:
                code = await self.extract_text(train, "TrainCode")
                if code:
                    codes.add(code)
            return codes
        except Exception as e:
            logger.debug(f"Error fetching {train_type} trains: {e}")
            return set()

    # ========================================================================
    # FETCH TASKS
    # ========================================================================

    async def fetch_stations(self):
        """Load all 171 Irish Rail stations into database (once daily)"""
        start = datetime.now()
        xml = await self.fetch_api("getAllStationsXML")

        if not xml:
            await self.record_fetch("getAllStationsXML", 0, "failed", "No response")
            return

        try:
            root = await self.parse_xml(xml)
            count = 0
            station_codes_to_type = {}

            async with self.pool.connection() as conn:
                for station in root:
                    try:
                        code = await self.extract_text(station, "StationCode")
                        if not code:
                            continue

                        await conn.execute(
                            """INSERT INTO stations (station_code, station_id, station_desc, station_alias, latitude, longitude, updated_at)
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
                                await self.extract_text(station, "StationId"),
                                await self.extract_text(station, "StationDesc"),
                                await self.extract_text(station, "StationAlias"),
                                float(
                                    await self.extract_text(
                                        station, "StationLatitude", "0"
                                    )
                                    or "0"
                                ),
                                float(
                                    await self.extract_text(
                                        station, "StationLongitude", "0"
                                    )
                                    or "0"
                                ),
                            ),
                        )
                        count += 1
                        station_codes_to_type[code] = None
                    except Exception as e:
                        logger.debug(f"Station parse error: {e}")

                await conn.commit()

            # Populate station_type and is_dart
            logger.info("Fetching station type classifications...")
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
                            "UPDATE stations SET station_type = %s, is_dart = TRUE, updated_at = NOW() WHERE station_code = %s",
                            ("D", code),
                        )
                    for code in mainline_stations:
                        await conn.execute(
                            "UPDATE stations SET station_type = %s, is_dart = FALSE, updated_at = NOW() WHERE station_code = %s",
                            ("M", code),
                        )
                    for code in suburban_stations:
                        await conn.execute(
                            "UPDATE stations SET station_type = %s, is_dart = FALSE, updated_at = NOW() WHERE station_code = %s",
                            ("S", code),
                        )
                    await conn.commit()
            except Exception as e:
                logger.warning(f"Could not fetch station types: {e}")

            self.station_codes = list(station_codes_to_type.keys())

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getAllStationsXML", count, "success", duration_ms=duration
            )
            logger.info(f"Stations: {count} records")

        except Exception as e:
            logger.error(f"Stations fetch failed: {e}")
            await self.record_fetch("getAllStationsXML", 0, "failed", str(e))

    async def _fetch_stations_of_type(self, station_type: str) -> set:
        """Fetch set of station codes for a specific type (D/M/S/A)"""
        xml = await self.fetch_api(
            "getAllStationsXML_WithStationType", {"StationType": station_type}
        )
        if not xml:
            return set()

        try:
            root = await self.parse_xml(xml)
            codes = set()
            for station in root:
                code = await self.extract_text(station, "StationCode")
                if code:
                    codes.add(code)
            return codes
        except Exception as e:
            logger.debug(f"Error fetching {station_type} stations: {e}")
            return set()

    async def fetch_trains(self):
        """Capture live train positions (every 1s, deduplicated)"""
        start = datetime.now()
        xml = await self.fetch_api("getCurrentTrainsXML")

        if not xml:
            await self.record_fetch("getCurrentTrainsXML", 0, "failed", "No response")
            return

        try:
            root = await self.parse_xml(xml)

            trains_data = []
            for train in root:
                try:
                    code = await self.extract_text(train, "TrainCode")
                    if code:
                        lat = await self.extract_text(train, "TrainLatitude", "0")
                        lon = await self.extract_text(train, "TrainLongitude", "0")
                        trains_data.append(f"{code}:{lat}:{lon}")
                except:
                    pass

            trains_hash = hash(tuple(sorted(trains_data)))

            if trains_hash == self.prev_trains_hash:
                duration = int((datetime.now() - start).total_seconds() * 1000)
                await self.record_fetch(
                    "getCurrentTrainsXML", 0, "skipped", duration_ms=duration
                )
                return

            self.prev_trains_hash = trains_hash

            # Build train type map from type-filtered endpoints
            (
                dart_codes,
                mainline_codes,
                suburban_codes,
            ) = await asyncio.gather(
                self.fetch_train_codes_by_type("D"),
                self.fetch_train_codes_by_type("M"),
                self.fetch_train_codes_by_type("S"),
            )

            type_map = {}
            for code in dart_codes:
                type_map[code] = "DART"
            for code in mainline_codes:
                type_map[code] = "Mainline"
            for code in suburban_codes:
                type_map[code] = "Suburban"

            count = 0
            async with self.pool.connection() as conn:
                for train in root:
                    try:
                        code = await self.extract_text(train, "TrainCode")
                        if not code:
                            continue

                        lat_str = await self.extract_text(train, "TrainLatitude", "0")
                        lon_str = await self.extract_text(train, "TrainLongitude", "0")

                        await conn.execute(
                            """INSERT INTO train_snapshots
                               (train_code, train_status, latitude, longitude, train_date, direction, public_message, train_type, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                code,
                                await self.extract_text(train, "TrainStatus"),
                                float(lat_str or "0"),
                                float(lon_str or "0"),
                                await self.extract_text(train, "TrainDate"),
                                await self.extract_text(train, "Direction"),
                                await self.extract_text(train, "PublicMessage"),
                                type_map.get(code),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"Train parse error: {e}")

                await conn.commit()

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getCurrentTrainsXML", count, "success", duration_ms=duration
            )
            logger.info(f"Trains: {count} records")

        except Exception as e:
            logger.error(f"Trains fetch failed: {e}")
            await self.record_fetch("getCurrentTrainsXML", 0, "failed", str(e))

    async def fetch_board_xml(self, station_code: str) -> tuple[str, Optional[str]]:
        """Fetch station board XML, return (station_code, xml) tuple"""
        xml = await self.fetch_api(
            "getStationDataByCodeXML", {"StationCode": station_code}
        )
        return (station_code, xml)

    async def insert_station_events(self, station_code: str, xml: str) -> int:
        """Parse and insert station events for one station"""
        if not xml:
            return 0

        try:
            root = await self.parse_xml(xml)
            count = 0

            async with self.pool.connection() as conn:
                for board in root:
                    try:
                        train_code = await self.extract_text(board, "Traincode")
                        if not train_code:
                            continue

                        train_code = train_code.strip()
                        late_str = await self.extract_text(board, "Late", "0")
                        due_in_str = await self.extract_text(board, "Duein", "0")

                        await conn.execute(
                            """INSERT INTO station_events
                               (train_code, station_code, origin, destination, train_type, direction,
                                status, scheduled_arrival, scheduled_departure,
                                expected_arrival, expected_departure, late_minutes, last_location, due_in,
                                location_type, origin_time, destination_time, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                train_code,
                                station_code,
                                await self.extract_text(board, "Origin"),
                                await self.extract_text(board, "Destination"),
                                await self.extract_text(board, "Traintype"),
                                await self.extract_text(board, "Direction"),
                                await self.extract_text(board, "Status"),
                                await self.extract_text(board, "Scharrival", "00:00"),
                                await self.extract_text(board, "Schdepart", "00:00"),
                                await self.extract_text(board, "Exparrival", "00:00"),
                                await self.extract_text(board, "Expdepart", "00:00"),
                                int(late_str)
                                if late_str and late_str.isdigit()
                                else None,
                                await self.extract_text(board, "Lastlocation"),
                                int(due_in_str)
                                if due_in_str and due_in_str.isdigit()
                                else None,
                                await self.extract_text(board, "Locationtype", " "),
                                await self.extract_text(board, "Origintime"),
                                await self.extract_text(board, "Destinationtime"),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"Board parse error: {e}")

                await conn.commit()

            return count

        except Exception as e:
            logger.debug(f"Board insert failed for {station_code}: {e}")
            return 0

    async def fetch_all_station_boards(self):
        """Poll all 171 stations for arrivals/departures (every 3s, per-station dedup)"""
        start = datetime.now()

        if not self.station_codes:
            async with self.pool.connection() as conn:
                rows = await conn.execute(
                    "SELECT station_code FROM stations ORDER BY station_code"
                )
                self.station_codes = [row[0] async for row in rows]

        if not self.station_codes:
            logger.warning("No stations loaded")
            return

        logger.info(
            f"Fetching {len(self.station_codes)} station boards concurrently..."
        )

        fetch_tasks = [self.fetch_board_xml(code) for code in self.station_codes]
        board_results = await asyncio.gather(*fetch_tasks, return_exceptions=True)

        changed_count = 0
        total_records = 0

        for result in board_results:
            try:
                if isinstance(result, Exception):
                    logger.debug(f"Fetch error: {result}")
                    continue

                station_code, xml = result
                if not xml:
                    continue

                content_hash = hash(xml)

                if self.prev_boards_hashes.get(station_code) == content_hash:
                    continue

                self.prev_boards_hashes[station_code] = content_hash
                changed_count += 1
                count = await self.insert_station_events(station_code, xml)
                total_records += count
            except Exception as e:
                logger.debug(f"Board processing error: {e}")

        duration = int((datetime.now() - start).total_seconds() * 1000)
        status = "success" if changed_count > 0 else "skipped"
        await self.record_fetch(
            "getStationDataByCodeXML", total_records, status, duration_ms=duration
        )
        logger.info(
            f"Station boards: {total_records} records from {changed_count}/{len(self.station_codes)} changed stations"
        )

    async def fetch_all_train_movements(self):
        """Track full journey paths for all live trains (every 60s)"""
        start = datetime.now()

        # Get all live trains
        xml = await self.fetch_api("getCurrentTrainsXML")
        if not xml:
            await self.record_fetch("getTrainMovementsXML", 0, "failed", "No trains")
            return

        try:
            root = await self.parse_xml(xml)
            total = 0

            for train in root:
                try:
                    code = await self.extract_text(train, "TrainCode")
                    date = await self.extract_text(train, "TrainDate")
                    if code and date:
                        count = await self.fetch_train_movements(code, date)
                        total += count
                except Exception as e:
                    logger.debug(f"Movement fetch error: {e}")

            duration = int((datetime.now() - start).total_seconds() * 1000)
            await self.record_fetch(
                "getTrainMovementsXML", total, "success", duration_ms=duration
            )
            logger.info(f"Train movements: {total} stops updated")
        except Exception as e:
            logger.error(f"All movements fetch failed: {e}")
            await self.record_fetch("getTrainMovementsXML", 0, "failed", str(e))

    async def fetch_train_movements(self, train_code: str, train_date: str):
        """Get all stops for a single train's complete journey"""
        xml = await self.fetch_api(
            "getTrainMovementsXML", {"TrainId": train_code, "TrainDate": train_date}
        )

        if not xml:
            return 0

        try:
            root = await self.parse_xml(xml)
            count = 0

            async with self.pool.connection() as conn:
                for movement in root:
                    try:
                        code = await self.extract_text(movement, "TrainCode")
                        if not code:
                            continue

                        await conn.execute(
                            """INSERT INTO train_movements
                               (train_code, train_date, location_code, location_full_name, location_order,
                                location_type, train_origin, train_destination, scheduled_arrival, scheduled_departure,
                                expected_arrival, expected_departure, actual_arrival, actual_departure,
                                auto_arrival, auto_departure, stop_type, fetched_at)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())""",
                            (
                                code,
                                await self.extract_text(movement, "TrainDate"),
                                await self.extract_text(movement, "LocationCode"),
                                await self.extract_text(movement, "LocationFullName"),
                                int(
                                    await self.extract_text(
                                        movement, "LocationOrder", "0"
                                    )
                                    or "0"
                                ),
                                await self.extract_text(movement, "LocationType"),
                                await self.extract_text(movement, "TrainOrigin"),
                                await self.extract_text(movement, "TrainDestination"),
                                await self.extract_text(
                                    movement, "ScheduledArrival", "00:00"
                                ),
                                await self.extract_text(
                                    movement, "ScheduledDeparture", "00:00"
                                ),
                                await self.extract_text(
                                    movement, "ExpectedArrival", "00:00"
                                ),
                                await self.extract_text(
                                    movement, "ExpectedDeparture", "00:00"
                                ),
                                await self.extract_text(movement, "Arrival"),
                                await self.extract_text(movement, "Departure"),
                                await self.extract_text(movement, "AutoArrival")
                                == "true",
                                await self.extract_text(movement, "AutoDepart")
                                == "true",
                                await self.extract_text(movement, "StopType"),
                            ),
                        )
                        count += 1
                    except Exception as e:
                        logger.debug(f"Movement parse error: {e}")

                await conn.commit()

            return count
        except Exception as e:
            logger.error(f"Train movements fetch failed for {train_code}: {e}")
            return 0

    # ========================================================================
    # SCHEDULERS
    # ========================================================================

    async def schedule_task(self, name: str, func, interval_seconds: int):
        """Repeatedly call a function at fixed intervals"""
        logger.info(f"Starting {name} every {interval_seconds}s")

        while True:
            try:
                await func()
            except Exception as e:
                logger.error(f"Task {name} error: {e}")

            await asyncio.sleep(interval_seconds)

    async def run(self):
        """Start the daemon: init stations, then spawn 4 background tasks"""
        await self.init()

        try:
            logger.info("Initializing stations...")
            await self.fetch_stations()

            tasks = [
                asyncio.create_task(self.schedule_task("trains", self.fetch_trains, 3)),
                asyncio.create_task(
                    self.schedule_task("boards", self.fetch_all_station_boards, 3)
                ),
                asyncio.create_task(
                    self.schedule_task("movements", self.fetch_all_train_movements, 60)
                ),
                asyncio.create_task(
                    self.schedule_task("stations", self.fetch_stations, 86400)
                ),
            ]

            logger.info("Daemon running. Press Ctrl+C to stop.")
            await asyncio.gather(*tasks)

        except KeyboardInterrupt:
            logger.info("Shutting down...")
            for task in tasks:
                task.cancel()
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
