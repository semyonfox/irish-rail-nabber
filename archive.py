#!/usr/bin/env python3
"""Irish Rail API scraper - fetches and archives real-time rail data to SQLite."""

import requests
import sqlite3
import xml.etree.ElementTree as ET
import time
from typing import Optional, Dict

BASE_URL = "http://api.irishrail.ie/realtime/realtime.asmx"


class IrishRailArchive:
    def __init__(self, db_path: str = "irish_rail.db"):
        self.db_path = db_path
        self.session = requests.Session()
        self.conn = None
        self.cursor = None
        self.init_db()

    def init_db(self):
        self.conn = sqlite3.connect(self.db_path)
        self.cursor = self.conn.cursor()
        self.cursor.execute("PRAGMA foreign_keys = ON")

        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS stations (
                id INTEGER PRIMARY KEY,
                station_id TEXT UNIQUE,
                station_code TEXT UNIQUE NOT NULL,
                station_desc TEXT NOT NULL,
                station_alias TEXT,
                latitude REAL,
                longitude REAL,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS current_trains (
                id INTEGER PRIMARY KEY,
                train_code TEXT NOT NULL,
                train_status TEXT,
                train_latitude REAL,
                train_longitude REAL,
                train_date TEXT,
                public_message TEXT,
                direction TEXT,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS station_boards (
                id INTEGER PRIMARY KEY,
                servertime TIMESTAMP,
                querytime TIME,
                train_code TEXT NOT NULL,
                station_fullname TEXT NOT NULL,
                station_code TEXT NOT NULL,
                train_date TEXT,
                origin TEXT,
                destination TEXT,
                origin_time TIME,
                destination_time TIME,
                status TEXT,
                last_location TEXT,
                due_in INTEGER,
                late INTEGER,
                exp_arrival TIME,
                exp_depart TIME,
                sch_arrival TIME,
                sch_depart TIME,
                direction TEXT,
                train_type TEXT,
                location_type TEXT,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS train_movements (
                id INTEGER PRIMARY KEY,
                train_code TEXT NOT NULL,
                train_date TEXT,
                location_code TEXT,
                location_full_name TEXT,
                location_order INTEGER,
                location_type TEXT,
                train_origin TEXT,
                train_destination TEXT,
                scheduled_arrival TIME,
                scheduled_departure TIME,
                actual_arrival TIME,
                actual_departure TIME,
                auto_arrival BOOLEAN,
                auto_depart BOOLEAN,
                stop_type TEXT,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        self.cursor.execute("""
            CREATE TABLE IF NOT EXISTS fetch_log (
                id INTEGER PRIMARY KEY,
                endpoint TEXT NOT NULL,
                item_count INTEGER,
                fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status TEXT
            )
        """)

        self.conn.commit()

    def fetch_endpoint(
        self, method: str, params: Optional[Dict[str, str]] = None
    ) -> Optional[ET.Element]:
        url = f"{BASE_URL}/{method}"
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            xml_content = response.text.replace("xmlns=", "xmlnamespace=")
            root = ET.fromstring(xml_content)
            return root
        except Exception as e:
            print(f"Error fetching {method}: {e}")
            return None

    def extract_text(self, element: Optional[ET.Element], default: str = "") -> str:
        if element is None:
            return default
        return (element.text or "").strip()

    def fetch_and_store_stations(self):
        print("Fetching stations...", end=" ", flush=True)
        root = self.fetch_endpoint("getAllStationsXML")

        if root is None:
            return

        count = 0
        for station in root:
            try:
                station_id = self.extract_text(station.find("StationId"))
                station_code = self.extract_text(station.find("StationCode"))
                station_desc = self.extract_text(station.find("StationDesc"))
                station_alias = self.extract_text(station.find("StationAlias"))
                latitude = self.extract_text(station.find("StationLatitude"))
                longitude = self.extract_text(station.find("StationLongitude"))

                lat = float(latitude) if latitude else None
                lon = float(longitude) if longitude else None
                alias = station_alias if station_alias else None

                self.cursor.execute(
                    """
                    INSERT OR REPLACE INTO stations 
                    (station_id, station_code, station_desc, station_alias, latitude, longitude)
                    VALUES (?, ?, ?, ?, ?, ?)
                """,
                    (station_id, station_code, station_desc, alias, lat, lon),
                )

                count += 1
            except Exception as e:
                print(f"Error: {e}")

        self.conn.commit()
        self.cursor.execute(
            """
            INSERT INTO fetch_log (endpoint, item_count, status)
            VALUES (?, ?, ?)
        """,
            ("getAllStationsXML", count, "success"),
        )
        self.conn.commit()
        print(f"{count} stations")
        time.sleep(1)

    def fetch_and_store_current_trains(self):
        print("Fetching live trains...", end=" ", flush=True)
        root = self.fetch_endpoint("getCurrentTrainsXML")

        if root is None:
            return

        count = 0
        for train in root:
            try:
                train_code = self.extract_text(train.find("TrainCode"))
                train_status = self.extract_text(train.find("TrainStatus"))
                train_latitude = self.extract_text(train.find("TrainLatitude"))
                train_longitude = self.extract_text(train.find("TrainLongitude"))
                train_date = self.extract_text(train.find("TrainDate"))
                public_message = self.extract_text(train.find("PublicMessage"))
                direction = self.extract_text(train.find("Direction"))

                lat = float(train_latitude) if train_latitude else None
                lon = float(train_longitude) if train_longitude else None

                self.cursor.execute(
                    """
                    INSERT INTO current_trains
                    (train_code, train_status, train_latitude, train_longitude, train_date, public_message, direction)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        train_code,
                        train_status,
                        lat,
                        lon,
                        train_date,
                        public_message,
                        direction,
                    ),
                )

                count += 1
            except Exception as e:
                print(f"Error: {e}")

        self.conn.commit()
        self.cursor.execute(
            """
            INSERT INTO fetch_log (endpoint, item_count, status)
            VALUES (?, ?, ?)
        """,
            ("getCurrentTrainsXML", count, "success"),
        )
        self.conn.commit()
        print(f"{count} trains")
        time.sleep(1)

    def fetch_and_store_station_board(self, station_code: str) -> int:
        root = self.fetch_endpoint(
            "getStationDataByCodeXML", {"StationCode": station_code}
        )

        if root is None:
            return 0

        count = 0
        for train in root:
            try:
                servertime = self.extract_text(train.find("Servertime"))
                querytime = self.extract_text(train.find("Querytime"))
                train_code = self.extract_text(train.find("Traincode"))
                station_fullname = self.extract_text(train.find("Stationfullname"))
                stationcode = self.extract_text(train.find("Stationcode"))
                train_date = self.extract_text(train.find("Traindate"))
                origin = self.extract_text(train.find("Origin"))
                destination = self.extract_text(train.find("Destination"))
                origin_time = self.extract_text(train.find("Origintime"))
                destination_time = self.extract_text(train.find("Destinationtime"))
                status = self.extract_text(train.find("Status"))
                last_location = self.extract_text(train.find("Lastlocation"))
                due_in = self.extract_text(train.find("Duein"))
                late = self.extract_text(train.find("Late"))
                exp_arrival = self.extract_text(train.find("Exparrival"))
                exp_depart = self.extract_text(train.find("Expdepart"))
                sch_arrival = self.extract_text(train.find("Scharrival"))
                sch_depart = self.extract_text(train.find("Schdepart"))
                direction = self.extract_text(train.find("Direction"))
                train_type = self.extract_text(train.find("Traintype"))
                location_type = self.extract_text(train.find("Locationtype"))

                due_in_int = int(due_in) if due_in and due_in.isdigit() else None
                late_int = int(late) if late and late.isdigit() else None

                self.cursor.execute(
                    """
                    INSERT INTO station_boards
                    (servertime, querytime, train_code, station_fullname, station_code, train_date,
                     origin, destination, origin_time, destination_time, status, last_location,
                     due_in, late, exp_arrival, exp_depart, sch_arrival, sch_depart,
                     direction, train_type, location_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        servertime,
                        querytime,
                        train_code,
                        station_fullname,
                        stationcode,
                        train_date,
                        origin,
                        destination,
                        origin_time,
                        destination_time,
                        status,
                        last_location,
                        due_in_int,
                        late_int,
                        exp_arrival,
                        exp_depart,
                        sch_arrival,
                        sch_depart,
                        direction,
                        train_type,
                        location_type,
                    ),
                )

                count += 1
            except Exception:
                pass

        return count

    def fetch_all_station_boards(self):
        print("Fetching station boards...", end=" ", flush=True)

        self.cursor.execute("SELECT station_code FROM stations")
        stations = [row[0] for row in self.cursor.fetchall()]

        total_count = 0
        for code in stations:
            count = self.fetch_and_store_station_board(code)
            total_count += count

        self.conn.commit()
        self.cursor.execute(
            """
            INSERT INTO fetch_log (endpoint, item_count, status)
            VALUES (?, ?, ?)
        """,
            ("getStationDataByCodeXML (all)", total_count, "success"),
        )
        self.conn.commit()
        print(f"{total_count} board entries")

    def fetch_train_movements(self, train_code: str, train_date: str) -> int:
        params = {"TrainId": train_code, "TrainDate": train_date}
        root = self.fetch_endpoint("getTrainMovementsXML", params)

        if root is None or len(root) == 0:
            return 0

        count = 0
        for movement in root:
            try:
                train_code_elem = self.extract_text(movement.find("TrainCode"))
                train_date_elem = self.extract_text(movement.find("TrainDate"))
                location_code = self.extract_text(movement.find("LocationCode"))
                location_full_name = self.extract_text(
                    movement.find("LocationFullName")
                )
                location_order = self.extract_text(movement.find("LocationOrder"))
                location_type = self.extract_text(movement.find("LocationType"))
                train_origin = self.extract_text(movement.find("TrainOrigin"))
                train_destination = self.extract_text(movement.find("TrainDestination"))
                scheduled_arrival = self.extract_text(movement.find("ScheduledArrival"))
                scheduled_departure = self.extract_text(
                    movement.find("ScheduledDeparture")
                )
                actual_arrival = self.extract_text(movement.find("Arrival"))
                actual_departure = self.extract_text(movement.find("Departure"))
                auto_arrival = self.extract_text(movement.find("AutoArrival"))
                auto_depart = self.extract_text(movement.find("AutoDepart"))
                stop_type = self.extract_text(movement.find("StopType"))

                location_order_int = (
                    int(location_order)
                    if location_order and location_order.isdigit()
                    else None
                )
                auto_arr_bool = auto_arrival.lower() == "true" if auto_arrival else None
                auto_dep_bool = auto_depart.lower() == "true" if auto_depart else None

                self.cursor.execute(
                    """
                    INSERT INTO train_movements
                    (train_code, train_date, location_code, location_full_name, location_order,
                     location_type, train_origin, train_destination, scheduled_arrival, scheduled_departure,
                     actual_arrival, actual_departure, auto_arrival, auto_depart, stop_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                    (
                        train_code_elem,
                        train_date_elem,
                        location_code,
                        location_full_name,
                        location_order_int,
                        location_type,
                        train_origin,
                        train_destination,
                        scheduled_arrival,
                        scheduled_departure,
                        actual_arrival,
                        actual_departure,
                        auto_arr_bool,
                        auto_dep_bool,
                        stop_type,
                    ),
                )

                count += 1
            except Exception:
                pass

        return count

    def fetch_sample_train_movements(self):
        print("Fetching train movements...", end=" ", flush=True)

        self.cursor.execute("""
            SELECT DISTINCT train_code, train_date 
            FROM current_trains 
            LIMIT 10
        """)
        trains = self.cursor.fetchall()

        total_count = 0
        for train_code, train_date in trains:
            count = self.fetch_train_movements(train_code, train_date)
            total_count += count
            time.sleep(0.5)

        self.conn.commit()
        self.cursor.execute(
            """
            INSERT INTO fetch_log (endpoint, item_count, status)
            VALUES (?, ?, ?)
        """,
            ("getTrainMovementsXML (sample)", total_count, "success"),
        )
        self.conn.commit()
        print(f"{total_count} movements")

    def run(self):
        print("\n" + "=" * 70)
        print("IRISH RAIL ARCHIVE")
        print("=" * 70 + "\n")

        self.fetch_and_store_stations()
        self.fetch_and_store_current_trains()
        self.fetch_all_station_boards()
        self.fetch_sample_train_movements()

        self.print_stats()

    def print_stats(self):
        print("\n" + "=" * 70)
        print("DATABASE")
        print("=" * 70)

        self.cursor.execute("SELECT COUNT(*) FROM stations")
        stations = self.cursor.fetchone()[0]

        self.cursor.execute("SELECT COUNT(*) FROM current_trains")
        trains = self.cursor.fetchone()[0]

        self.cursor.execute("SELECT COUNT(*) FROM station_boards")
        boards = self.cursor.fetchone()[0]

        self.cursor.execute("SELECT COUNT(*) FROM train_movements")
        movements = self.cursor.fetchone()[0]

        print(f"Stations: {stations}")
        print(f"Current trains: {trains}")
        print(f"Station boards: {boards}")
        print(f"Train movements: {movements}")
        print(f"File: {self.db_path}")
        print("=" * 70)

    def close(self):
        if self.conn:
            self.conn.close()


if __name__ == "__main__":
    archive = IrishRailArchive()
    try:
        archive.run()
    finally:
        archive.close()
        print("Done")
