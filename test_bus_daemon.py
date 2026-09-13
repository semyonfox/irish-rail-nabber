import asyncio
import io
import json
import unittest
import zipfile
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock, patch

from bus_daemon import (
    DEFAULT_AGENCY_ID,
    DEFAULT_REALTIME_RETENTION_DAYS,
    DEFAULT_TRIP_UPDATES_URL,
    ActiveBusIds,
    FeedFormatError,
    NtaBusDaemon,
    _iter_bus_shape_points,
    _iter_bus_stop_times,
    _parse_trip_updates_feed,
    _realtime_url_from_environment,
    _select_static_feed,
    filter_bus_realtime_feed,
    parse_gtfs_time,
    parse_realtime_feed,
    parse_trip_updates,
    parse_vehicle_positions,
)


class _AsyncContext:
    def __init__(self, value) -> None:
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, _exception_type, _exception, _traceback) -> None:
        return None


class _RecordingCursor:
    def __init__(self, calls: list[tuple[str, list[tuple[object, ...]]]]) -> None:
        self.calls = calls

    async def executemany(self, statement, rows) -> None:
        self.calls.append((statement, list(rows)))


class _ExecuteResult:
    def __init__(self, *, rowcount: int = 1, rows=None) -> None:
        self.rowcount = rowcount
        self.rows = list(rows or [])

    async def fetchone(self):
        return self.rows[0] if self.rows else None

    async def fetchall(self):
        return self.rows


class _RecordingConnection:
    def __init__(self, calls: list[tuple[str, list[tuple[object, ...]]]]) -> None:
        self.recording_cursor = _RecordingCursor(calls)
        self.execute_calls: list[tuple[str, tuple[object, ...]]] = []

    def transaction(self) -> _AsyncContext:
        return _AsyncContext(None)

    def cursor(self) -> _AsyncContext:
        return _AsyncContext(self.recording_cursor)

    async def execute(self, statement, parameters=()) -> _ExecuteResult:
        self.execute_calls.append((statement, tuple(parameters)))
        if "RETURNING last_fetched" in statement:
            return _ExecuteResult(rows=[(datetime.now(tz=timezone.utc),)])
        return _ExecuteResult()


class _RecordingPool:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[tuple[object, ...]]]] = []
        self.recording_connection = _RecordingConnection(self.calls)

    def connection(self) -> _AsyncContext:
        return _AsyncContext(self.recording_connection)

    @property
    def execute_calls(self):
        return self.recording_connection.execute_calls


class ParseGtfsTimeTests(unittest.TestCase):
    def test_times_after_midnight_keep_service_day_offset(self) -> None:
        self.assertEqual(parse_gtfs_time("25:12:30"), 90_750)
        self.assertEqual(parse_gtfs_time("24:00:00"), 86_400)

    def test_empty_times_are_null(self) -> None:
        self.assertIsNone(parse_gtfs_time(""))
        self.assertIsNone(parse_gtfs_time(None))

    def test_invalid_minutes_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            parse_gtfs_time("12:60:00")


class ParseTripUpdatesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.camel_payload = {
            "header": {"gtfsRealtimeVersion": "2.0", "timestamp": "1789286400"},
            "entity": [
                {
                    "id": "entity-1",
                    "tripUpdate": {
                        "trip": {
                            "tripId": "trip-1",
                            "routeId": "route-1",
                            "startDate": "20260913",
                            "startTime": "25:10:00",
                            "scheduleRelationship": "scheduled",
                        },
                        "vehicle": {"id": "vehicle-1"},
                        "timestamp": "1789286410",
                        "stopTimeUpdate": [
                            {
                                "stopSequence": 7,
                                "stopId": "stop-1",
                                "arrival": {"time": "1789286500", "delay": -15},
                                "departure": {"time": "1789286530", "delay": 15},
                                "scheduleRelationship": "scheduled",
                            }
                        ],
                    },
                }
            ],
        }

    def test_camel_case_payload_is_normalized(self) -> None:
        updates = parse_trip_updates(json.dumps(self.camel_payload))

        self.assertEqual(len(updates), 1)
        update = updates[0]
        self.assertEqual(update.entity_id, "entity-1")
        self.assertEqual(update.trip_id, "trip-1")
        self.assertEqual(update.route_id, "route-1")
        self.assertEqual(update.service_date, date(2026, 9, 13))
        self.assertEqual(update.vehicle_id, "vehicle-1")
        self.assertEqual(len(update.trip_instance_key), 64)
        self.assertEqual(update.stop_sequence, 7)
        self.assertEqual(update.schedule_relationship, "SCHEDULED")
        self.assertEqual(update.arrival_delay_seconds, -15)
        self.assertEqual(update.departure_delay_seconds, 15)
        self.assertEqual(
            update.arrival_time,
            datetime.fromtimestamp(1_789_286_500, tz=timezone.utc),
        )
        self.assertEqual(
            update.source_timestamp,
            datetime.fromtimestamp(1_789_286_410, tz=timezone.utc),
        )

    def test_snake_and_pascal_case_produce_the_same_state_hash(self) -> None:
        snake_payload = {
            "Header": {"Timestamp": "1789289999"},
            "Entity": {
                "ID": "entity-1",
                "Trip_Update": {
                    "Trip": {
                        "Trip_ID": "trip-1",
                        "Route_ID": "route-1",
                        "Start_Date": "2026-09-13",
                        "Start_Time": "25:10:00",
                        "Schedule_Relationship": "SCHEDULED",
                    },
                    "Vehicle": {"ID": "vehicle-1"},
                    "Timestamp": "1789289998",
                    "Stop_Time_Update": {
                        "Stop_Sequence": "7",
                        "Stop_ID": "stop-1",
                        "Arrival": {"Time": 1_789_286_500, "Delay": "-15"},
                        "Departure": {"Time": 1_789_286_530, "Delay": "15"},
                        "Schedule_Relationship": "SCHEDULED",
                    },
                },
            },
        }

        camel_update = parse_trip_updates(self.camel_payload)[0]
        snake_update = parse_trip_updates(snake_payload)[0]

        self.assertNotEqual(
            camel_update.source_timestamp, snake_update.source_timestamp
        )
        self.assertEqual(camel_update.trip_instance_key, snake_update.trip_instance_key)
        self.assertEqual(camel_update.update_hash, snake_update.update_hash)

        snake_payload["Entity"]["Trip_Update"]["Stop_Time_Update"]["Departure"][
            "Delay"
        ] = "16"
        changed_update = parse_trip_updates(snake_payload)[0]
        self.assertEqual(
            camel_update.trip_instance_key, changed_update.trip_instance_key
        )
        self.assertNotEqual(camel_update.update_hash, changed_update.update_hash)

        snake_payload["Entity"]["Trip_Update"]["Trip"]["Start_Time"] = "25:11:00"
        next_run_update = parse_trip_updates(snake_payload)[0]
        self.assertNotEqual(
            camel_update.trip_instance_key, next_run_update.trip_instance_key
        )

        del snake_payload["Entity"]["ID"]
        fallback_first = parse_trip_updates(snake_payload)[0]
        snake_payload["Entity"]["Trip_Update"]["Trip"]["Start_Time"] = "25:12:00"
        fallback_next = parse_trip_updates(snake_payload)[0]
        self.assertNotEqual(
            fallback_first.trip_instance_key, fallback_next.trip_instance_key
        )

    def test_missing_optional_fields_do_not_drop_a_stop_update(self) -> None:
        payload = {
            "entity": [
                {
                    "tripUpdate": {
                        "trip": {},
                        "stopTimeUpdate": [
                            {"stopSequence": "not-an-int", "arrival": {}}
                        ],
                    }
                },
                {"id": "deleted", "isDeleted": True, "tripUpdate": {}},
                {"id": "vehicle-only", "vehicle": {}},
            ]
        }

        updates = parse_trip_updates(payload)

        self.assertEqual(len(updates), 1)
        update = updates[0]
        self.assertIsNone(update.entity_id)
        self.assertIsNone(update.trip_id)
        self.assertIsNone(update.stop_id)
        self.assertIsNone(update.stop_sequence)
        self.assertIsNone(update.arrival_time)
        self.assertEqual(len(update.trip_instance_key), 64)
        self.assertEqual(len(update.update_hash), 64)

    def test_trip_without_stops_still_has_freshness(self) -> None:
        parsed = _parse_trip_updates_feed(
            {
                "header": {"incrementality": "FULL_DATASET", "timestamp": "1"},
                "entity": [
                    {
                        "id": "empty-trip",
                        "tripUpdate": {
                            "trip": {
                                "tripId": "trip-with-no-stops",
                                "scheduleRelationship": 3,
                            }
                        },
                    }
                ],
            }
        )

        self.assertEqual(parsed.stop_updates, ())
        self.assertEqual(len(parsed.trip_freshness), 1)
        self.assertEqual(parsed.trip_freshness[0].schedule_relationship, "CANCELED")
        self.assertEqual(parsed.incrementality, "FULL_DATASET")

    def test_cancellation_without_vehicle_reuses_the_trip_instance(self) -> None:
        scheduled = _parse_trip_updates_feed(
            {
                "entity": [
                    {
                        "id": "daily-entity",
                        "tripUpdate": {
                            "trip": {
                                "tripId": "trip",
                                "startDate": "20260913",
                                "startTime": "25:00:00",
                            },
                            "vehicle": {"id": "vehicle"},
                        },
                    }
                ]
            }
        )
        canceled = _parse_trip_updates_feed(
            {
                "entity": [
                    {
                        "id": "daily-entity",
                        "tripUpdate": {
                            "trip": {
                                "tripId": "trip",
                                "startDate": "20260913",
                                "startTime": "25:00:00",
                                "scheduleRelationship": "CANCELED",
                            }
                        },
                    }
                ]
            }
        )

        self.assertEqual(
            scheduled.trip_freshness[0].trip_instance_key,
            canceled.trip_freshness[0].trip_instance_key,
        )
        self.assertEqual(canceled.trip_freshness[0].schedule_relationship, "CANCELED")

    def test_differential_incrementality_is_exposed(self) -> None:
        parsed = _parse_trip_updates_feed(
            {"header": {"incrementality": "DIFFERENTIAL"}, "entity": []}
        )

        self.assertEqual(parsed.incrementality, "DIFFERENTIAL")

    def test_default_endpoint_requests_json(self) -> None:
        self.assertEqual(
            DEFAULT_TRIP_UPDATES_URL,
            "https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json",
        )

    def test_combined_url_setting_precedes_the_legacy_override(self) -> None:
        with patch.dict(
            "os.environ", {"NTA_TRIP_UPDATES_URL": "https://legacy.test"}, clear=True
        ):
            self.assertEqual(_realtime_url_from_environment(), "https://legacy.test")
        with patch.dict(
            "os.environ",
            {
                "NTA_GTFSR_URL": "https://combined.test",
                "NTA_TRIP_UPDATES_URL": "https://legacy.test",
            },
            clear=True,
        ):
            self.assertEqual(_realtime_url_from_environment(), "https://combined.test")

    def test_stop_identity_prefers_sequence_when_stop_id_appears_or_disappears(
        self,
    ) -> None:
        with_stop_id = parse_trip_updates(self.camel_payload)[0]
        without_stop_id_payload = json.loads(json.dumps(self.camel_payload))
        del without_stop_id_payload["entity"][0]["tripUpdate"]["stopTimeUpdate"][0][
            "stopId"
        ]
        without_stop_id = parse_trip_updates(without_stop_id_payload)[0]

        self.assertEqual(with_stop_id.state_key, without_stop_id.state_key)
        self.assertNotEqual(with_stop_id.update_hash, without_stop_id.update_hash)


class ParseVehiclePositionsTests(unittest.TestCase):
    def test_casing_and_numeric_enums_are_normalized(self) -> None:
        camel_payload = {
            "header": {"timestamp": "1789286400"},
            "entity": [
                {
                    "id": "vehicle-entity",
                    "vehicle": {
                        "trip": {
                            "tripId": "added-trip",
                            "routeId": "bus-route",
                            "startDate": "20260913",
                            "startTime": "25:10:00",
                            "scheduleRelationship": 1,
                        },
                        "vehicle": {
                            "id": "fleet-42",
                            "label": "Bus 42",
                            "licensePlate": "12-G-42",
                        },
                        "position": {
                            "latitude": "53.274",
                            "longitude": -9.049,
                            "bearing": "90",
                            "speed": 12.5,
                        },
                        "currentStopSequence": "4",
                        "stopId": "stop-4",
                        "currentStatus": 2,
                        "congestionLevel": 3,
                        "occupancyStatus": 5,
                        "occupancyPercentage": "80",
                        "timestamp": "1789286410",
                    },
                }
            ],
        }
        pascal_payload = {
            "Header": {"Timestamp": "1789289999"},
            "Entity": {
                "ID": "vehicle-entity",
                "Vehicle": {
                    "Trip": {
                        "Trip_ID": "added-trip",
                        "Route_ID": "bus-route",
                        "Start_Date": "2026-09-13",
                        "Start_Time": "25:10:00",
                        "Schedule_Relationship": "ADDED",
                    },
                    "Vehicle": {
                        "ID": "fleet-42",
                        "Label": "Bus 42",
                        "License_Plate": "12-G-42",
                    },
                    "Position": {
                        "Latitude": 53.274,
                        "Longitude": "-9.049",
                        "Bearing": 90,
                        "Speed": "12.5",
                    },
                    "Current_Stop_Sequence": 4,
                    "Stop_ID": "stop-4",
                    "Current_Status": "IN_TRANSIT_TO",
                    "Congestion_Level": "CONGESTION",
                    "Occupancy_Status": "FULL",
                    "Occupancy_Percentage": 80,
                    "Timestamp": "1789289998",
                },
            },
        }

        camel = parse_vehicle_positions(camel_payload)[0]
        pascal = parse_vehicle_positions(pascal_payload)[0]

        self.assertEqual(camel.vehicle_id, "fleet-42")
        self.assertEqual(camel.schedule_relationship, "ADDED")
        self.assertEqual(camel.current_status, "IN_TRANSIT_TO")
        self.assertEqual(camel.congestion_level, "CONGESTION")
        self.assertEqual(camel.occupancy_status, "FULL")
        self.assertEqual(camel.occupancy_percentage, 80)
        self.assertEqual((camel.latitude, camel.longitude), (53.274, -9.049))
        self.assertEqual(camel.vehicle_instance_key, pascal.vehicle_instance_key)
        self.assertEqual(camel.update_hash, pascal.update_hash)
        self.assertNotEqual(camel.source_timestamp, pascal.source_timestamp)

    def test_combined_message_parses_both_entity_types(self) -> None:
        parsed = parse_realtime_feed(
            {
                "header": {"incrementality": 0},
                "entity": [
                    {
                        "id": "trip-entity",
                        "tripUpdate": {
                            "trip": {"tripId": "trip"},
                            "stopTimeUpdate": {"stopSequence": 1},
                        },
                    },
                    {
                        "id": "vehicle-entity",
                        "vehicle": {
                            "trip": {"tripId": "trip"},
                            "vehicle": {"id": "vehicle"},
                            "position": {"latitude": 53, "longitude": -9},
                        },
                    },
                ],
            }
        )

        self.assertEqual(parsed.incrementality, "FULL_DATASET")
        self.assertEqual(len(parsed.stop_updates), 1)
        self.assertEqual(len(parsed.trip_freshness), 1)
        self.assertEqual(len(parsed.vehicle_positions), 1)


class BusRealtimeFilterTests(unittest.TestCase):
    def test_static_bus_trips_and_added_bus_routes_are_kept(self) -> None:
        entities = []
        cases = (
            ("static-bus", "bus-trip", "wrong-route", "SCHEDULED"),
            ("static-rail", "rail-trip", "rail-route", "SCHEDULED"),
            ("added-bus", "added-trip", "bus-route", "ADDED"),
            ("canceled-added-bus", "added-trip", "bus-route", "CANCELED"),
            ("unknown-scheduled", "unknown-trip", "bus-route", "SCHEDULED"),
        )
        for prefix, trip_id, route_id, relationship in cases:
            descriptor = {
                "tripId": trip_id,
                "routeId": route_id,
                "scheduleRelationship": relationship,
            }
            entities.extend(
                (
                    {
                        "id": f"{prefix}-trip",
                        "tripUpdate": {
                            "trip": descriptor,
                            "stopTimeUpdate": {"stopSequence": 1},
                        },
                    },
                    {
                        "id": f"{prefix}-vehicle",
                        "vehicle": {
                            "trip": descriptor,
                            "vehicle": {"id": f"{prefix}-vehicle-id"},
                        },
                    },
                )
            )

        feed = parse_realtime_feed({"entity": entities})
        filtered = filter_bus_realtime_feed(
            feed,
            ActiveBusIds(
                feed_version_id=7,
                route_ids=frozenset({"bus-route"}),
                trip_routes={"bus-trip": "bus-route"},
            ),
        )

        self.assertEqual(
            {trip.trip_id for trip in filtered.trip_freshness},
            {"bus-trip", "added-trip"},
        )
        self.assertEqual(len(filtered.trip_freshness), 3)
        self.assertEqual(
            {update.trip_id for update in filtered.stop_updates},
            {"bus-trip", "added-trip"},
        )
        self.assertEqual(len(filtered.stop_updates), 3)
        self.assertEqual(
            {position.trip_id for position in filtered.vehicle_positions},
            {"bus-trip", "added-trip"},
        )
        self.assertEqual(len(filtered.vehicle_positions), 3)
        self.assertEqual(
            {item.route_id for item in filtered.trip_freshness}, {"bus-route"}
        )

        alternate_entities = json.loads(json.dumps(entities))
        for entity in alternate_entities:
            if not entity["id"].startswith("static-bus"):
                continue
            if "tripUpdate" in entity:
                entity["tripUpdate"]["trip"]["routeId"] = "another-wrong-route"
            else:
                entity["vehicle"]["trip"]["routeId"] = "another-wrong-route"
        alternate = filter_bus_realtime_feed(
            parse_realtime_feed({"entity": alternate_entities}),
            ActiveBusIds(7, frozenset({"bus-route"}), {"bus-trip": "bus-route"}),
        )
        first_stop_hash = next(
            update.update_hash
            for update in filtered.stop_updates
            if update.entity_id == "static-bus-trip"
        )
        alternate_stop_hash = next(
            update.update_hash
            for update in alternate.stop_updates
            if update.entity_id == "static-bus-trip"
        )
        first_vehicle_hash = next(
            position.update_hash
            for position in filtered.vehicle_positions
            if position.entity_id == "static-bus-vehicle"
        )
        alternate_vehicle_hash = next(
            position.update_hash
            for position in alternate.vehicle_positions
            if position.entity_id == "static-bus-vehicle"
        )
        self.assertEqual(first_stop_hash, alternate_stop_hash)
        self.assertEqual(first_vehicle_hash, alternate_vehicle_hash)


class StopUpdatePersistenceTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _feed(delay: int):
        return _parse_trip_updates_feed(
            {
                "header": {"incrementality": "FULL_DATASET", "timestamp": "10"},
                "entity": [
                    {
                        "id": "entity",
                        "tripUpdate": {
                            "trip": {
                                "tripId": "trip",
                                "routeId": "route",
                                "startDate": "20260913",
                                "startTime": "25:00:00",
                            },
                            "timestamp": "9",
                            "stopTimeUpdate": [
                                {
                                    "stopId": "stop",
                                    "stopSequence": 1,
                                    "arrival": {"time": "20", "delay": delay},
                                }
                            ],
                        },
                    }
                ],
            }
        )

    async def test_unchanged_polls_only_refresh_trip_and_a_b_a_reactivates_a(
        self,
    ) -> None:
        daemon = NtaBusDaemon("unused")
        pool = _RecordingPool()
        daemon.pool = pool
        fetched_at = datetime(2026, 9, 13, tzinfo=timezone.utc)
        feed_a = self._feed(10)
        feed_b = self._feed(20)

        first_count = await daemon._insert_trip_updates(
            1, feed_a.stop_updates, feed_a.trip_freshness, fetched_at
        )
        unchanged_count = await daemon._insert_trip_updates(
            1, feed_a.stop_updates, feed_a.trip_freshness, fetched_at
        )
        changed_count = await daemon._insert_trip_updates(
            1, feed_b.stop_updates, feed_b.trip_freshness, fetched_at
        )
        returned_count = await daemon._insert_trip_updates(
            1, feed_a.stop_updates, feed_a.trip_freshness, fetched_at
        )

        self.assertEqual(
            (first_count, unchanged_count, changed_count, returned_count),
            (1, 0, 1, 1),
        )
        state_calls = [call for call in pool.calls if "bus_stop_updates" in call[0]]
        freshness_calls = [
            call for call in pool.calls if "bus_trip_update_freshness" in call[0]
        ]
        self.assertEqual(len(state_calls), 3)
        self.assertEqual(len(freshness_calls), 4)
        self.assertIn("last_seen_at = EXCLUDED.last_seen_at", state_calls[0][0])
        self.assertEqual(len(state_calls[0][1][0]), 18)
        self.assertEqual(len(freshness_calls[0][1][0]), 5)
        self.assertEqual(len(daemon._previous_update_hashes), 1)


class VehiclePositionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def _position(latitude: float):
        return parse_vehicle_positions(
            {
                "entity": {
                    "id": "vehicle-entity",
                    "vehicle": {
                        "trip": {"tripId": "trip", "routeId": "route"},
                        "vehicle": {"id": "vehicle"},
                        "position": {"latitude": latitude, "longitude": -9},
                    },
                }
            }
        )

    async def test_unchanged_refreshes_and_a_b_a_updates_current_row(self) -> None:
        daemon = NtaBusDaemon("unused")
        pool = _RecordingPool()
        daemon.pool = pool
        fetched_at = datetime(2026, 9, 13, tzinfo=timezone.utc)
        position_a = self._position(53.0)
        position_b = self._position(53.1)

        counts = (
            await daemon._upsert_vehicle_positions(1, position_a, fetched_at),
            await daemon._upsert_vehicle_positions(1, position_a, fetched_at),
            await daemon._upsert_vehicle_positions(1, position_b, fetched_at),
            await daemon._upsert_vehicle_positions(1, position_a, fetched_at),
        )

        self.assertEqual(counts, (1, 0, 1, 1))
        self.assertEqual(len(pool.calls), 4)
        self.assertTrue(all(len(call[1][0]) == 25 for call in pool.calls))
        self.assertIn("last_seen_at = EXCLUDED.last_seen_at", pool.calls[0][0])
        self.assertIn("IS DISTINCT FROM", pool.calls[0][0])
        self.assertEqual(len(daemon._previous_vehicle_hashes), 1)
        snapshot_deletes = [
            statement
            for statement, _parameters in pool.execute_calls
            if "DELETE FROM bus_vehicle_positions" in statement
        ]
        self.assertEqual(len(snapshot_deletes), 4)


class DatabaseRetentionTests(unittest.IsolatedAsyncioTestCase):
    async def test_static_prune_excludes_the_newly_active_version(self) -> None:
        daemon = NtaBusDaemon("unused")
        pool = _RecordingPool()

        pruned = await daemon._activate_version_and_prune_stop_times(
            pool.recording_connection, 42
        )

        self.assertEqual(pruned, 1)
        delete_statement, parameters = pool.execute_calls[-1]
        self.assertIn("DELETE FROM bus_stop_times", delete_statement)
        self.assertIn("id <> %s", delete_statement)
        self.assertEqual(parameters, ("nta_gtfs", 42))
        self.assertTrue(
            any(
                "DELETE FROM bus_shape_points" in statement
                for statement, _parameters in pool.execute_calls
            )
        )
        self.assertTrue(
            any(
                "SET shapes_imported = FALSE" in statement
                for statement, _parameters in pool.execute_calls
            )
        )

    async def test_realtime_retention_is_reserved_and_protects_current_trips(
        self,
    ) -> None:
        daemon = NtaBusDaemon("unused")
        pool = _RecordingPool()
        daemon.pool = pool

        pruned = await daemon._prune_realtime_history_if_due()

        self.assertEqual(pruned, (1, 1, 1))
        reservation_statement, reservation_parameters = pool.execute_calls[0]
        self.assertIn("ON CONFLICT (endpoint)", reservation_statement)
        self.assertEqual(reservation_parameters[0], "nta_realtime_retention")
        stop_statement, stop_parameters = pool.execute_calls[1]
        self.assertIn("NOT EXISTS", stop_statement)
        self.assertIn("DISTINCT ON", stop_statement)
        self.assertIn("protected_current_states", stop_statement)
        self.assertIn("bus_trip_update_freshness", stop_statement)
        self.assertEqual(
            stop_parameters,
            (DEFAULT_REALTIME_RETENTION_DAYS, DEFAULT_REALTIME_RETENTION_DAYS),
        )
        self.assertIn("bus_vehicle_positions", pool.execute_calls[3][0])

    async def test_active_bus_ids_are_cached_per_feed_version(self) -> None:
        daemon = NtaBusDaemon("unused")
        connection = AsyncMock()
        connection.execute = AsyncMock(
            side_effect=[
                _ExecuteResult(rows=[("route",)]),
                _ExecuteResult(rows=[("trip", "route")]),
            ]
        )
        daemon.pool = AsyncMock()
        daemon.pool.connection = lambda: _AsyncContext(connection)

        first = await daemon._load_active_bus_ids(7)
        second = await daemon._load_active_bus_ids(7)

        self.assertIs(first, second)
        self.assertEqual(first.route_ids, frozenset({"route"}))
        self.assertEqual(first.trip_routes, {"trip": "route"})
        self.assertEqual(connection.execute.await_count, 2)

    async def test_pruned_historical_hash_rehydrates_stop_times_before_activation(
        self,
    ) -> None:
        files = {
            "agency.txt": "agency_id,agency_name\na,Agency\n",
            "routes.txt": "route_id,agency_id,route_type\nr,a,3\n",
            "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
            "stops.txt": "stop_id,stop_name\nstop,Stop\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:01:00,stop,1\n"
            ),
        }
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        archive_bytes.seek(0)

        class _RehydrateConnection(_RecordingConnection):
            async def execute(self, statement, parameters=()):
                self.execute_calls.append((statement, tuple(parameters)))
                if "content_sha256" in statement and "SELECT id" in statement:
                    return _ExecuteResult(
                        rows=[
                            (
                                42,
                                datetime(2026, 9, 1, tzinfo=timezone.utc),
                                False,
                                True,
                            )
                        ]
                    )
                return _ExecuteResult()

        pool = _RecordingPool()
        pool.recording_connection = _RehydrateConnection(pool.calls)
        daemon = NtaBusDaemon("unused")
        daemon.pool = pool
        copied_rows = []

        async def strict_copy(_connection, table, columns, rows):
            copied_rows.extend(rows)
            self.assertEqual(table, "bus_stop_times")
            self.assertEqual(len(columns), 6)
            return len(copied_rows)

        with patch("bus_daemon._copy_rows", side_effect=strict_copy):
            result = await daemon._import_static_feed(
                archive_bytes,
                "old-content-hash",
                datetime(2026, 9, 13, tzinfo=timezone.utc),
            )

        self.assertTrue(result.imported)
        self.assertEqual(result.feed_version_id, 42)
        self.assertEqual(result.stop_times, 1)
        self.assertEqual(copied_rows, [(42, "t", 1, "stop", 43_200, 43_260)])
        delete_statements = [
            statement
            for statement, _parameters in pool.execute_calls
            if "DELETE FROM bus_stop_times" in statement
        ]
        self.assertEqual(len(delete_statements), 2)

    async def test_existing_active_hash_backfills_shapes_after_migration(self) -> None:
        files = {
            "agency.txt": "agency_id,agency_name\na,Agency\n",
            "routes.txt": "route_id,agency_id,route_type\nr,a,3\n",
            "trips.txt": (
                "route_id,service_id,trip_id,shape_id\n"
                "r,s,t,bus-shape\n"
            ),
            "stops.txt": "stop_id,stop_name\nstop,Stop\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:01:00,stop,1\n"
            ),
            "shapes.txt": (
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                "bus-shape,53,-9,0\n"
                "bus-shape,53.1,-8.9,1\n"
            ),
        }
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        archive_bytes.seek(0)

        class _ShapeBackfillConnection(_RecordingConnection):
            async def execute(self, statement, parameters=()):
                self.execute_calls.append((statement, tuple(parameters)))
                if "content_sha256" in statement and "SELECT id" in statement:
                    return _ExecuteResult(
                        rows=[
                            (
                                42,
                                datetime(2026, 9, 1, tzinfo=timezone.utc),
                                True,
                                False,
                            )
                        ]
                    )
                return _ExecuteResult()

        pool = _RecordingPool()
        pool.recording_connection = _ShapeBackfillConnection(pool.calls)
        daemon = NtaBusDaemon("unused")
        daemon.pool = pool
        copied_rows = []

        async def strict_copy(_connection, table, columns, rows):
            copied_rows.extend(rows)
            self.assertEqual(table, "bus_shape_points")
            self.assertEqual(len(columns), 6)
            return len(copied_rows)

        with patch("bus_daemon._copy_rows", side_effect=strict_copy):
            result = await daemon._import_static_feed(
                archive_bytes,
                "current-content-hash",
                datetime(2026, 9, 13, tzinfo=timezone.utc),
            )

        self.assertTrue(result.imported)
        self.assertEqual(result.feed_version_id, 42)
        self.assertEqual(result.stop_times, 0)
        self.assertEqual(result.shape_points, 2)
        self.assertEqual(
            copied_rows,
            [
                (42, "bus-shape", 0, 53.0, -9.0, None),
                (42, "bus-shape", 1, 53.1, -8.9, None),
            ],
        )
        self.assertTrue(
            any(
                "SET shapes_imported = TRUE" in statement
                for statement, _parameters in pool.execute_calls
            )
        )


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_cancels_an_active_initial_import_before_close(self) -> None:
        daemon = NtaBusDaemon("unused")
        daemon.init = AsyncMock()
        daemon.close = AsyncMock()
        daemon._install_signal_handlers = lambda: None
        import_started = asyncio.Event()
        import_cancelled = asyncio.Event()

        async def blocked_import() -> None:
            import_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                import_cancelled.set()

        daemon.refresh_static_feed = blocked_import
        run_task = asyncio.create_task(daemon.run())
        await import_started.wait()

        daemon._shutdown.set()
        await asyncio.wait_for(run_task, timeout=1)

        self.assertTrue(import_cancelled.is_set())
        daemon.close.assert_awaited_once()


class StaticFeedSelectionTests(unittest.TestCase):
    def test_only_bus_rows_and_their_parent_stops_are_selected(self) -> None:
        files = {
            "agency.txt": (
                "agency_id,agency_name,agency_url,agency_timezone\n"
                "bus-agency,Bus Co,https://bus.test,Europe/Dublin\n"
                "rail-agency,Rail Co,https://rail.test,Europe/Dublin\n"
            ),
            "routes.txt": (
                "route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n"
                "bus-route,bus-agency,10,Town,3,112233,FFFFFF\n"
                "rail-route,rail-agency,R1,Rail,2,,\n"
            ),
            "trips.txt": (
                "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n"
                "bus-route,weekday,bus-trip,Town,1,bus-shape\n"
                "rail-route,weekday,rail-trip,City,0,rail-shape\n"
            ),
            "stops.txt": (
                "stop_id,stop_code,stop_name,stop_lat,stop_lon,parent_station\n"
                "bus-stop,100,Bus stop,53.0,-9.0,bus-parent\n"
                "bus-parent,,Bus station,53.0,-9.0,\n"
                "rail-stop,200,Rail stop,54.0,-8.0,\n"
            ),
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "bus-trip,24:10:00,24:11:00,bus-stop,1\n"
                "rail-trip,12:00:00,12:01:00,rail-stop,1\n"
            ),
            "shapes.txt": (
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\n"
                "bus-shape,53.0,-9.0,0,0\n"
                "bus-shape,53.1,-8.9,4,12.5\n"
                "rail-shape,54.0,-8.0,0,0\n"
            ),
        }
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as archive:
            selection = _select_static_feed(archive)
            stop_times = list(_iter_bus_stop_times(archive, selection.trip_ids))
            shape_points = list(
                _iter_bus_shape_points(archive, selection.shape_ids)
            )

        self.assertEqual({row[0] for row in selection.agencies}, {"bus-agency"})
        self.assertEqual({row[0] for row in selection.routes}, {"bus-route"})
        self.assertEqual(
            {row[0] for row in selection.stops}, {"bus-stop", "bus-parent"}
        )
        self.assertEqual({row[0] for row in selection.trips}, {"bus-trip"})
        self.assertEqual(selection.shape_ids, frozenset({"bus-shape"}))
        self.assertEqual(selection.shape_point_count, 2)
        self.assertEqual(
            stop_times,
            [("bus-trip", 1, "bus-stop", 87_000, 87_060)],
        )
        self.assertEqual(
            shape_points,
            [
                ("bus-shape", 0, 53.0, -9.0, 0.0),
                ("bus-shape", 4, 53.1, -8.9, 12.5),
            ],
        )

    def test_missing_referenced_shape_rejects_the_feed(self) -> None:
        files = {
            "agency.txt": "agency_id,agency_name\na,Agency\n",
            "routes.txt": "route_id,agency_id,route_type\nr,a,3\n",
            "trips.txt": (
                "route_id,service_id,trip_id,shape_id\n"
                "r,s,t,missing-shape\n"
            ),
            "stops.txt": "stop_id,stop_name\nstop,Stop\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:01:00,stop,1\n"
            ),
            "shapes.txt": (
                "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n"
                "another-shape,53,-9,0\n"
            ),
        }
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as archive:
            with self.assertRaisesRegex(
                FeedFormatError, "reference missing shapes: missing-shape"
            ):
                _select_static_feed(archive)

    def test_shapes_file_is_optional_when_bus_trips_have_no_shape(self) -> None:
        files = {
            "agency.txt": "agency_id,agency_name\na,Agency\n",
            "routes.txt": "route_id,agency_id,route_type\nr,a,3\n",
            "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
            "stops.txt": "stop_id,stop_name\nstop,Stop\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:01:00,stop,1\n"
            ),
        }
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as archive:
            selection = _select_static_feed(archive)

        self.assertEqual(selection.shape_ids, frozenset())
        self.assertEqual(selection.shape_point_count, 0)

    def test_missing_stop_dependency_rejects_the_feed(self) -> None:
        files = {
            "agency.txt": "agency_id,agency_name\na,Agency\n",
            "routes.txt": "route_id,agency_id,route_type\nr,a,3\n",
            "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
            "stops.txt": "stop_id,stop_name\nother,Other\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:00:00,missing,1\n"
            ),
        }
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as archive:
            with self.assertRaises(FeedFormatError):
                _select_static_feed(archive)

    def test_single_agency_id_may_be_omitted(self) -> None:
        files = {
            "agency.txt": "agency_name\nOnly Agency\n",
            "routes.txt": "route_id,route_type\nr,3\n",
            "trips.txt": "route_id,service_id,trip_id\nr,s,t\n",
            "stops.txt": "stop_id,stop_name\nstop,Stop\n",
            "stop_times.txt": (
                "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
                "t,12:00:00,12:01:00,stop,1\n"
            ),
        }
        zip_bytes = io.BytesIO()
        with zipfile.ZipFile(zip_bytes, "w") as archive:
            for filename, contents in files.items():
                archive.writestr(filename, contents)
        zip_bytes.seek(0)

        with zipfile.ZipFile(zip_bytes) as archive:
            selection = _select_static_feed(archive)

        self.assertEqual(selection.agencies[0][0], DEFAULT_AGENCY_ID)
        self.assertEqual(selection.routes[0][1], DEFAULT_AGENCY_ID)


if __name__ == "__main__":
    unittest.main()
