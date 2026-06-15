"""
comprehensive benchmark of the Irish Rail realtime API
measures response times, change detection, and server-side refresh patterns
"""

import asyncio
import aiohttp
import hashlib
import re
import statistics
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass, field

API_BASE = "http://api.irishrail.ie/realtime/realtime.asmx"
ROUNDS = 60
INTERVAL = 3.0
STATION_SEMAPHORE_LIMIT = 30

# regex to strip server/query time tags that change every second
TIMESTAMP_RE = re.compile(r"<(?:Servertime|Querytime)>[^<]*</(?:Servertime|Querytime)>")


@dataclass
class EndpointStats:
    name: str
    response_times: list = field(default_factory=list)
    hashes: list = field(default_factory=list)
    changes: int = 0
    polls: int = 0
    errors: int = 0


@dataclass
class StationBoardStats:
    response_times: list = field(default_factory=list)
    polls: int = 0
    errors: int = 0
    stations_changed_per_round: list = field(default_factory=list)
    per_station_hashes: dict = field(default_factory=dict)
    per_station_changes: dict = field(default_factory=lambda: defaultdict(int))


@dataclass
class HaconStats:
    response_times: list = field(default_factory=list)
    hashes: list = field(default_factory=list)
    changes: int = 0
    polls: int = 0
    errors: int = 0
    # per-train tracking
    per_train_gps: dict = field(default_factory=lambda: defaultdict(list))  # train_code -> [(round, lat, lon)]
    per_train_lastloc: dict = field(default_factory=lambda: defaultdict(list))  # train_code -> [(round, val)]
    per_train_diff: dict = field(default_factory=lambda: defaultdict(list))  # train_code -> [(round, val)]
    per_train_types: dict = field(default_factory=dict)  # train_code -> type
    per_train_has_gps: dict = field(default_factory=lambda: defaultdict(bool))


def content_hash(text: str) -> str:
    cleaned = TIMESTAMP_RE.sub("", text)
    return hashlib.sha256(cleaned.encode()).hexdigest()


async def fetch(session: aiohttp.ClientSession, url: str, params: dict = None) -> tuple[str, float]:
    """fetch a URL, return (response_text, elapsed_ms)"""
    t0 = time.monotonic()
    async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=30)) as resp:
        text = await resp.text()
        elapsed = (time.monotonic() - t0) * 1000
        return text, elapsed


async def fetch_station_list(session: aiohttp.ClientSession) -> list[tuple[str, str]]:
    """get all station codes and names"""
    text, _ = await fetch(session, f"{API_BASE}/getAllStationsXML")
    root = ET.fromstring(text)
    ns = {"ir": "http://api.irishrail.ie/realtime/"}
    stations = []
    for obj in root.findall("ir:objStation", ns):
        code = obj.find("ir:StationCode", ns)
        name = obj.find("ir:StationDesc", ns)
        if code is not None and code.text:
            stations.append((code.text.strip(), name.text.strip() if name is not None and name.text else code.text.strip()))
    return stations


async def find_running_trains(session: aiohttp.ClientSession, count: int = 3) -> list[tuple[str, str]]:
    """find running trains (status=R) for movement tracking"""
    text, _ = await fetch(session, f"{API_BASE}/getCurrentTrainsXML")
    root = ET.fromstring(text)
    ns = {"ir": "http://api.irishrail.ie/realtime/"}
    running = []
    for obj in root.findall("ir:objTrainPositions", ns):
        status = obj.find("ir:TrainStatus", ns)
        code = obj.find("ir:TrainCode", ns)
        date = obj.find("ir:TrainDate", ns)
        if status is not None and status.text == "R" and code is not None:
            train_code = code.text.strip()
            train_date = date.text.strip() if date is not None and date.text else ""
            running.append((train_code, train_date))
            if len(running) >= count:
                break
    return running


def infer_train_type(code: str) -> str:
    """infer train type from code prefix: A=Mainline, D=Mainline, E=DART, P=Suburban etc"""
    if not code:
        return "?"
    prefix = code[0].upper()
    # Irish Rail convention: E=DART, P=Suburban/Commuter, A/D/B=Mainline
    if prefix == "E":
        return "D"  # DART
    elif prefix == "P":
        return "S"  # Suburban
    else:
        return "M"  # Mainline (A, D, B, etc.)


def parse_hacon_trains(xml_text: str) -> dict:
    """parse HACON train data into per-train records
    note: HACON uses objHaconPositions (not objTrainPositions) and has no TrainType field
    """
    root = ET.fromstring(xml_text)
    ns = {"ir": "http://api.irishrail.ie/realtime/"}
    trains = {}
    for obj in root.findall("ir:objHaconPositions", ns):
        code_el = obj.find("ir:TrainCode", ns)
        if code_el is None or not code_el.text:
            continue
        code = code_el.text.strip()

        def get(tag):
            el = obj.find(f"ir:{tag}", ns)
            return el.text.strip() if el is not None and el.text else ""

        trains[code] = {
            "lat": get("TrainLatitude"),
            "lon": get("TrainLongitude"),
            "last_location": get("LastLocation"),
            "next_location": get("NextLocation"),
            "difference": get("Difference"),
            "type": infer_train_type(code),
            "status": get("TrainStatus"),
            "direction": get("Direction"),
        }
    return trains


async def poll_endpoint(session: aiohttp.ClientSession, url: str, params: dict = None) -> tuple[str, float]:
    """poll a single endpoint, return (text, ms)"""
    return await fetch(session, url, params)


async def poll_station_boards(
    session: aiohttp.ClientSession,
    stations: list[tuple[str, str]],
    semaphore: asyncio.Semaphore,
    prev_hashes: dict,
) -> tuple[float, int, dict, int]:
    """poll all station boards concurrently, return (total_ms, changed_count, new_hashes, error_count)"""

    async def fetch_one(code: str):
        async with semaphore:
            try:
                text, ms = await fetch(
                    session,
                    f"{API_BASE}/getStationDataByCodeXML",
                    {"StationCode": code},
                )
                return code, text, ms, None
            except Exception as e:
                return code, None, 0, str(e)

    t0 = time.monotonic()
    tasks = [fetch_one(code) for code, _ in stations]
    results = await asyncio.gather(*tasks)
    total_ms = (time.monotonic() - t0) * 1000

    new_hashes = {}
    changed = 0
    errors = 0
    for code, text, ms, err in results:
        if err:
            errors += 1
            continue
        h = content_hash(text)
        new_hashes[code] = h
        if code in prev_hashes and prev_hashes[code] != h:
            changed += 1

    return total_ms, changed, new_hashes, errors


async def main():
    print("=" * 80)
    print("IRISH RAIL API BENCHMARK")
    print(f"rounds: {ROUNDS}, interval: {INTERVAL}s, station concurrency: {STATION_SEMAPHORE_LIMIT}")
    print("=" * 80)

    async with aiohttp.ClientSession() as session:
        # -- setup phase --
        print("\n[setup] fetching station list...")
        stations = await fetch_station_list(session)
        print(f"  found {len(stations)} stations")

        print("[setup] finding running trains for movement tracking...")
        running_trains = await find_running_trains(session, count=3)
        if running_trains:
            print(f"  tracking movements for: {[t[0] for t in running_trains]}")
        else:
            print("  WARNING: no running trains found, movement tracking will be skipped")

        # -- init stats --
        current_trains = EndpointStats(name="getCurrentTrainsXML")
        hacon_stats = HaconStats()
        by_type = {
            "D": EndpointStats(name="getCurrentTrainsXML_WithTrainType (DART)"),
            "M": EndpointStats(name="getCurrentTrainsXML_WithTrainType (Mainline)"),
            "S": EndpointStats(name="getCurrentTrainsXML_WithTrainType (Suburban)"),
        }
        station_stats = StationBoardStats()
        movement_stats = {
            code: EndpointStats(name=f"getTrainMovementsXML ({code})")
            for code, _ in running_trains
        }

        semaphore = asyncio.Semaphore(STATION_SEMAPHORE_LIMIT)
        prev_station_hashes = {}

        print(f"\n[benchmark] starting {ROUNDS} rounds...\n")

        for round_num in range(1, ROUNDS + 1):
            round_start = time.monotonic()
            tasks = {}

            # 1. getCurrentTrainsXML
            tasks["current"] = poll_endpoint(session, f"{API_BASE}/getCurrentTrainsXML")

            # 2. getHaconTrainsXML
            tasks["hacon"] = poll_endpoint(session, f"{API_BASE}/getHaconTrainsXML")

            # 3. by-type
            for t in ("D", "M", "S"):
                tasks[f"type_{t}"] = poll_endpoint(
                    session,
                    f"{API_BASE}/getCurrentTrainsXML_WithTrainType",
                    {"TrainType": t},
                )

            # 5. movements
            for code, date in running_trains:
                tasks[f"move_{code}"] = poll_endpoint(
                    session,
                    f"{API_BASE}/getTrainMovementsXML",
                    {"TrainId": code, "TrainDate": date},
                )

            # fire all non-station tasks + station boards concurrently
            non_station_keys = list(tasks.keys())
            non_station_coros = [tasks[k] for k in non_station_keys]

            station_coro = poll_station_boards(session, stations, semaphore, prev_station_hashes)

            all_results = await asyncio.gather(*non_station_coros, station_coro, return_exceptions=True)

            # unpack non-station results
            for i, key in enumerate(non_station_keys):
                result = all_results[i]
                if isinstance(result, Exception):
                    if key == "current":
                        current_trains.errors += 1
                        current_trains.polls += 1
                    elif key == "hacon":
                        hacon_stats.errors += 1
                        hacon_stats.polls += 1
                    elif key.startswith("type_"):
                        t = key.split("_")[1]
                        by_type[t].errors += 1
                        by_type[t].polls += 1
                    elif key.startswith("move_"):
                        code = key[5:]
                        movement_stats[code].errors += 1
                        movement_stats[code].polls += 1
                    print(f"  round {round_num}: ERROR on {key}: {result}")
                    continue

                text, ms = result

                if key == "current":
                    current_trains.polls += 1
                    current_trains.response_times.append(ms)
                    h = content_hash(text)
                    if current_trains.hashes and current_trains.hashes[-1] != h:
                        current_trains.changes += 1
                    current_trains.hashes.append(h)

                elif key == "hacon":
                    hacon_stats.polls += 1
                    hacon_stats.response_times.append(ms)
                    h = content_hash(text)
                    if hacon_stats.hashes and hacon_stats.hashes[-1] != h:
                        hacon_stats.changes += 1
                    hacon_stats.hashes.append(h)
                    # parse per-train data
                    try:
                        trains = parse_hacon_trains(text)
                        for tcode, tdata in trains.items():
                            hacon_stats.per_train_types[tcode] = tdata["type"]
                            lat, lon = tdata["lat"], tdata["lon"]
                            has_gps = bool(lat and lon and lat != "0" and lon != "0")
                            hacon_stats.per_train_has_gps[tcode] = has_gps
                            hacon_stats.per_train_gps[tcode].append((round_num, lat, lon))
                            hacon_stats.per_train_lastloc[tcode].append((round_num, tdata["last_location"]))
                            hacon_stats.per_train_diff[tcode].append((round_num, tdata["difference"]))
                    except Exception as e:
                        print(f"  round {round_num}: HACON parse error: {e}")

                elif key.startswith("type_"):
                    t = key.split("_")[1]
                    by_type[t].polls += 1
                    by_type[t].response_times.append(ms)
                    h = content_hash(text)
                    if by_type[t].hashes and by_type[t].hashes[-1] != h:
                        by_type[t].changes += 1
                    by_type[t].hashes.append(h)

                elif key.startswith("move_"):
                    code = key[5:]
                    movement_stats[code].polls += 1
                    movement_stats[code].response_times.append(ms)
                    h = content_hash(text)
                    if movement_stats[code].hashes and movement_stats[code].hashes[-1] != h:
                        movement_stats[code].changes += 1
                    movement_stats[code].hashes.append(h)

            # unpack station board result
            station_result = all_results[-1]
            if isinstance(station_result, Exception):
                station_stats.errors += 1
                station_stats.polls += 1
                print(f"  round {round_num}: station boards ERROR: {station_result}")
            else:
                total_ms, changed, new_hashes, errs = station_result
                station_stats.polls += 1
                station_stats.response_times.append(total_ms)
                station_stats.errors += errs
                # only count changes after first round (need baseline)
                if prev_station_hashes:
                    station_stats.stations_changed_per_round.append(changed)
                    for code, h in new_hashes.items():
                        if code in prev_station_hashes and prev_station_hashes[code] != h:
                            station_stats.per_station_changes[code] += 1
                prev_station_hashes = new_hashes

            # progress
            elapsed = (time.monotonic() - round_start) * 1000
            hacon_change = "CHG" if hacon_stats.hashes and len(hacon_stats.hashes) > 1 and hacon_stats.hashes[-1] != hacon_stats.hashes[-2] else "---"
            current_change = "CHG" if current_trains.hashes and len(current_trains.hashes) > 1 and current_trains.hashes[-1] != current_trains.hashes[-2] else "---"
            stn_changed = station_stats.stations_changed_per_round[-1] if station_stats.stations_changed_per_round else 0
            print(
                f"  round {round_num:3d}/{ROUNDS} | "
                f"elapsed {elapsed:7.0f}ms | "
                f"current:{current_change} hacon:{hacon_change} | "
                f"stations changed: {stn_changed:3d}/{len(stations)}"
            )

            # wait for next interval
            if round_num < ROUNDS:
                sleep_time = max(0, INTERVAL - (time.monotonic() - round_start))
                await asyncio.sleep(sleep_time)

    # ========== REPORT ==========
    print("\n" + "=" * 80)
    print("BENCHMARK REPORT")
    print("=" * 80)

    def print_endpoint_stats(stats: EndpointStats):
        print(f"\n--- {stats.name} ---")
        if not stats.response_times:
            print("  no data collected")
            return
        times = stats.response_times
        print(f"  polls: {stats.polls} | errors: {stats.errors}")
        if len(times) > 1:
            print(
                f"  response time (ms): "
                f"min={min(times):.0f}  max={max(times):.0f}  "
                f"avg={statistics.mean(times):.0f}  stddev={statistics.stdev(times):.0f}"
            )
        else:
            print(f"  response time (ms): single={times[0]:.0f}")
        print(f"  content changes: {stats.changes}/{stats.polls} ({stats.changes / stats.polls * 100:.1f}%)")
        # detect change intervals
        if stats.hashes and stats.changes > 1:
            change_rounds = []
            for i in range(1, len(stats.hashes)):
                if stats.hashes[i] != stats.hashes[i - 1]:
                    change_rounds.append(i + 1)
            if len(change_rounds) >= 2:
                intervals = [change_rounds[i] - change_rounds[i - 1] for i in range(1, len(change_rounds))]
                if intervals:
                    avg_interval = statistics.mean(intervals) * INTERVAL
                    print(f"  avg change interval: {avg_interval:.1f}s (in rounds: {statistics.mean(intervals):.1f})")

    # 1. getCurrentTrainsXML
    print_endpoint_stats(current_trains)

    # 2. getHaconTrainsXML
    print(f"\n--- getHaconTrainsXML ---")
    if hacon_stats.response_times:
        times = hacon_stats.response_times
        print(f"  polls: {hacon_stats.polls} | errors: {hacon_stats.errors}")
        if len(times) > 1:
            print(
                f"  response time (ms): "
                f"min={min(times):.0f}  max={max(times):.0f}  "
                f"avg={statistics.mean(times):.0f}  stddev={statistics.stdev(times):.0f}"
            )
        else:
            print(f"  response time (ms): single={times[0]:.0f}")
        print(f"  content changes: {hacon_stats.changes}/{hacon_stats.polls} ({hacon_stats.changes / hacon_stats.polls * 100:.1f}%)")

        # change intervals for hacon overall
        if hacon_stats.hashes and hacon_stats.changes > 1:
            change_rounds = []
            for i in range(1, len(hacon_stats.hashes)):
                if hacon_stats.hashes[i] != hacon_stats.hashes[i - 1]:
                    change_rounds.append(i + 1)
            if len(change_rounds) >= 2:
                intervals = [change_rounds[i] - change_rounds[i - 1] for i in range(1, len(change_rounds))]
                if intervals:
                    avg_interval = statistics.mean(intervals) * INTERVAL
                    print(f"  avg change interval: {avg_interval:.1f}s (in rounds: {statistics.mean(intervals):.1f})")

        # per-train analysis
        total_trains_seen = len(hacon_stats.per_train_types)
        gps_trains = sum(1 for v in hacon_stats.per_train_has_gps.values() if v)
        no_gps = total_trains_seen - gps_trains

        type_counts = defaultdict(int)
        type_gps = defaultdict(int)
        for tcode, ttype in hacon_stats.per_train_types.items():
            type_counts[ttype] += 1
            if hacon_stats.per_train_has_gps.get(tcode):
                type_gps[ttype] += 1

        print(f"\n  tracking quality:")
        print(f"    total trains seen: {total_trains_seen}")
        if total_trains_seen:
            print(f"    with GPS: {gps_trains} ({gps_trains/total_trains_seen*100:.0f}%)")
            print(f"    without GPS: {no_gps} ({no_gps/total_trains_seen*100:.0f}%)")

        type_labels = {"D": "DART", "M": "Mainline", "S": "Suburban"}
        print(f"\n  breakdown by type:")
        for t in sorted(type_counts.keys()):
            label = type_labels.get(t, t)
            total = type_counts[t]
            gps = type_gps[t]
            if total:
                print(f"    {label}: {total} trains, {gps} with GPS ({gps/total*100:.0f}%)")

        # per-train GPS update intervals
        print(f"\n  per-train GPS update intervals (trains with >1 GPS change):")
        gps_interval_data = []
        for tcode, entries in hacon_stats.per_train_gps.items():
            change_rounds = []
            for i in range(1, len(entries)):
                r_prev, lat_prev, lon_prev = entries[i - 1]
                r_curr, lat_curr, lon_curr = entries[i]
                if (lat_curr, lon_curr) != (lat_prev, lon_prev):
                    change_rounds.append(r_curr)
            if len(change_rounds) >= 2:
                intervals = [(change_rounds[j] - change_rounds[j-1]) * INTERVAL for j in range(1, len(change_rounds))]
                avg_int = statistics.mean(intervals)
                ttype = hacon_stats.per_train_types.get(tcode, "?")
                gps_interval_data.append((tcode, ttype, len(change_rounds), avg_int, min(intervals), max(intervals)))

        if gps_interval_data:
            gps_interval_data.sort(key=lambda x: x[3])
            print(f"    {'train':<10} {'type':<10} {'changes':>8} {'avg(s)':>8} {'min(s)':>8} {'max(s)':>8}")
            for tcode, ttype, nchanges, avg_int, min_int, max_int in gps_interval_data[:20]:
                label = type_labels.get(ttype, ttype)
                print(f"    {tcode:<10} {label:<10} {nchanges:>8} {avg_int:>8.1f} {min_int:>8.1f} {max_int:>8.1f}")
            if len(gps_interval_data) > 20:
                print(f"    ... and {len(gps_interval_data) - 20} more trains")

            all_avg_intervals = [x[3] for x in gps_interval_data]
            print(f"\n    overall GPS update interval: "
                  f"min={min(all_avg_intervals):.1f}s  max={max(all_avg_intervals):.1f}s  "
                  f"avg={statistics.mean(all_avg_intervals):.1f}s")
        else:
            print("    no trains with >1 GPS change detected")

        # per-train LastLocation update intervals
        print(f"\n  per-train LastLocation update intervals (trains with >1 change):")
        loc_interval_data = []
        for tcode, entries in hacon_stats.per_train_lastloc.items():
            change_rounds = []
            for i in range(1, len(entries)):
                if entries[i][1] != entries[i-1][1]:
                    change_rounds.append(entries[i][0])
            if len(change_rounds) >= 2:
                intervals = [(change_rounds[j] - change_rounds[j-1]) * INTERVAL for j in range(1, len(change_rounds))]
                avg_int = statistics.mean(intervals)
                ttype = hacon_stats.per_train_types.get(tcode, "?")
                loc_interval_data.append((tcode, ttype, len(change_rounds), avg_int))

        if loc_interval_data:
            loc_interval_data.sort(key=lambda x: x[3])
            for tcode, ttype, nchanges, avg_int in loc_interval_data[:15]:
                label = type_labels.get(ttype, ttype)
                print(f"    {tcode:<10} {label:<10} changes={nchanges:>3}  avg_interval={avg_int:.1f}s")
        else:
            print("    no trains with >1 LastLocation change detected")

        # Difference field changes
        print(f"\n  per-train Difference field update intervals (trains with >1 change):")
        diff_interval_data = []
        for tcode, entries in hacon_stats.per_train_diff.items():
            change_rounds = []
            for i in range(1, len(entries)):
                if entries[i][1] != entries[i-1][1]:
                    change_rounds.append(entries[i][0])
            if len(change_rounds) >= 2:
                intervals = [(change_rounds[j] - change_rounds[j-1]) * INTERVAL for j in range(1, len(change_rounds))]
                avg_int = statistics.mean(intervals)
                ttype = hacon_stats.per_train_types.get(tcode, "?")
                diff_interval_data.append((tcode, ttype, len(change_rounds), avg_int))

        if diff_interval_data:
            diff_interval_data.sort(key=lambda x: x[3])
            for tcode, ttype, nchanges, avg_int in diff_interval_data[:15]:
                label = type_labels.get(ttype, ttype)
                print(f"    {tcode:<10} {label:<10} changes={nchanges:>3}  avg_interval={avg_int:.1f}s")
        else:
            print("    no trains with >1 Difference change detected")

    # 3. by-type
    for t in ("D", "M", "S"):
        print_endpoint_stats(by_type[t])

    # 4. station boards
    print(f"\n--- station boards (all {len(stations)} stations) ---")
    if station_stats.response_times:
        times = station_stats.response_times
        print(f"  polls: {station_stats.polls} | errors: {station_stats.errors}")
        if len(times) > 1:
            print(
                f"  total batch time (ms): "
                f"min={min(times):.0f}  max={max(times):.0f}  "
                f"avg={statistics.mean(times):.0f}  stddev={statistics.stdev(times):.0f}"
            )

        if station_stats.stations_changed_per_round:
            changed = station_stats.stations_changed_per_round
            print(f"\n  stations changed per round:")
            if len(changed) > 1:
                print(f"    min={min(changed)}  max={max(changed)}  "
                      f"avg={statistics.mean(changed):.1f}  stddev={statistics.stdev(changed):.1f}")
            else:
                print(f"    single round: {changed[0]}")

            # bulk flush detection (>50% changed at once)
            threshold = len(stations) * 0.5
            flush_rounds = [(i + 2, c) for i, c in enumerate(changed) if c > threshold]
            if flush_rounds:
                print(f"\n  BULK FLUSH detected ({len(flush_rounds)} rounds where >50% stations changed):")
                for rnd, count in flush_rounds:
                    print(f"    round {rnd}: {count}/{len(stations)} stations changed ({count/len(stations)*100:.0f}%)")
            else:
                print(f"\n  no bulk flushes detected (no round with >50% stations changing)")

            # most active stations
            if station_stats.per_station_changes:
                sorted_stations = sorted(station_stats.per_station_changes.items(), key=lambda x: -x[1])
                print(f"\n  most active stations (top 15):")
                for code, changes in sorted_stations[:15]:
                    name = next((n for c, n in stations if c == code), code)
                    print(f"    {code:<12} {name:<30} changes: {changes}")

                total_with_changes = sum(1 for c in station_stats.per_station_changes.values() if c > 0)
                print(f"\n  stations with at least 1 change: {total_with_changes}/{len(stations)} ({total_with_changes/len(stations)*100:.0f}%)")

    # 5. movements
    if movement_stats:
        for code, stats in movement_stats.items():
            print_endpoint_stats(stats)

    # ========== SERVER-SIDE REFRESH PATTERN SUMMARY ==========
    print("\n" + "=" * 80)
    print("SERVER-SIDE REFRESH PATTERN SUMMARY")
    print("=" * 80)

    print("\n  endpoint refresh behavior:")

    summary_items = [
        ("getCurrentTrainsXML", current_trains),
        ("DART trains", by_type["D"]),
        ("Mainline trains", by_type["M"]),
        ("Suburban trains", by_type["S"]),
    ]

    # also treat hacon as an EndpointStats-like for the summary
    class _HaconSummary:
        def __init__(self, hs):
            self.hashes = hs.hashes
            self.changes = hs.changes
            self.polls = hs.polls
    summary_items.insert(1, ("getHaconTrainsXML (overall)", _HaconSummary(hacon_stats)))

    for label, stats_obj in summary_items:
        if stats_obj.hashes and stats_obj.changes > 1:
            change_rounds = []
            for i in range(1, len(stats_obj.hashes)):
                if stats_obj.hashes[i] != stats_obj.hashes[i - 1]:
                    change_rounds.append(i + 1)
            if len(change_rounds) >= 2:
                intervals = [change_rounds[i] - change_rounds[i - 1] for i in range(1, len(change_rounds))]
                avg_int = statistics.mean(intervals) * INTERVAL
                min_int = min(intervals) * INTERVAL
                max_int = max(intervals) * INTERVAL
                mode_rounds = max(set(intervals), key=intervals.count)
                print(f"    {label}:")
                print(f"      changes: {stats_obj.changes}/{stats_obj.polls} polls")
                print(f"      refresh interval: avg={avg_int:.1f}s  min={min_int:.1f}s  max={max_int:.1f}s  mode={mode_rounds * INTERVAL:.1f}s")
            else:
                print(f"    {label}: {stats_obj.changes} change(s) in {stats_obj.polls} polls")
        else:
            print(f"    {label}: {stats_obj.changes} change(s) in {stats_obj.polls} polls")

    if station_stats.stations_changed_per_round:
        changed = station_stats.stations_changed_per_round
        print(f"\n  station board refresh pattern:")
        print(f"    avg stations changing per 3s poll: {statistics.mean(changed):.1f}/{len(stations)}")
        zero_rounds = sum(1 for c in changed if c == 0)
        low_rounds = sum(1 for c in changed if 0 < c <= 10)
        med_rounds = sum(1 for c in changed if 10 < c <= 50)
        high_rounds = sum(1 for c in changed if c > 50)
        print(f"    distribution of changes per round:")
        print(f"      0 stations:     {zero_rounds:3d} rounds ({zero_rounds/len(changed)*100:.0f}%)")
        print(f"      1-10 stations:  {low_rounds:3d} rounds ({low_rounds/len(changed)*100:.0f}%)")
        print(f"      11-50 stations: {med_rounds:3d} rounds ({med_rounds/len(changed)*100:.0f}%)")
        print(f"      >50 stations:   {high_rounds:3d} rounds ({high_rounds/len(changed)*100:.0f}%)")

    if movement_stats:
        print(f"\n  train movement refresh pattern:")
        for code, stats in movement_stats.items():
            if stats.changes > 0:
                print(f"    {code}: {stats.changes} changes in {stats.polls} polls ({stats.changes/stats.polls*100:.0f}%)")
            else:
                print(f"    {code}: no changes detected in {stats.polls} polls")

    print("\n" + "=" * 80)
    print("BENCHMARK COMPLETE")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())
