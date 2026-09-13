#!/usr/bin/env python3
"""Collect NTA static GTFS and GTFS-Realtime bus updates.

The static feed is the identity boundary for realtime data. NTA may change
route, trip, and stop IDs whenever it publishes a new feed, so every imported
row and every realtime observation carries the matching feed version ID.

Runtime configuration:

* DATABASE_URL: PostgreSQL connection string (required)
* NTA_API_KEY: key sent only in the ``x-api-key`` request header (optional)
* NTA_GTFS_URL: static GTFS ZIP URL
* NTA_GTFSR_URL: combined GTFS-Realtime FeedMessage JSON URL
* NTA_TRIP_UPDATES_URL: legacy override for the realtime URL
* BUS_STATIC_REFRESH_SECONDS: static refresh period, default 86400
* BUS_REALTIME_INTERVAL_SECONDS: realtime period, clamped to at least 60
* BUS_REALTIME_RETENTION_DAYS: stop-update history retained, default 7
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import logging
import math
import os
import signal
import tempfile
import time
import zipfile
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timezone
from types import FrameType
from typing import Any, BinaryIO, cast

try:
    import aiohttp
except ModuleNotFoundError:  # Pure parser tests do not need runtime packages.
    aiohttp = None  # type: ignore[assignment]

try:
    from psycopg_pool import AsyncConnectionPool
except ModuleNotFoundError:  # Pure parser tests do not need runtime packages.
    AsyncConnectionPool = None  # type: ignore[assignment,misc]


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

DEFAULT_GTFS_URL = (
    "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip"
)
DEFAULT_REALTIME_URL = "https://api.nationaltransport.ie/gtfsr/v2/gtfsr?format=json"
# Kept for imports and deployments which still use the old variable name.
DEFAULT_TRIP_UPDATES_URL = DEFAULT_REALTIME_URL
FEED_SOURCE = "nta_gtfs"
DEFAULT_AGENCY_ID = "__default_agency__"
MIN_REALTIME_INTERVAL_SECONDS = 60
RATE_LIMIT_SAFETY_SECONDS = 1
DEFAULT_STATIC_REFRESH_SECONDS = 86_400
DEFAULT_REALTIME_RETENTION_DAYS = 7
REALTIME_RETENTION_INTERVAL_SECONDS = 86_400
MAX_STATIC_DOWNLOAD_BYTES = 1_000_000_000
MAX_REALTIME_DOWNLOAD_BYTES = 64 * 1024 * 1024
COPY_BATCH_ROWS = 5_000
INSERT_BATCH_ROWS = 1_000
STATIC_IMPORT_LOCK = "irish-rail-nabber:nta-static-feed"

UTC = timezone.utc
DatabaseRow = tuple[object, ...]


class FeedFormatError(ValueError):
    """The downloaded GTFS archive cannot be imported safely."""


def parse_gtfs_time(value: str | None) -> int | None:
    """Convert a GTFS ``HH:MM:SS`` value to seconds after service-day start.

    GTFS hours may exceed 23 for trips continuing after midnight. Empty values
    remain ``None`` because arrival or departure can be omitted at some stops.
    """

    if value is None or not value.strip():
        return None

    cleaned = value.strip()
    parts = cleaned.split(":")
    if len(parts) != 3 or any(not part.isdigit() for part in parts):
        raise ValueError(f"invalid GTFS time: {value!r}")

    hours, minutes, seconds = (int(part) for part in parts)
    if minutes > 59 or seconds > 59:
        raise ValueError(f"invalid GTFS time: {value!r}")

    return hours * 3_600 + minutes * 60 + seconds


def _canonical_key(value: object) -> str:
    return "".join(character for character in str(value).lower() if character.isalnum())


def _get(mapping: Mapping[str, Any] | None, *names: str) -> Any:
    """Read camelCase, PascalCase, or snake_case protobuf JSON fields."""

    if not isinstance(mapping, Mapping):
        return None

    wanted = {_canonical_key(name) for name in names}
    for key, value in mapping.items():
        if _canonical_key(key) in wanted:
            return value
    return None


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _optional_int(value: object) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if not isinstance(value, (str, bytes, bytearray, int, float)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _optional_float(value: object) -> float | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if not isinstance(value, (str, bytes, bytearray, int, float)):
        return None
    try:
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return None


def _enum_text(value: object) -> str | None:
    cleaned = _optional_text(value)
    return cleaned.upper() if cleaned is not None else None


def _trip_schedule_relationship(value: object) -> str:
    relationship = _enum_text(value)
    if relationship is None:
        return "SCHEDULED"
    return {
        "0": "SCHEDULED",
        "1": "ADDED",
        "2": "UNSCHEDULED",
        "3": "CANCELED",
        "5": "REPLACEMENT",
        "6": "DUPLICATED",
        "7": "DELETED",
    }.get(relationship, relationship)


def _stop_schedule_relationship(value: object) -> str | None:
    relationship = _enum_text(value)
    if relationship is None:
        return None
    return {
        "0": "SCHEDULED",
        "1": "SKIPPED",
        "2": "NO_DATA",
        "3": "UNSCHEDULED",
    }.get(relationship, relationship)


def _vehicle_stop_status(value: object) -> str | None:
    status = _enum_text(value)
    if status is None:
        return None
    return {
        "0": "INCOMING_AT",
        "1": "STOPPED_AT",
        "2": "IN_TRANSIT_TO",
    }.get(status, status)


def _congestion_level(value: object) -> str | None:
    level = _enum_text(value)
    if level is None:
        return None
    return {
        "0": "UNKNOWN_CONGESTION_LEVEL",
        "1": "RUNNING_SMOOTHLY",
        "2": "STOP_AND_GO",
        "3": "CONGESTION",
        "4": "SEVERE_CONGESTION",
    }.get(level, level)


def _occupancy_status(value: object) -> str | None:
    status = _enum_text(value)
    if status is None:
        return None
    return {
        "0": "EMPTY",
        "1": "MANY_SEATS_AVAILABLE",
        "2": "FEW_SEATS_AVAILABLE",
        "3": "STANDING_ROOM_ONLY",
        "4": "CRUSHED_STANDING_ROOM_ONLY",
        "5": "FULL",
        "6": "NOT_ACCEPTING_PASSENGERS",
        "7": "NO_DATA_AVAILABLE",
        "8": "NOT_BOARDABLE",
    }.get(status, status)


def _parse_timestamp(value: object) -> datetime | None:
    if value is None or isinstance(value, bool):
        return None

    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=UTC)

        cleaned = str(value).strip()
        if not cleaned:
            return None
        try:
            return datetime.fromtimestamp(float(cleaned), tz=UTC)
        except ValueError:
            parsed = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=UTC)
            return parsed.astimezone(UTC)
    except (OverflowError, OSError, TypeError, ValueError):
        return None


def _parse_service_date(value: object) -> date | None:
    cleaned = _optional_text(value)
    if cleaned is None:
        return None

    try:
        if len(cleaned) == 8 and cleaned.isdigit():
            return date(int(cleaned[:4]), int(cleaned[4:6]), int(cleaned[6:]))
        return date.fromisoformat(cleaned)
    except ValueError:
        return None


def _as_mapping(value: object) -> Mapping[str, Any] | None:
    return value if isinstance(value, Mapping) else None


def _as_items(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return value
    if isinstance(value, Mapping):
        return [value]
    return []


def _is_true(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes"}


def _stable_payload_hash(fields: Mapping[str, object]) -> str:
    canonical = json.dumps(
        fields,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=lambda value: (
            value.isoformat() if isinstance(value, (date, datetime)) else str(value)
        ),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _normalized_start_time(value: object) -> int | str | None:
    cleaned = _optional_text(value)
    if cleaned is None:
        return None
    try:
        return parse_gtfs_time(cleaned)
    except ValueError:
        return cleaned


def _normalized_incrementality(value: object) -> str:
    incrementality = _enum_text(value)
    if incrementality in {None, "0", "FULL_DATASET"}:
        return "FULL_DATASET"
    if incrementality in {"1", "DIFFERENTIAL"}:
        return "DIFFERENTIAL"
    return incrementality


@dataclass(frozen=True, slots=True)
class ParsedTripFreshness:
    trip_instance_key: str
    trip_id: str | None
    route_id: str | None
    source_timestamp: datetime | None
    schedule_relationship: str

    def database_row(self, feed_version_id: int, fetched_at: datetime) -> DatabaseRow:
        return (
            feed_version_id,
            self.trip_instance_key,
            fetched_at,
            self.source_timestamp,
            self.schedule_relationship,
        )


@dataclass(frozen=True, slots=True)
class ParsedStopUpdate:
    entity_id: str | None
    trip_id: str | None
    route_id: str | None
    service_date: date | None
    vehicle_id: str | None
    trip_instance_key: str
    stop_id: str | None
    stop_sequence: int | None
    schedule_relationship: str | None
    arrival_time: datetime | None
    departure_time: datetime | None
    arrival_delay_seconds: int | None
    departure_delay_seconds: int | None
    update_hash: str
    source_timestamp: datetime | None

    @property
    def state_key(self) -> tuple[object, ...]:
        """Identity used to compare this stop with the previous poll."""

        if self.stop_sequence is not None:
            return (self.trip_instance_key, "sequence", self.stop_sequence)
        if self.stop_id is not None:
            return (self.trip_instance_key, "stop_id", self.stop_id)
        return (self.trip_instance_key, "unknown")

    def database_row(self, feed_version_id: int, fetched_at: datetime) -> DatabaseRow:
        return (
            feed_version_id,
            self.entity_id,
            self.trip_id,
            self.route_id,
            self.service_date,
            self.vehicle_id,
            self.trip_instance_key,
            self.stop_id,
            self.stop_sequence,
            self.schedule_relationship,
            self.arrival_time,
            self.departure_time,
            self.arrival_delay_seconds,
            self.departure_delay_seconds,
            self.update_hash,
            self.source_timestamp,
            fetched_at,
            fetched_at,
        )


@dataclass(frozen=True, slots=True)
class ParsedVehiclePosition:
    entity_id: str | None
    vehicle_instance_key: str
    vehicle_id: str | None
    vehicle_label: str | None
    license_plate: str | None
    trip_instance_key: str
    trip_id: str | None
    route_id: str | None
    service_date: date | None
    schedule_relationship: str
    latitude: float | None
    longitude: float | None
    bearing: float | None
    speed: float | None
    current_stop_sequence: int | None
    stop_id: str | None
    current_status: str | None
    congestion_level: str | None
    occupancy_status: str | None
    occupancy_percentage: int | None
    update_hash: str
    source_timestamp: datetime | None

    def database_row(self, feed_version_id: int, fetched_at: datetime) -> DatabaseRow:
        return (
            feed_version_id,
            self.vehicle_instance_key,
            self.entity_id,
            self.vehicle_id,
            self.vehicle_label,
            self.license_plate,
            self.trip_instance_key,
            self.trip_id,
            self.route_id,
            self.service_date,
            self.schedule_relationship,
            self.latitude,
            self.longitude,
            self.bearing,
            self.speed,
            self.current_stop_sequence,
            self.stop_id,
            self.current_status,
            self.congestion_level,
            self.occupancy_status,
            self.occupancy_percentage,
            self.update_hash,
            self.source_timestamp,
            fetched_at,
            fetched_at,
        )


@dataclass(frozen=True, slots=True)
class ParsedRealtimeFeed:
    incrementality: str
    stop_updates: tuple[ParsedStopUpdate, ...]
    trip_freshness: tuple[ParsedTripFreshness, ...]
    vehicle_positions: tuple[ParsedVehiclePosition, ...]


@dataclass(frozen=True, slots=True)
class ActiveBusIds:
    feed_version_id: int
    route_ids: frozenset[str]
    trip_routes: Mapping[str, str]


def _stop_update_state_hash(update: ParsedStopUpdate) -> str:
    return _stable_payload_hash(
        {
            "entity_id": update.entity_id,
            "trip_id": update.trip_id,
            "route_id": update.route_id,
            "service_date": update.service_date,
            "vehicle_id": update.vehicle_id,
            "trip_instance_key": update.trip_instance_key,
            "stop_id": update.stop_id,
            "stop_sequence": update.stop_sequence,
            "schedule_relationship": update.schedule_relationship,
            "arrival_time": update.arrival_time,
            "departure_time": update.departure_time,
            "arrival_delay_seconds": update.arrival_delay_seconds,
            "departure_delay_seconds": update.departure_delay_seconds,
        }
    )


def _vehicle_position_state_hash(position: ParsedVehiclePosition) -> str:
    return _stable_payload_hash(
        {
            "entity_id": position.entity_id,
            "vehicle_instance_key": position.vehicle_instance_key,
            "vehicle_id": position.vehicle_id,
            "vehicle_label": position.vehicle_label,
            "license_plate": position.license_plate,
            "trip_instance_key": position.trip_instance_key,
            "trip_id": position.trip_id,
            "route_id": position.route_id,
            "service_date": position.service_date,
            "schedule_relationship": position.schedule_relationship,
            "latitude": position.latitude,
            "longitude": position.longitude,
            "bearing": position.bearing,
            "speed": position.speed,
            "current_stop_sequence": position.current_stop_sequence,
            "stop_id": position.stop_id,
            "current_status": position.current_status,
            "congestion_level": position.congestion_level,
            "occupancy_status": position.occupancy_status,
            "occupancy_percentage": position.occupancy_percentage,
        }
    )


def _trip_instance_key(
    entity_id: str | None,
    trip_id: str | None,
    route_id: str | None,
    service_date: date | None,
    start_time: int | str | None,
    vehicle_id: str | None,
) -> str:
    if entity_id is not None:
        fields: dict[str, object] = {
            "entity_id": entity_id,
            "service_date": service_date,
            "start_time": start_time,
        }
    elif any((trip_id, route_id, service_date, start_time)):
        fields = {
            "trip_id": trip_id,
            "route_id": route_id,
            "service_date": service_date,
            "start_time": start_time,
        }
    else:
        fields = {"vehicle_id": vehicle_id}
    return _stable_payload_hash(fields)


def _vehicle_instance_key(
    vehicle_id: str | None,
    vehicle_label: str | None,
    entity_id: str | None,
    trip_instance_key: str,
) -> str:
    if vehicle_id is not None:
        fields: dict[str, object] = {"vehicle_id": vehicle_id}
    elif vehicle_label is not None:
        fields = {"vehicle_label": vehicle_label}
    elif entity_id is not None:
        fields = {"entity_id": entity_id}
    else:
        fields = {"trip_instance_key": trip_instance_key}
    return _stable_payload_hash(fields)


def _parse_trip_update_entity(
    entity: Mapping[str, Any],
    trip_update: Mapping[str, Any],
    header_timestamp: datetime | None,
) -> tuple[ParsedTripFreshness, list[ParsedStopUpdate]]:
    trip = _as_mapping(_get(trip_update, "trip"))
    vehicle = _as_mapping(_get(trip_update, "vehicle"))
    entity_id = _optional_text(_get(entity, "id"))
    trip_id = _optional_text(_get(trip, "tripId"))
    route_id = _optional_text(_get(trip, "routeId"))
    service_date = _parse_service_date(_get(trip, "startDate"))
    start_time = _normalized_start_time(_get(trip, "startTime"))
    vehicle_id = _optional_text(_get(vehicle, "id"))
    trip_relationship = _trip_schedule_relationship(_get(trip, "scheduleRelationship"))
    source_timestamp = (
        _parse_timestamp(_get(trip_update, "timestamp")) or header_timestamp
    )
    instance_key = _trip_instance_key(
        entity_id,
        trip_id,
        route_id,
        service_date,
        start_time,
        vehicle_id,
    )
    freshness = ParsedTripFreshness(
        trip_instance_key=instance_key,
        trip_id=trip_id,
        route_id=route_id,
        source_timestamp=source_timestamp,
        schedule_relationship=trip_relationship,
    )
    updates: list[ParsedStopUpdate] = []

    for raw_stop_update in _as_items(_get(trip_update, "stopTimeUpdate")):
        stop_update = _as_mapping(raw_stop_update)
        if stop_update is None:
            continue

        arrival = _as_mapping(_get(stop_update, "arrival"))
        departure = _as_mapping(_get(stop_update, "departure"))
        stop_id = _optional_text(_get(stop_update, "stopId"))
        stop_sequence = _optional_int(_get(stop_update, "stopSequence"))
        relationship = (
            _stop_schedule_relationship(_get(stop_update, "scheduleRelationship"))
            or trip_relationship
        )
        arrival_time = _parse_timestamp(_get(arrival, "time"))
        departure_time = _parse_timestamp(_get(departure, "time"))
        arrival_delay = _optional_int(_get(arrival, "delay"))
        departure_delay = _optional_int(_get(departure, "delay"))
        parsed_update = ParsedStopUpdate(
            entity_id=entity_id,
            trip_id=trip_id,
            route_id=route_id,
            service_date=service_date,
            vehicle_id=vehicle_id,
            trip_instance_key=instance_key,
            stop_id=stop_id,
            stop_sequence=stop_sequence,
            schedule_relationship=relationship,
            arrival_time=arrival_time,
            departure_time=departure_time,
            arrival_delay_seconds=arrival_delay,
            departure_delay_seconds=departure_delay,
            update_hash="",
            source_timestamp=source_timestamp,
        )
        updates.append(
            replace(
                parsed_update,
                update_hash=_stop_update_state_hash(parsed_update),
            )
        )

    return freshness, updates


def _parse_vehicle_position_entity(
    entity: Mapping[str, Any],
    vehicle_position: Mapping[str, Any],
    header_timestamp: datetime | None,
) -> ParsedVehiclePosition:
    trip = _as_mapping(_get(vehicle_position, "trip"))
    vehicle = _as_mapping(_get(vehicle_position, "vehicle"))
    position = _as_mapping(_get(vehicle_position, "position"))
    entity_id = _optional_text(_get(entity, "id"))
    trip_id = _optional_text(_get(trip, "tripId"))
    route_id = _optional_text(_get(trip, "routeId"))
    service_date = _parse_service_date(_get(trip, "startDate"))
    start_time = _normalized_start_time(_get(trip, "startTime"))
    schedule_relationship = _trip_schedule_relationship(
        _get(trip, "scheduleRelationship")
    )
    vehicle_id = _optional_text(_get(vehicle, "id"))
    vehicle_label = _optional_text(_get(vehicle, "label"))
    license_plate = _optional_text(_get(vehicle, "licensePlate"))
    trip_key = _trip_instance_key(
        entity_id,
        trip_id,
        route_id,
        service_date,
        start_time,
        vehicle_id,
    )
    vehicle_key = _vehicle_instance_key(vehicle_id, vehicle_label, entity_id, trip_key)
    source_timestamp = (
        _parse_timestamp(_get(vehicle_position, "timestamp")) or header_timestamp
    )
    latitude = _optional_float(_get(position, "latitude"))
    longitude = _optional_float(_get(position, "longitude"))
    bearing = _optional_float(_get(position, "bearing"))
    speed = _optional_float(_get(position, "speed"))
    current_stop_sequence = _optional_int(_get(vehicle_position, "currentStopSequence"))
    stop_id = _optional_text(_get(vehicle_position, "stopId"))
    current_status = _vehicle_stop_status(_get(vehicle_position, "currentStatus"))
    congestion_level = _congestion_level(_get(vehicle_position, "congestionLevel"))
    occupancy_status = _occupancy_status(_get(vehicle_position, "occupancyStatus"))
    occupancy_percentage = _optional_int(_get(vehicle_position, "occupancyPercentage"))
    parsed_position = ParsedVehiclePosition(
        entity_id=entity_id,
        vehicle_instance_key=vehicle_key,
        vehicle_id=vehicle_id,
        vehicle_label=vehicle_label,
        license_plate=license_plate,
        trip_instance_key=trip_key,
        trip_id=trip_id,
        route_id=route_id,
        service_date=service_date,
        schedule_relationship=schedule_relationship,
        latitude=latitude,
        longitude=longitude,
        bearing=bearing,
        speed=speed,
        current_stop_sequence=current_stop_sequence,
        stop_id=stop_id,
        current_status=current_status,
        congestion_level=congestion_level,
        occupancy_status=occupancy_status,
        occupancy_percentage=occupancy_percentage,
        update_hash="",
        source_timestamp=source_timestamp,
    )
    return replace(
        parsed_position,
        update_hash=_vehicle_position_state_hash(parsed_position),
    )


def parse_realtime_feed(
    payload: Mapping[str, Any] | str | bytes | bytearray,
) -> ParsedRealtimeFeed:
    """Normalize TripUpdates and VehiclePositions from one FeedMessage."""

    if isinstance(payload, (str, bytes, bytearray)):
        try:
            decoded = json.loads(payload)
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("GTFS-Realtime response is not valid JSON") from error
    else:
        decoded = payload

    if not isinstance(decoded, Mapping):
        raise ValueError("GTFS-Realtime response must be a JSON object")

    header = _as_mapping(_get(decoded, "header"))
    header_timestamp = _parse_timestamp(_get(header, "timestamp"))
    incrementality = _normalized_incrementality(_get(header, "incrementality"))
    updates: list[ParsedStopUpdate] = []
    trip_freshness: dict[str, ParsedTripFreshness] = {}
    vehicle_positions: list[ParsedVehiclePosition] = []

    for raw_entity in _as_items(_get(decoded, "entity", "entities")):
        entity = _as_mapping(raw_entity)
        if entity is None or _is_true(_get(entity, "isDeleted")):
            continue

        trip_update = _as_mapping(_get(entity, "tripUpdate"))
        if trip_update is not None:
            freshness, entity_updates = _parse_trip_update_entity(
                entity, trip_update, header_timestamp
            )
            trip_freshness[freshness.trip_instance_key] = freshness
            updates.extend(entity_updates)

        vehicle_position = _as_mapping(_get(entity, "vehicle"))
        if vehicle_position is not None:
            vehicle_positions.append(
                _parse_vehicle_position_entity(
                    entity, vehicle_position, header_timestamp
                )
            )

    return ParsedRealtimeFeed(
        incrementality=incrementality,
        stop_updates=tuple(updates),
        trip_freshness=tuple(trip_freshness.values()),
        vehicle_positions=tuple(vehicle_positions),
    )


def _parse_trip_updates_feed(
    payload: Mapping[str, Any] | str | bytes | bytearray,
) -> ParsedRealtimeFeed:
    """Backward-compatible name for the combined realtime parser."""

    return parse_realtime_feed(payload)


def parse_trip_updates(
    payload: Mapping[str, Any] | str | bytes | bytearray,
) -> list[ParsedStopUpdate]:
    """Normalize stop updates from a GTFS-Realtime JSON FeedMessage.

    Generated protobuf JSON is normally camelCase, while some gateways return
    snake_case or PascalCase. Key lookup ignores case and separators. Invalid
    optional scalar values become ``None`` rather than dropping the entity.
    """

    return list(parse_realtime_feed(payload).stop_updates)


def parse_vehicle_positions(
    payload: Mapping[str, Any] | str | bytes | bytearray,
) -> list[ParsedVehiclePosition]:
    """Normalize vehicle positions from a GTFS-Realtime JSON FeedMessage."""

    return list(parse_realtime_feed(payload).vehicle_positions)


_DYNAMIC_TRIP_RELATIONSHIPS = frozenset(
    {
        "ADDED",
        "UNSCHEDULED",
        "CANCELED",
        "REPLACEMENT",
        "DUPLICATED",
        "DELETED",
    }
)


def _resolve_bus_route(
    trip_id: str | None,
    route_id: str | None,
    schedule_relationship: str,
    bus_ids: ActiveBusIds,
) -> str | None:
    if trip_id is not None and trip_id in bus_ids.trip_routes:
        return bus_ids.trip_routes[trip_id]
    if (
        route_id in bus_ids.route_ids
        and schedule_relationship in _DYNAMIC_TRIP_RELATIONSHIPS
    ):
        return route_id
    return None


def filter_bus_realtime_feed(
    feed: ParsedRealtimeFeed, bus_ids: ActiveBusIds
) -> ParsedRealtimeFeed:
    """Keep static bus trips plus dynamic trips on known bus routes."""

    accepted_trip_keys: dict[str, str] = {}
    freshness: list[ParsedTripFreshness] = []
    for trip in feed.trip_freshness:
        route_id = _resolve_bus_route(
            trip.trip_id,
            trip.route_id,
            trip.schedule_relationship,
            bus_ids,
        )
        if route_id is None:
            continue
        accepted_trip_keys[trip.trip_instance_key] = route_id
        freshness.append(replace(trip, route_id=route_id))

    stop_updates: list[ParsedStopUpdate] = []
    for update in feed.stop_updates:
        route_id = accepted_trip_keys.get(update.trip_instance_key)
        if route_id is None:
            continue
        normalized = replace(update, route_id=route_id)
        stop_updates.append(
            replace(normalized, update_hash=_stop_update_state_hash(normalized))
        )
    vehicle_positions: list[ParsedVehiclePosition] = []
    for position in feed.vehicle_positions:
        route_id = _resolve_bus_route(
            position.trip_id,
            position.route_id,
            position.schedule_relationship,
            bus_ids,
        )
        if route_id is not None:
            normalized_position = replace(position, route_id=route_id)
            vehicle_positions.append(
                replace(
                    normalized_position,
                    update_hash=_vehicle_position_state_hash(normalized_position),
                )
            )

    return ParsedRealtimeFeed(
        incrementality=feed.incrementality,
        stop_updates=tuple(stop_updates),
        trip_freshness=tuple(freshness),
        vehicle_positions=tuple(vehicle_positions),
    )


def _clean_csv_row(row: Mapping[str | None, str | None]) -> dict[str, str]:
    return {
        str(key).strip().lower(): (value or "").strip()
        for key, value in row.items()
        if key is not None
    }


def _find_zip_member(archive: zipfile.ZipFile, filename: str) -> str:
    matches = [
        name
        for name in archive.namelist()
        if name.rsplit("/", 1)[-1].lower() == filename.lower()
    ]
    if len(matches) != 1:
        raise FeedFormatError(
            f"expected one {filename} in GTFS archive, found {len(matches)}"
        )
    return matches[0]


def _gtfs_rows(
    archive: zipfile.ZipFile, filename: str
) -> Iterator[tuple[int, dict[str, str]]]:
    member = _find_zip_member(archive, filename)
    with archive.open(member) as raw_file:
        with io.TextIOWrapper(raw_file, encoding="utf-8-sig", newline="") as text_file:
            reader = csv.DictReader(text_file)
            if reader.fieldnames is None:
                raise FeedFormatError(f"{filename} has no header")
            for line_number, row in enumerate(reader, start=2):
                yield line_number, _clean_csv_row(row)


def _required_field(
    row: Mapping[str, str], field: str, filename: str, line_number: int
) -> str:
    value = row.get(field, "").strip()
    if not value:
        raise FeedFormatError(f"{filename}:{line_number} has no {field}")
    return value


def _csv_int(
    value: str, field: str, filename: str, line_number: int, *, required: bool
) -> int | None:
    cleaned = value.strip()
    if not cleaned and not required:
        return None
    try:
        return int(cleaned)
    except ValueError as error:
        raise FeedFormatError(
            f"{filename}:{line_number} has invalid {field}: {value!r}"
        ) from error


def _csv_float(
    value: str, field: str, filename: str, line_number: int, *, required: bool
) -> float | None:
    cleaned = value.strip()
    if not cleaned and not required:
        return None
    try:
        return float(cleaned)
    except ValueError as error:
        raise FeedFormatError(
            f"{filename}:{line_number} has invalid {field}: {value!r}"
        ) from error


@dataclass(frozen=True, slots=True)
class StaticFeedSelection:
    agencies: tuple[DatabaseRow, ...]
    routes: tuple[DatabaseRow, ...]
    stops: tuple[DatabaseRow, ...]
    trips: tuple[DatabaseRow, ...]
    trip_ids: frozenset[str]
    shape_ids: frozenset[str]
    stop_time_count: int
    shape_point_count: int


def _select_static_feed(archive: zipfile.ZipFile) -> StaticFeedSelection:
    """Select bus rows and dependencies without buffering every stop time."""

    raw_agencies: list[tuple[str | None, str, str | None, str | None]] = []
    for line_number, row in _gtfs_rows(archive, "agency.txt"):
        raw_agencies.append(
            (
                row.get("agency_id") or None,
                _required_field(row, "agency_name", "agency.txt", line_number),
                row.get("agency_url") or None,
                row.get("agency_timezone") or None,
            )
        )

    if not raw_agencies:
        raise FeedFormatError("agency.txt contains no agencies")
    if any(agency[0] is None for agency in raw_agencies) and len(raw_agencies) != 1:
        raise FeedFormatError("agency_id is required when agency.txt has multiple rows")

    all_agencies: dict[str, DatabaseRow] = {}
    for agency_id, agency_name, agency_url, agency_timezone in raw_agencies:
        normalized_id = agency_id or DEFAULT_AGENCY_ID
        if normalized_id in all_agencies:
            raise FeedFormatError(f"agency.txt repeats agency_id {normalized_id!r}")
        all_agencies[normalized_id] = (
            normalized_id,
            agency_name,
            agency_url,
            agency_timezone,
        )

    routes: list[DatabaseRow] = []
    route_ids: set[str] = set()
    agency_ids: set[str] = set()
    sole_agency_id = next(iter(all_agencies)) if len(all_agencies) == 1 else None
    for line_number, row in _gtfs_rows(archive, "routes.txt"):
        route_type = _csv_int(
            row.get("route_type", ""),
            "route_type",
            "routes.txt",
            line_number,
            required=True,
        )
        if route_type != 3:
            continue

        route_id = _required_field(row, "route_id", "routes.txt", line_number)
        agency_id = row.get("agency_id") or sole_agency_id
        if agency_id is None:
            raise FeedFormatError(
                f"routes.txt:{line_number} has no agency_id in a multi-agency feed"
            )
        agency_ids.add(agency_id)
        route_ids.add(route_id)
        routes.append(
            (
                route_id,
                agency_id,
                row.get("route_short_name") or None,
                row.get("route_long_name") or None,
                route_type,
                row.get("route_color") or None,
                row.get("route_text_color") or None,
            )
        )

    if not routes:
        raise FeedFormatError("GTFS archive contains no route_type=3 bus routes")

    missing_agencies = agency_ids - all_agencies.keys()
    if missing_agencies:
        sample = ", ".join(sorted(missing_agencies)[:5])
        raise FeedFormatError(f"bus routes reference missing agencies: {sample}")

    agencies = tuple(all_agencies[key] for key in sorted(agency_ids))

    trips: list[DatabaseRow] = []
    trip_ids: set[str] = set()
    shape_ids: set[str] = set()
    for line_number, row in _gtfs_rows(archive, "trips.txt"):
        route_id = row.get("route_id", "")
        if route_id not in route_ids:
            continue
        trip_id = _required_field(row, "trip_id", "trips.txt", line_number)
        trip_ids.add(trip_id)
        shape_id = row.get("shape_id") or None
        if shape_id is not None:
            shape_ids.add(shape_id)
        trips.append(
            (
                trip_id,
                route_id,
                _required_field(row, "service_id", "trips.txt", line_number),
                row.get("trip_headsign") or None,
                _csv_int(
                    row.get("direction_id", ""),
                    "direction_id",
                    "trips.txt",
                    line_number,
                    required=False,
                ),
                shape_id,
            )
        )

    if not trips:
        raise FeedFormatError("GTFS archive contains no trips for bus routes")

    used_stop_ids: set[str] = set()
    stop_time_count = 0
    for line_number, row in _gtfs_rows(archive, "stop_times.txt"):
        if row.get("trip_id") not in trip_ids:
            continue
        stop_id = _required_field(row, "stop_id", "stop_times.txt", line_number)
        _csv_int(
            row.get("stop_sequence", ""),
            "stop_sequence",
            "stop_times.txt",
            line_number,
            required=True,
        )
        try:
            parse_gtfs_time(row.get("arrival_time"))
            parse_gtfs_time(row.get("departure_time"))
        except ValueError as error:
            raise FeedFormatError(f"stop_times.txt:{line_number}: {error}") from error
        used_stop_ids.add(stop_id)
        stop_time_count += 1

    if stop_time_count == 0:
        raise FeedFormatError("GTFS archive contains no stop times for bus trips")

    shape_point_count = 0
    found_shape_ids: set[str] = set()
    for shape_id, *_point in _iter_bus_shape_points(archive, frozenset(shape_ids)):
        found_shape_ids.add(str(shape_id))
        shape_point_count += 1

    missing_shapes = shape_ids - found_shape_ids
    if missing_shapes:
        sample = ", ".join(sorted(missing_shapes)[:5])
        raise FeedFormatError(f"bus trips reference missing shapes: {sample}")

    all_stops: dict[str, DatabaseRow] = {}
    for line_number, row in _gtfs_rows(archive, "stops.txt"):
        stop_id = _required_field(row, "stop_id", "stops.txt", line_number)
        try:
            stop_lat = float(row["stop_lat"]) if row.get("stop_lat") else None
            stop_lon = float(row["stop_lon"]) if row.get("stop_lon") else None
        except ValueError as error:
            raise FeedFormatError(
                f"stops.txt:{line_number} has invalid coordinates"
            ) from error
        all_stops[stop_id] = (
            stop_id,
            row.get("stop_code") or None,
            row.get("stop_name") or None,
            stop_lat,
            stop_lon,
            row.get("parent_station") or None,
        )

    missing_stops = used_stop_ids - all_stops.keys()
    if missing_stops:
        sample = ", ".join(sorted(missing_stops)[:5])
        raise FeedFormatError(f"bus stop times reference missing stops: {sample}")

    selected_stop_ids = set(used_stop_ids)
    pending_stop_ids = list(used_stop_ids)
    while pending_stop_ids:
        stop_id = pending_stop_ids.pop()
        parent_station = all_stops[stop_id][5]
        if not isinstance(parent_station, str) or not parent_station:
            continue
        if parent_station not in all_stops:
            raise FeedFormatError(
                f"stop {stop_id} references missing parent station {parent_station}"
            )
        if parent_station not in selected_stop_ids:
            selected_stop_ids.add(parent_station)
            pending_stop_ids.append(parent_station)

    stops = tuple(all_stops[key] for key in sorted(selected_stop_ids))
    return StaticFeedSelection(
        agencies=agencies,
        routes=tuple(sorted(routes, key=lambda route: str(route[0]))),
        stops=stops,
        trips=tuple(sorted(trips, key=lambda trip: str(trip[0]))),
        trip_ids=frozenset(trip_ids),
        shape_ids=frozenset(shape_ids),
        stop_time_count=stop_time_count,
        shape_point_count=shape_point_count,
    )


def _iter_bus_stop_times(
    archive: zipfile.ZipFile, trip_ids: frozenset[str]
) -> Iterator[DatabaseRow]:
    for line_number, row in _gtfs_rows(archive, "stop_times.txt"):
        trip_id = row.get("trip_id", "")
        if trip_id not in trip_ids:
            continue
        stop_id = _required_field(row, "stop_id", "stop_times.txt", line_number)
        stop_sequence = _csv_int(
            row.get("stop_sequence", ""),
            "stop_sequence",
            "stop_times.txt",
            line_number,
            required=True,
        )
        try:
            arrival_seconds = parse_gtfs_time(row.get("arrival_time"))
            departure_seconds = parse_gtfs_time(row.get("departure_time"))
        except ValueError as error:
            raise FeedFormatError(f"stop_times.txt:{line_number}: {error}") from error
        yield (
            trip_id,
            stop_sequence,
            stop_id,
            arrival_seconds,
            departure_seconds,
        )


def _iter_bus_shape_points(
    archive: zipfile.ZipFile, shape_ids: frozenset[str]
) -> Iterator[DatabaseRow]:
    if not shape_ids:
        return

    for line_number, row in _gtfs_rows(archive, "shapes.txt"):
        shape_id = row.get("shape_id", "")
        if shape_id not in shape_ids:
            continue

        sequence = _csv_int(
            row.get("shape_pt_sequence", ""),
            "shape_pt_sequence",
            "shapes.txt",
            line_number,
            required=True,
        )
        latitude = _csv_float(
            row.get("shape_pt_lat", ""),
            "shape_pt_lat",
            "shapes.txt",
            line_number,
            required=True,
        )
        longitude = _csv_float(
            row.get("shape_pt_lon", ""),
            "shape_pt_lon",
            "shapes.txt",
            line_number,
            required=True,
        )
        distance = _csv_float(
            row.get("shape_dist_traveled", ""),
            "shape_dist_traveled",
            "shapes.txt",
            line_number,
            required=False,
        )
        if sequence is None or sequence < 0:
            raise FeedFormatError(
                f"shapes.txt:{line_number} has negative shape_pt_sequence"
            )
        if (
            latitude is None
            or not math.isfinite(latitude)
            or not -90 <= latitude <= 90
        ):
            raise FeedFormatError(
                f"shapes.txt:{line_number} has invalid shape_pt_lat"
            )
        if (
            longitude is None
            or not math.isfinite(longitude)
            or not -180 <= longitude <= 180
        ):
            raise FeedFormatError(
                f"shapes.txt:{line_number} has invalid shape_pt_lon"
            )
        if distance is not None and (not math.isfinite(distance) or distance < 0):
            raise FeedFormatError(
                f"shapes.txt:{line_number} has invalid shape_dist_traveled"
            )

        yield shape_id, sequence, latitude, longitude, distance


def _select_static_feed_file(feed_file: BinaryIO) -> StaticFeedSelection:
    feed_file.seek(0)
    with zipfile.ZipFile(feed_file) as archive:
        return _select_static_feed(archive)


@dataclass(frozen=True, slots=True)
class StaticImportResult:
    feed_version_id: int
    imported: bool
    row_count: int
    agencies: int = 0
    routes: int = 0
    stops: int = 0
    trips: int = 0
    stop_times: int = 0
    shape_points: int = 0
    pruned_stop_times: int = 0


def _prefixed_rows(
    prefix: object, rows: Iterable[DatabaseRow]
) -> Iterator[DatabaseRow]:
    for row in rows:
        yield (prefix, *row)


async def _copy_rows(
    connection: Any,
    table: str,
    columns: Sequence[str],
    rows: Iterable[DatabaseRow],
) -> int:
    """COPY rows in bounded CSV chunks without buffering the full feed."""

    statement = (
        f"COPY {table} ({', '.join(columns)}) FROM STDIN WITH (FORMAT CSV, NULL '')"
    )
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    count = 0

    async with connection.cursor() as cursor:
        async with cursor.copy(statement) as copy:
            for row in rows:
                writer.writerow(row)
                count += 1
                if count % COPY_BATCH_ROWS == 0:
                    await copy.write(buffer.getvalue())
                    buffer.seek(0)
                    buffer.truncate(0)
            if buffer.tell():
                await copy.write(buffer.getvalue())

    return count


def _chunks(rows: Sequence[DatabaseRow], size: int) -> Iterator[Sequence[DatabaseRow]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


class NtaBusDaemon:
    def __init__(
        self,
        database_url: str,
        *,
        api_key: str | None = None,
        gtfs_url: str = DEFAULT_GTFS_URL,
        trip_updates_url: str = DEFAULT_TRIP_UPDATES_URL,
        static_refresh_seconds: int = DEFAULT_STATIC_REFRESH_SECONDS,
        realtime_interval_seconds: int = MIN_REALTIME_INTERVAL_SECONDS,
        realtime_retention_days: int = DEFAULT_REALTIME_RETENTION_DAYS,
    ) -> None:
        self.database_url = database_url
        self.api_key = api_key.strip() if api_key and api_key.strip() else None
        self.gtfs_url = gtfs_url
        # Preserve the old attribute/constructor contract while the environment
        # moves from the TripUpdates-only endpoint to the combined FeedMessage.
        self.realtime_url = trip_updates_url
        self.trip_updates_url = trip_updates_url
        self.static_refresh_seconds = max(60, static_refresh_seconds)
        self.realtime_interval_seconds = max(
            MIN_REALTIME_INTERVAL_SECONDS, realtime_interval_seconds
        )
        if realtime_retention_days <= 0:
            raise ValueError("realtime_retention_days must be greater than zero")
        self.realtime_retention_days = realtime_retention_days
        self.pool: Any = None
        self.session: Any = None
        self._shutdown = asyncio.Event()
        self._feed_lock = asyncio.Lock()
        self._previous_update_hashes: dict[tuple[object, ...], str] = {}
        self._previous_vehicle_hashes: dict[tuple[int, str], str] = {}
        self._active_bus_ids_cache: ActiveBusIds | None = None

        if realtime_interval_seconds < MIN_REALTIME_INTERVAL_SECONDS:
            logger.warning(
                "BUS_REALTIME_INTERVAL_SECONDS=%s is below NTA fair use; using 60s",
                realtime_interval_seconds,
            )

    async def init(self) -> None:
        if aiohttp is None or AsyncConnectionPool is None:
            raise RuntimeError("runtime packages are missing; install requirements.txt")

        pool = AsyncConnectionPool(
            self.database_url,
            min_size=1,
            max_size=4,
            timeout=30,
            open=False,
        )
        self.pool = pool
        try:
            await pool.open()
            self.session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=300, connect=20, sock_read=90),
                headers={"User-Agent": "irish-rail-nabber-bus/1.0"},
            )
        except BaseException:
            await pool.close()
            self.pool = None
            raise
        logger.info("NTA bus daemon initialized")

    async def close(self) -> None:
        try:
            if self.session is not None:
                await self.session.close()
        finally:
            self.session = None
            if self.pool is not None:
                await self.pool.close()
            self.pool = None
        logger.info("NTA bus daemon stopped")

    def _handle_signal(self, received_signal: signal.Signals) -> None:
        logger.info("received %s, stopping", received_signal.name)
        self._shutdown.set()

    def _install_signal_handlers(self) -> None:
        loop = asyncio.get_running_loop()
        for handled_signal in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(
                    handled_signal, self._handle_signal, handled_signal
                )
            except NotImplementedError:

                def fallback_handler(
                    _signum: int,
                    _frame: FrameType | None,
                    signal_to_handle: signal.Signals = handled_signal,
                ) -> None:
                    self._handle_signal(signal_to_handle)

                signal.signal(handled_signal, fallback_handler)

    async def record_fetch(
        self,
        endpoint: str,
        record_count: int,
        status: str,
        *,
        error: str | None = None,
        duration_ms: int = 0,
    ) -> None:
        try:
            async with self.pool.connection() as connection:
                await connection.execute(
                    """INSERT INTO fetch_history
                       (endpoint, record_count, status, error_msg, duration_ms,
                        fetched_at)
                       VALUES (%s, %s, %s, %s, %s, NOW())""",
                    (endpoint, record_count, status, error, duration_ms),
                )
                await connection.commit()
        except Exception as fetch_error:
            logger.warning("could not record bus fetch: %s", fetch_error)

    async def _download_static_feed(self) -> tuple[BinaryIO, str, datetime, int]:
        if self.session is None:
            raise RuntimeError("daemon has not been initialized")

        last_error: Exception | None = None
        for attempt in range(1, 4):
            spool = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024, mode="w+b")
            digest = hashlib.sha256()
            byte_count = 0
            try:
                async with self.session.get(self.gtfs_url) as response:
                    if response.status != 200:
                        raise RuntimeError(
                            f"static GTFS returned HTTP {response.status}"
                        )
                    if (
                        response.content_length is not None
                        and response.content_length > MAX_STATIC_DOWNLOAD_BYTES
                    ):
                        raise RuntimeError(
                            "static GTFS exceeds the download size limit"
                        )

                    async for chunk in response.content.iter_chunked(1024 * 1024):
                        byte_count += len(chunk)
                        if byte_count > MAX_STATIC_DOWNLOAD_BYTES:
                            raise RuntimeError(
                                "static GTFS exceeds the download size limit"
                            )
                        digest.update(chunk)
                        spool.write(chunk)

                if byte_count == 0:
                    raise RuntimeError("static GTFS response was empty")
                spool.seek(0)
                return (
                    cast(BinaryIO, spool),
                    digest.hexdigest(),
                    datetime.now(tz=UTC),
                    byte_count,
                )
            except Exception as error:
                spool.close()
                last_error = error
                logger.warning(
                    "static GTFS download failed on attempt %s/3: %s", attempt, error
                )
                if attempt < 3:
                    await asyncio.sleep(2 ** (attempt - 1))

        raise RuntimeError(
            "static GTFS download failed after three attempts"
        ) from last_error

    async def _activate_existing_version(
        self, content_sha256: str
    ) -> StaticImportResult | None:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s))", (STATIC_IMPORT_LOCK,)
                )
                cursor = await connection.execute(
                    """SELECT id, imported_at,
                              EXISTS (
                                  SELECT 1 FROM bus_stop_times
                                  WHERE feed_version_id = transit_feed_versions.id
                              ),
                              shapes_imported
                       FROM transit_feed_versions
                       WHERE source = %s AND content_sha256 = %s
                       ORDER BY id DESC
                       LIMIT 1""",
                    (FEED_SOURCE, content_sha256),
                )
                existing = await cursor.fetchone()
                if existing is None:
                    return None
                if existing[1] is None:
                    raise RuntimeError(
                        "matching static feed version exists but was never imported"
                    )

                # Inactive versions keep identity/reference rows, but their large
                # stop-time and shape-point sets are pruned. Existing active feeds
                # also need one re-import after the shapes migration is applied.
                if not existing[2] or not existing[3]:
                    return None

                version_id = int(existing[0])
                pruned = await self._activate_version_and_prune_stop_times(
                    connection, version_id
                )
                return StaticImportResult(
                    version_id,
                    imported=False,
                    row_count=0,
                    pruned_stop_times=pruned,
                )

    async def _activate_version_and_prune_stop_times(
        self, connection: Any, version_id: int
    ) -> int:
        """Activate one feed and remove bulky inactive data in the same transaction."""

        await connection.execute(
            "UPDATE transit_feed_versions SET is_active = FALSE WHERE source = %s",
            (FEED_SOURCE,),
        )
        await connection.execute(
            "UPDATE transit_feed_versions SET is_active = TRUE WHERE id = %s",
            (version_id,),
        )
        await connection.execute(
            """UPDATE transit_feed_versions
               SET shapes_imported = FALSE
               WHERE source = %s AND id <> %s""",
            (FEED_SOURCE, version_id),
        )
        await connection.execute(
            """DELETE FROM bus_shape_points
               WHERE feed_version_id IN (
                   SELECT id FROM transit_feed_versions
                   WHERE source = %s AND id <> %s
               )""",
            (FEED_SOURCE, version_id),
        )
        cursor = await connection.execute(
            """DELETE FROM bus_stop_times
               WHERE feed_version_id IN (
                   SELECT id FROM transit_feed_versions
                   WHERE source = %s AND id <> %s
               )""",
            (FEED_SOURCE, version_id),
        )
        return max(0, cursor.rowcount)

    async def _import_static_feed(
        self,
        feed_file: BinaryIO,
        content_sha256: str,
        downloaded_at: datetime,
    ) -> StaticImportResult:
        existing = await self._activate_existing_version(content_sha256)
        if existing is not None:
            return existing

        selection = await asyncio.to_thread(_select_static_feed_file, feed_file)
        feed_file.seek(0)
        with zipfile.ZipFile(feed_file) as archive:
            async with self.pool.connection() as connection:
                async with connection.transaction():
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext(%s))",
                        (STATIC_IMPORT_LOCK,),
                    )
                    cursor = await connection.execute(
                        """SELECT id, imported_at,
                                  EXISTS (
                                      SELECT 1 FROM bus_stop_times
                                      WHERE feed_version_id = transit_feed_versions.id
                                  ),
                                  shapes_imported
                           FROM transit_feed_versions
                           WHERE source = %s AND content_sha256 = %s
                           ORDER BY id DESC
                           LIMIT 1""",
                        (FEED_SOURCE, content_sha256),
                    )
                    existing_row = await cursor.fetchone()
                    if existing_row is not None:
                        if existing_row[1] is None:
                            raise RuntimeError(
                                "matching static feed version exists but was "
                                "never imported"
                            )
                        version_id = int(existing_row[0])
                        has_stop_times = bool(existing_row[2])
                        shapes_imported = bool(existing_row[3])
                        if has_stop_times and shapes_imported:
                            pruned = await self._activate_version_and_prune_stop_times(
                                connection, version_id
                            )
                            return StaticImportResult(
                                version_id,
                                imported=False,
                                row_count=0,
                                pruned_stop_times=pruned,
                            )

                        stop_time_count = 0
                        if not has_stop_times:
                            await connection.execute(
                                "DELETE FROM bus_stop_times WHERE feed_version_id = %s",
                                (version_id,),
                            )
                            stop_time_count = await _copy_rows(
                                connection,
                                "bus_stop_times",
                                (
                                    "feed_version_id",
                                    "trip_id",
                                    "stop_sequence",
                                    "stop_id",
                                    "arrival_seconds",
                                    "departure_seconds",
                                ),
                                _prefixed_rows(
                                    version_id,
                                    _iter_bus_stop_times(archive, selection.trip_ids),
                                ),
                            )
                            if stop_time_count != selection.stop_time_count:
                                raise RuntimeError(
                                    "stop-time count changed while restoring the "
                                    "static archive"
                                )

                        shape_point_count = 0
                        if not shapes_imported:
                            await connection.execute(
                                """DELETE FROM bus_shape_points
                                   WHERE feed_version_id = %s""",
                                (version_id,),
                            )
                            shape_point_count = await _copy_rows(
                                connection,
                                "bus_shape_points",
                                (
                                    "feed_version_id",
                                    "shape_id",
                                    "shape_pt_sequence",
                                    "shape_pt_lat",
                                    "shape_pt_lon",
                                    "shape_dist_traveled",
                                ),
                                _prefixed_rows(
                                    version_id,
                                    _iter_bus_shape_points(
                                        archive, selection.shape_ids
                                    ),
                                ),
                            )
                            if shape_point_count != selection.shape_point_count:
                                raise RuntimeError(
                                    "shape-point count changed while restoring the "
                                    "static archive"
                                )
                            await connection.execute(
                                """UPDATE transit_feed_versions
                                   SET shapes_imported = TRUE WHERE id = %s""",
                                (version_id,),
                            )
                        pruned = await self._activate_version_and_prune_stop_times(
                            connection, version_id
                        )
                        imported_count = stop_time_count + shape_point_count
                        return StaticImportResult(
                            version_id,
                            imported=True,
                            row_count=imported_count,
                            stop_times=stop_time_count,
                            shape_points=shape_point_count,
                            pruned_stop_times=pruned,
                        )

                    version_cursor = await connection.execute(
                        """INSERT INTO transit_feed_versions
                           (source, content_sha256, downloaded_at, imported_at,
                            is_active)
                           VALUES (%s, %s, %s, NULL, FALSE)
                           RETURNING id""",
                        (FEED_SOURCE, content_sha256, downloaded_at),
                    )
                    version_row = await version_cursor.fetchone()
                    if version_row is None:
                        raise RuntimeError("database did not return a feed version ID")
                    version_id = int(version_row[0])

                    agency_count = await _copy_rows(
                        connection,
                        "bus_agencies",
                        (
                            "feed_version_id",
                            "agency_id",
                            "agency_name",
                            "agency_url",
                            "agency_timezone",
                        ),
                        _prefixed_rows(version_id, selection.agencies),
                    )
                    route_count = await _copy_rows(
                        connection,
                        "bus_routes",
                        (
                            "feed_version_id",
                            "route_id",
                            "agency_id",
                            "route_short_name",
                            "route_long_name",
                            "route_type",
                            "route_color",
                            "route_text_color",
                        ),
                        _prefixed_rows(version_id, selection.routes),
                    )
                    stop_count = await _copy_rows(
                        connection,
                        "bus_stops",
                        (
                            "feed_version_id",
                            "stop_id",
                            "stop_code",
                            "stop_name",
                            "stop_lat",
                            "stop_lon",
                            "parent_station",
                        ),
                        _prefixed_rows(version_id, selection.stops),
                    )
                    trip_count = await _copy_rows(
                        connection,
                        "bus_trips",
                        (
                            "feed_version_id",
                            "trip_id",
                            "route_id",
                            "service_id",
                            "trip_headsign",
                            "direction_id",
                            "shape_id",
                        ),
                        _prefixed_rows(version_id, selection.trips),
                    )
                    shape_point_count = await _copy_rows(
                        connection,
                        "bus_shape_points",
                        (
                            "feed_version_id",
                            "shape_id",
                            "shape_pt_sequence",
                            "shape_pt_lat",
                            "shape_pt_lon",
                            "shape_dist_traveled",
                        ),
                        _prefixed_rows(
                            version_id,
                            _iter_bus_shape_points(archive, selection.shape_ids),
                        ),
                    )
                    if shape_point_count != selection.shape_point_count:
                        raise RuntimeError(
                            "shape-point count changed while reading the static archive"
                        )
                    stop_time_count = await _copy_rows(
                        connection,
                        "bus_stop_times",
                        (
                            "feed_version_id",
                            "trip_id",
                            "stop_sequence",
                            "stop_id",
                            "arrival_seconds",
                            "departure_seconds",
                        ),
                        _prefixed_rows(
                            version_id,
                            _iter_bus_stop_times(archive, selection.trip_ids),
                        ),
                    )
                    if stop_time_count != selection.stop_time_count:
                        raise RuntimeError(
                            "stop-time count changed while reading the static archive"
                        )

                    await connection.execute(
                        """UPDATE transit_feed_versions
                           SET imported_at = NOW(), shapes_imported = TRUE
                           WHERE id = %s""",
                        (version_id,),
                    )
                    pruned_stop_times = (
                        await self._activate_version_and_prune_stop_times(
                            connection, version_id
                        )
                    )

        row_count = (
            agency_count
            + route_count
            + stop_count
            + trip_count
            + stop_time_count
            + shape_point_count
        )
        return StaticImportResult(
            feed_version_id=version_id,
            imported=True,
            row_count=row_count,
            agencies=agency_count,
            routes=route_count,
            stops=stop_count,
            trips=trip_count,
            stop_times=stop_time_count,
            shape_points=shape_point_count,
            pruned_stop_times=pruned_stop_times,
        )

    async def refresh_static_feed(self) -> None:
        started = time.monotonic()
        async with self._feed_lock:
            feed_file: BinaryIO | None = None
            try:
                (
                    feed_file,
                    content_hash,
                    downloaded_at,
                    byte_count,
                ) = await self._download_static_feed()
                result = await self._import_static_feed(
                    feed_file, content_hash, downloaded_at
                )
                duration_ms = int((time.monotonic() - started) * 1_000)
                status = "success" if result.imported else "skipped"
                await self.record_fetch(
                    "nta_static_gtfs",
                    result.row_count,
                    status,
                    duration_ms=duration_ms,
                )
                self._previous_update_hashes = {
                    key: value
                    for key, value in self._previous_update_hashes.items()
                    if key[0] == result.feed_version_id
                }
                self._previous_vehicle_hashes = {
                    key: value
                    for key, value in self._previous_vehicle_hashes.items()
                    if key[0] == result.feed_version_id
                }
                if (
                    self._active_bus_ids_cache is not None
                    and self._active_bus_ids_cache.feed_version_id
                    != result.feed_version_id
                ):
                    self._active_bus_ids_cache = None
                if result.imported:
                    logger.info(
                        "static GTFS version %s imported from %s bytes: "
                        "%s agencies, %s routes, %s stops, %s trips, "
                        "%s stop times, %s shape points",
                        result.feed_version_id,
                        byte_count,
                        result.agencies,
                        result.routes,
                        result.stops,
                        result.trips,
                        result.stop_times,
                        result.shape_points,
                    )
                else:
                    logger.info(
                        "static GTFS unchanged; feed version %s remains active",
                        result.feed_version_id,
                    )
                if result.pruned_stop_times:
                    logger.info(
                        "pruned %s stop times belonging to inactive static feeds",
                        result.pruned_stop_times,
                    )
            except Exception as error:
                duration_ms = int((time.monotonic() - started) * 1_000)
                logger.error("static GTFS refresh failed: %s", error)
                await self.record_fetch(
                    "nta_static_gtfs",
                    0,
                    "failed",
                    error=str(error),
                    duration_ms=duration_ms,
                )
            finally:
                if feed_file is not None:
                    feed_file.close()

    async def _active_feed_version_id(self) -> int | None:
        async with self.pool.connection() as connection:
            cursor = await connection.execute(
                """SELECT id
                   FROM transit_feed_versions
                   WHERE source = %s AND is_active = TRUE AND imported_at IS NOT NULL
                   ORDER BY imported_at DESC, id DESC
                   LIMIT 1""",
                (FEED_SOURCE,),
            )
            row = await cursor.fetchone()
            return int(row[0]) if row is not None else None

    async def _load_active_bus_ids(self, feed_version_id: int) -> ActiveBusIds:
        cached = self._active_bus_ids_cache
        if cached is not None and cached.feed_version_id == feed_version_id:
            return cached

        async with self.pool.connection() as connection:
            route_cursor = await connection.execute(
                """SELECT route_id
                   FROM bus_routes
                   WHERE feed_version_id = %s AND route_type = 3""",
                (feed_version_id,),
            )
            route_ids = frozenset(str(row[0]) for row in await route_cursor.fetchall())
            trip_cursor = await connection.execute(
                """SELECT trip.trip_id, trip.route_id
                   FROM bus_trips AS trip
                   JOIN bus_routes AS route
                     ON route.feed_version_id = trip.feed_version_id
                    AND route.route_id = trip.route_id
                   WHERE trip.feed_version_id = %s AND route.route_type = 3""",
                (feed_version_id,),
            )
            trip_routes = {
                str(row[0]): str(row[1]) for row in await trip_cursor.fetchall()
            }

        loaded = ActiveBusIds(feed_version_id, route_ids, trip_routes)
        self._active_bus_ids_cache = loaded
        logger.info(
            "cached active bus IDs for feed %s: %s routes, %s trips",
            feed_version_id,
            len(route_ids),
            len(trip_routes),
        )
        return loaded

    async def _read_limited_response(self, response: Any, limit: int) -> bytes:
        if response.content_length is not None and response.content_length > limit:
            raise RuntimeError("GTFS-Realtime response exceeds the size limit")
        chunks: list[bytes] = []
        byte_count = 0
        async for chunk in response.content.iter_chunked(256 * 1024):
            byte_count += len(chunk)
            if byte_count > limit:
                raise RuntimeError("GTFS-Realtime response exceeds the size limit")
            chunks.append(chunk)
        return b"".join(chunks)

    async def _reserve_trip_updates_request(self) -> bool:
        """Atomically reserve the NTA token across processes and restarts.

        The reservation happens before network I/O. If a process dies between
        the reservation and request, one poll is lost, but the shared API token
        still cannot exceed NTA's one-request-per-60-seconds ceiling.
        """

        reservation_seconds = self.realtime_interval_seconds + RATE_LIMIT_SAFETY_SECONDS
        async with self.pool.connection() as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """INSERT INTO fetch_schedules
                           (endpoint, interval_seconds, last_fetched, next_fetch,
                            enabled, updated_at)
                       VALUES (%s, %s, clock_timestamp(),
                               clock_timestamp() + (%s * INTERVAL '1 second'),
                               TRUE, clock_timestamp())
                       ON CONFLICT (endpoint) DO UPDATE SET
                           interval_seconds = EXCLUDED.interval_seconds,
                           last_fetched = EXCLUDED.last_fetched,
                           next_fetch = EXCLUDED.next_fetch,
                           updated_at = EXCLUDED.updated_at
                       WHERE fetch_schedules.enabled = TRUE
                         AND (fetch_schedules.next_fetch IS NULL
                              OR fetch_schedules.next_fetch <= clock_timestamp())
                       RETURNING last_fetched""",
                    (
                        "nta_trip_updates",
                        self.realtime_interval_seconds,
                        reservation_seconds,
                    ),
                )
                return await cursor.fetchone() is not None

    async def _insert_trip_updates(
        self,
        feed_version_id: int,
        updates: Sequence[ParsedStopUpdate],
        trip_freshness: Sequence[ParsedTripFreshness],
        fetched_at: datetime,
    ) -> int:
        current: dict[tuple[object, ...], ParsedStopUpdate] = {}
        for update in updates:
            key = (feed_version_id, *update.state_key)
            current[key] = update

        changed = [
            update
            for key, update in current.items()
            if self._previous_update_hashes.get(key) != update.update_hash
        ]
        update_statement = """INSERT INTO bus_stop_updates
            (feed_version_id, entity_id, trip_id, route_id, service_date,
             vehicle_id, trip_instance_key, stop_id, stop_sequence,
             schedule_relationship, arrival_time, departure_time,
             arrival_delay_seconds, departure_delay_seconds, update_hash,
             source_timestamp, fetched_at, last_seen_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s)
            ON CONFLICT (feed_version_id, update_hash) DO UPDATE SET
                last_seen_at = EXCLUDED.last_seen_at,
                source_timestamp = COALESCE(
                    EXCLUDED.source_timestamp, bus_stop_updates.source_timestamp
                )"""

        freshness_statement = """INSERT INTO bus_trip_update_freshness
            (feed_version_id, trip_instance_key, last_seen_at, source_timestamp,
             schedule_relationship)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (feed_version_id, trip_instance_key) DO UPDATE SET
                last_seen_at = EXCLUDED.last_seen_at,
                source_timestamp = COALESCE(
                    EXCLUDED.source_timestamp,
                    bus_trip_update_freshness.source_timestamp
                ),
                schedule_relationship = EXCLUDED.schedule_relationship"""

        if changed or trip_freshness:
            async with self.pool.connection() as connection:
                async with connection.transaction():
                    async with connection.cursor() as cursor:
                        rows = [
                            update.database_row(feed_version_id, fetched_at)
                            for update in changed
                        ]
                        for batch in _chunks(rows, INSERT_BATCH_ROWS):
                            await cursor.executemany(update_statement, batch)

                        freshness_rows = [
                            trip.database_row(feed_version_id, fetched_at)
                            for trip in trip_freshness
                        ]
                        for batch in _chunks(freshness_rows, INSERT_BATCH_ROWS):
                            await cursor.executemany(freshness_statement, batch)

        self._previous_update_hashes = {
            key: update.update_hash for key, update in current.items()
        }
        return len(changed)

    async def _upsert_vehicle_positions(
        self,
        feed_version_id: int,
        positions: Sequence[ParsedVehiclePosition],
        fetched_at: datetime,
    ) -> int:
        """Replace the current FULL_DATASET vehicle snapshot and refresh freshness."""

        current = {
            (feed_version_id, position.vehicle_instance_key): position
            for position in positions
        }
        changed = sum(
            self._previous_vehicle_hashes.get(key) != position.update_hash
            for key, position in current.items()
        )
        statement = """INSERT INTO bus_vehicle_positions
            (feed_version_id, vehicle_instance_key, entity_id, vehicle_id,
             vehicle_label, license_plate, trip_instance_key, trip_id, route_id,
             service_date, schedule_relationship, latitude, longitude, bearing,
             speed, current_stop_sequence, stop_id, current_status,
             congestion_level, occupancy_status, occupancy_percentage,
             update_hash, source_timestamp, fetched_at, last_seen_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (feed_version_id, vehicle_instance_key) DO UPDATE SET
                entity_id = EXCLUDED.entity_id,
                vehicle_id = EXCLUDED.vehicle_id,
                vehicle_label = EXCLUDED.vehicle_label,
                license_plate = EXCLUDED.license_plate,
                trip_instance_key = EXCLUDED.trip_instance_key,
                trip_id = EXCLUDED.trip_id,
                route_id = EXCLUDED.route_id,
                service_date = EXCLUDED.service_date,
                schedule_relationship = EXCLUDED.schedule_relationship,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                bearing = EXCLUDED.bearing,
                speed = EXCLUDED.speed,
                current_stop_sequence = EXCLUDED.current_stop_sequence,
                stop_id = EXCLUDED.stop_id,
                current_status = EXCLUDED.current_status,
                congestion_level = EXCLUDED.congestion_level,
                occupancy_status = EXCLUDED.occupancy_status,
                occupancy_percentage = EXCLUDED.occupancy_percentage,
                source_timestamp = COALESCE(
                    EXCLUDED.source_timestamp,
                    bus_vehicle_positions.source_timestamp
                ),
                fetched_at = CASE
                    WHEN bus_vehicle_positions.update_hash IS DISTINCT FROM
                         EXCLUDED.update_hash THEN EXCLUDED.fetched_at
                    ELSE bus_vehicle_positions.fetched_at
                END,
                update_hash = EXCLUDED.update_hash,
                last_seen_at = EXCLUDED.last_seen_at"""

        async with self.pool.connection() as connection:
            async with connection.transaction():
                async with connection.cursor() as cursor:
                    rows = [
                        position.database_row(feed_version_id, fetched_at)
                        for position in current.values()
                    ]
                    for batch in _chunks(rows, INSERT_BATCH_ROWS):
                        await cursor.executemany(statement, batch)

                current_keys = [key[1] for key in current]
                if current_keys:
                    await connection.execute(
                        """DELETE FROM bus_vehicle_positions
                           WHERE feed_version_id = %s
                             AND NOT (vehicle_instance_key = ANY(%s))""",
                        (feed_version_id, current_keys),
                    )
                else:
                    await connection.execute(
                        "DELETE FROM bus_vehicle_positions WHERE feed_version_id = %s",
                        (feed_version_id,),
                    )

        self._previous_vehicle_hashes = {
            key: position.update_hash for key, position in current.items()
        }
        return changed

    async def _reserve_realtime_retention(self) -> bool:
        async with self.pool.connection() as connection:
            async with connection.transaction():
                reservation = await connection.execute(
                    """INSERT INTO fetch_schedules
                           (endpoint, interval_seconds, last_fetched, next_fetch,
                            enabled, updated_at)
                       VALUES (%s, %s, clock_timestamp(),
                               clock_timestamp() + (%s * INTERVAL '1 second'),
                               TRUE, clock_timestamp())
                       ON CONFLICT (endpoint) DO UPDATE SET
                           interval_seconds = EXCLUDED.interval_seconds,
                           last_fetched = EXCLUDED.last_fetched,
                           next_fetch = EXCLUDED.next_fetch,
                           updated_at = EXCLUDED.updated_at
                       WHERE fetch_schedules.enabled = TRUE
                         AND (fetch_schedules.next_fetch IS NULL
                              OR fetch_schedules.next_fetch <= clock_timestamp())
                       RETURNING last_fetched""",
                    (
                        "nta_realtime_retention",
                        REALTIME_RETENTION_INTERVAL_SECONDS,
                        REALTIME_RETENTION_INTERVAL_SECONDS,
                    ),
                )
                return await reservation.fetchone() is not None

    async def _prune_realtime_history_if_due(self) -> tuple[int, int, int]:
        """Bound realtime storage, reserving maintenance at most once per day.

        The latest state for each stop on a currently fresh trip is retained
        even if unchanged for longer than the history window. Older states are
        still pruned, so a malformed long-lived trip cannot grow without bound.
        Once a trip leaves the full feed, its final state becomes eligible too.

        The reservation commits before the heavier deletes. A crash can delay
        pruning until the next day, but cannot make every minute retry a failing
        maintenance query.
        """

        if not await self._reserve_realtime_retention():
            return (0, 0, 0)

        async with self.pool.connection() as connection:
            async with connection.transaction():
                stop_cursor = await connection.execute(
                    """WITH protected_current_states AS MATERIALIZED (
                           SELECT DISTINCT ON (
                               state.feed_version_id,
                               state.trip_instance_key,
                               CASE
                                   WHEN state.stop_sequence IS NOT NULL
                                       THEN 'sequence:' || state.stop_sequence::text
                                   WHEN state.stop_id IS NOT NULL
                                       THEN 'stop_id:' || state.stop_id
                                   ELSE 'unknown'
                               END
                           ) state.id
                           FROM bus_stop_updates AS state
                           JOIN bus_trip_update_freshness AS current_trip
                             ON current_trip.feed_version_id =
                                state.feed_version_id
                            AND current_trip.trip_instance_key =
                                state.trip_instance_key
                           WHERE current_trip.last_seen_at >=
                                 clock_timestamp() - (%s * INTERVAL '1 day')
                           ORDER BY
                               state.feed_version_id,
                               state.trip_instance_key,
                               CASE
                                   WHEN state.stop_sequence IS NOT NULL
                                       THEN 'sequence:' || state.stop_sequence::text
                                   WHEN state.stop_id IS NOT NULL
                                       THEN 'stop_id:' || state.stop_id
                                   ELSE 'unknown'
                               END,
                               state.last_seen_at DESC,
                               state.id DESC
                       )
                       DELETE FROM bus_stop_updates AS old_update
                       WHERE old_update.last_seen_at <
                             clock_timestamp() - (%s * INTERVAL '1 day')
                         AND NOT EXISTS (
                             SELECT 1 FROM protected_current_states
                             WHERE protected_current_states.id = old_update.id
                         )""",
                    (self.realtime_retention_days, self.realtime_retention_days),
                )
                freshness_cursor = await connection.execute(
                    """DELETE FROM bus_trip_update_freshness AS old_trip
                       WHERE old_trip.last_seen_at <
                             clock_timestamp() - (%s * INTERVAL '1 day')
                         AND NOT EXISTS (
                             SELECT 1 FROM bus_stop_updates AS remaining_update
                             WHERE remaining_update.feed_version_id =
                                   old_trip.feed_version_id
                               AND remaining_update.trip_instance_key =
                                   old_trip.trip_instance_key
                         )""",
                    (self.realtime_retention_days,),
                )
                vehicle_cursor = await connection.execute(
                    """DELETE FROM bus_vehicle_positions
                       WHERE last_seen_at <
                             clock_timestamp() - (%s * INTERVAL '1 day')""",
                    (self.realtime_retention_days,),
                )
                return (
                    max(0, stop_cursor.rowcount),
                    max(0, freshness_cursor.rowcount),
                    max(0, vehicle_cursor.rowcount),
                )

    async def poll_trip_updates(self) -> None:
        """Poll the combined feed; retain the legacy method name for callers."""

        if self.api_key is None:
            return

        started = time.monotonic()
        async with self._feed_lock:
            try:
                feed_version_id = await self._active_feed_version_id()
                if feed_version_id is None:
                    raise RuntimeError("no imported static GTFS version is active")
                bus_ids = await self._load_active_bus_ids(feed_version_id)
                if not await self._reserve_trip_updates_request():
                    logger.info(
                        "GTFS-Realtime request not due according to shared rate limit"
                    )
                    return

                headers = {
                    "x-api-key": self.api_key,
                    "Accept": "application/json",
                }
                timeout = aiohttp.ClientTimeout(total=30, connect=10, sock_read=20)
                async with self.session.get(
                    self.realtime_url, headers=headers, timeout=timeout
                ) as response:
                    if response.status != 200:
                        raise RuntimeError(
                            f"GTFS-Realtime returned HTTP {response.status}"
                        )
                    payload = await self._read_limited_response(
                        response, MAX_REALTIME_DOWNLOAD_BYTES
                    )
                fetched_at = datetime.now(tz=UTC)
                parsed_feed = parse_realtime_feed(payload)
                if parsed_feed.incrementality != "FULL_DATASET":
                    raise FeedFormatError(
                        "NTA GTFS-Realtime must be a FULL_DATASET feed; "
                        f"received {parsed_feed.incrementality!r}"
                    )
                bus_feed = filter_bus_realtime_feed(parsed_feed, bus_ids)
                inserted = await self._insert_trip_updates(
                    feed_version_id,
                    bus_feed.stop_updates,
                    bus_feed.trip_freshness,
                    fetched_at,
                )
                changed_vehicles = await self._upsert_vehicle_positions(
                    feed_version_id,
                    bus_feed.vehicle_positions,
                    fetched_at,
                )
                try:
                    pruned = await self._prune_realtime_history_if_due()
                    if any(pruned):
                        logger.info(
                            "realtime retention pruned %s stop states, %s trip "
                            "freshness rows, and %s vehicle positions",
                            *pruned,
                        )
                except Exception as maintenance_error:
                    # Ingestion succeeded. The committed daily reservation
                    # prevents a failing maintenance query from running every minute.
                    logger.warning(
                        "realtime retention maintenance failed: %s",
                        maintenance_error,
                    )
                duration_ms = int((time.monotonic() - started) * 1_000)
                await self.record_fetch(
                    "nta_trip_updates",
                    inserted + changed_vehicles,
                    "success",
                    duration_ms=duration_ms,
                )
                logger.info(
                    "GTFS-Realtime: %s/%s bus stop updates and %s/%s bus "
                    "vehicles; %s new stop states and %s changed vehicles",
                    len(bus_feed.stop_updates),
                    len(parsed_feed.stop_updates),
                    len(bus_feed.vehicle_positions),
                    len(parsed_feed.vehicle_positions),
                    inserted,
                    changed_vehicles,
                )
            except Exception as error:
                duration_ms = int((time.monotonic() - started) * 1_000)
                logger.error("GTFS-Realtime poll failed: %s", error)
                await self.record_fetch(
                    "nta_trip_updates",
                    0,
                    "failed",
                    error=str(error),
                    duration_ms=duration_ms,
                )

    async def schedule_task(
        self,
        name: str,
        function: Any,
        interval_seconds: int,
        *,
        initial_delay: bool = False,
    ) -> None:
        logger.info("starting %s task every %ss", name, interval_seconds)
        if initial_delay:
            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=interval_seconds)
                return
            except asyncio.TimeoutError:
                pass

        while not self._shutdown.is_set():
            try:
                await function()
            except Exception as error:
                logger.error("%s task failed: %s", name, error)

            try:
                await asyncio.wait_for(self._shutdown.wait(), timeout=interval_seconds)
            except asyncio.TimeoutError:
                continue
            break

    async def run(self) -> None:
        startup_task: asyncio.Task[None] | None = None
        shutdown_waiter: asyncio.Task[bool] | None = None
        workers: list[asyncio.Task[None]] = []
        try:
            await self.init()
            self._install_signal_handlers()
            startup_task = asyncio.create_task(self.refresh_static_feed())
            shutdown_waiter = asyncio.create_task(self._shutdown.wait())
            completed, _pending = await asyncio.wait(
                (startup_task, shutdown_waiter),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if shutdown_waiter in completed:
                return

            await startup_task
            startup_task = None
            if self._shutdown.is_set():
                return

            workers = [
                asyncio.create_task(
                    self.schedule_task(
                        "static GTFS",
                        self.refresh_static_feed,
                        self.static_refresh_seconds,
                        initial_delay=True,
                    )
                )
            ]
            if self.api_key is None:
                logger.info("NTA_API_KEY is absent; running in static-only mode")
            else:
                workers.append(
                    asyncio.create_task(
                        self.schedule_task(
                            "GTFS-Realtime",
                            self.poll_trip_updates,
                            self.realtime_interval_seconds,
                        )
                    )
                )
            await shutdown_waiter
        finally:
            active_tasks = [
                task
                for task in (startup_task, shutdown_waiter, *workers)
                if task is not None and not task.done()
            ]
            for task in active_tasks:
                task.cancel()
            if active_tasks:
                await asyncio.gather(*active_tasks, return_exceptions=True)
            await self.close()


def _positive_int_environment(name: str, default: int) -> int:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        value = int(raw_value)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value


def _realtime_url_from_environment() -> str:
    """Prefer the combined-feed setting, then the legacy TripUpdates setting."""

    return (
        os.getenv("NTA_GTFSR_URL")
        or os.getenv("NTA_TRIP_UPDATES_URL")
        or DEFAULT_REALTIME_URL
    )


async def main() -> None:
    daemon = NtaBusDaemon(
        os.environ["DATABASE_URL"],
        api_key=os.getenv("NTA_API_KEY"),
        gtfs_url=os.getenv("NTA_GTFS_URL", DEFAULT_GTFS_URL),
        trip_updates_url=_realtime_url_from_environment(),
        static_refresh_seconds=_positive_int_environment(
            "BUS_STATIC_REFRESH_SECONDS", DEFAULT_STATIC_REFRESH_SECONDS
        ),
        realtime_interval_seconds=_positive_int_environment(
            "BUS_REALTIME_INTERVAL_SECONDS", MIN_REALTIME_INTERVAL_SECONDS
        ),
        realtime_retention_days=_positive_int_environment(
            "BUS_REALTIME_RETENTION_DAYS", DEFAULT_REALTIME_RETENTION_DAYS
        ),
    )
    await daemon.run()


if __name__ == "__main__":
    asyncio.run(main())
