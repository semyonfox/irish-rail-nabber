import copy
from pathlib import Path
import tempfile
import unittest

from import_bus_performance import decode_rows, normalize, write_sql


def payload(rows, dictionary=None):
    return {"results": [{"result": {"data": {
        "descriptor": {"Select": [{"Name": "route", "Value": "G0"}, {"Name": "delay", "Value": "M0"}]},
        "dsr": {"DS": [{"IC": True, "PH": [{"DM0": rows}], "ValueDicts": {"D0": dictionary or ["409"]}}]},
    }}}]}


class PublishedImportTests(unittest.TestCase):
    def test_dictionary_inline_strings_repeats_and_nulls(self):
        data = payload([
            {"S": [{"N": "G0", "DN": "D0"}, {"N": "M0"}], "C": [0, "1.26"]},
            {"C": [2.0], "R": 1},
            {"C": ["323X"], "Ø": 2},
            {"C": [3.0], "R": 1},
        ])
        self.assertEqual(decode_rows(data, ["route", "delay"]), [
            {"route": "409", "delay": "1.26"}, {"route": "409", "delay": 2.0},
            {"route": "323X", "delay": None}, {"route": "323X", "delay": 3.0},
        ])

    def test_refuses_truncated_or_changed_source(self):
        data = payload([{"S": [{"N": "G0", "DN": "D0"}, {"N": "M0"}], "C": [0, 1]}])
        broken = copy.deepcopy(data)
        broken["results"][0]["result"]["data"]["dsr"]["DS"][0]["RT"] = ["next-page"]
        with self.assertRaisesRegex(ValueError, "Truncated"):
            decode_rows(broken, ["route", "delay"])
        with self.assertRaisesRegex(ValueError, "columns changed"):
            decode_rows(data, ["delay", "route"])
        data["results"][0]["result"]["data"]["dsr"]["DS"][0]["PH"][0]["DM0"][0]["C"] = [0]
        with self.assertRaisesRegex(ValueError, "missing values"):
            decode_rows(data, ["route", "delay"])

    def test_merges_contract_aliases_and_keeps_missing_distinct_from_zero(self):
        base = {"Operator": "Bus Éireann DAC", "Line": "409", "Year": 2025, "Period": "Period 1"}
        records = normalize({
            "lf": [{**base, "on_time_pct": 0, "early_pct": 0, "late_pct": 0, "actual_departures": 0}],
            "ewt": [{**base, "Operator": "Bus Éireann", "Period": "P01", "excess_wait_minutes": 0}],
            "lost": [{**base, "planned_km": 100, "lost_km": 0}],
        })
        self.assertEqual(len(records), 1)
        self.assertIsNone(records[0]["on_time_pct"])
        self.assertEqual(records[0]["excess_wait_minutes"], 0)
        self.assertEqual(records[0]["report_period"], 1)
        measured = normalize({"lf": [{**base, "on_time_pct": 0, "actual_departures": 100}]})
        self.assertEqual(measured[0]["on_time_pct"], 0)
        measured = normalize({"lf": [{**base, "on_time_pct": .81, "actual_departures": 100}]})
        self.assertEqual(measured[0]["on_time_pct"], 81)

    def test_rejects_ambiguous_duplicates_and_invalid_metrics(self):
        row = {"Operator": "Dublin Bus", "Line": "4", "Year": 2025, "Period": "P01", "actual_departures": 100, "on_time_pct": .8}
        for rows in [[row, row], [{**row, "on_time_pct": 80}], [{**row, "on_time_pct": float("nan")}], [{**row, "Period": "P14"}]]:
            with self.assertRaises(ValueError):
                normalize({"lf": rows})

    def test_identity_depends_on_records_and_preserves_source_payload(self):
        row = {"operator_name": "Test ' contract", "route_short_name": "4", "report_year": 2025, "report_period": 1, "on_time_pct": 80}
        bundle = {"source_updated_at": "2026-08-31T15:40:32.09", "fixture": "original public response"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "import.sql"
            first = write_sql(path, [row], bundle)
            second = write_sql(path, [row], {**bundle, "fixture": "same values, refreshed response"})
            self.assertEqual(first, second)
            self.assertNotEqual(first, write_sql(path, [{**row, "on_time_pct": 81}], bundle))
            text = path.read_text()
            self.assertIn("ON CONFLICT DO NOTHING", text)
            self.assertIn("SET is_active = false WHERE is_active", text)
            self.assertIn("COPY bus_published_stage", text)


# Uses only an explicitly named disposable container; never reads DATABASE_URL.
import os
import subprocess

@unittest.skipUnless(os.environ.get("BUS_PUBLISHED_TEST_CONTAINER") == "irish-rail-bus-backfill-test", "requires a disposable backfill container")
class PublishedDatabaseTests(unittest.TestCase):
    def test_replay_revision_atomic_activation_and_raw_source_recovery(self):
        import gzip
        import json
        container = "irish-rail-bus-backfill-test"
        database = "bus_import_replay_test"
        subprocess.run(["docker", "exec", container, "createdb", "-U", "postgres", database], check=True, capture_output=True)
        def execute(statement):
            result = subprocess.run(["docker", "exec", "-i", container, "psql", "-U", "postgres", "-d", database, "-XAt", "-v", "ON_ERROR_STOP=1"], input=statement, text=True, capture_output=True)
            if result.returncode:
                self.fail(result.stderr)
            return result.stdout.strip()
        try:
            migration = Path("migrations/015_bus_published_performance.sql").read_text()
            execute(migration)
            execute(migration)
            row = {"operator_name": "Test ' contract", "route_short_name": "4,5", "report_year": 2025, "report_period": 1, "on_time_pct": 81, "actual_departures": 100}
            bundle = {"source_updated_at": "2026-08-31T15:40:32.09", "fixture": "complete public source"}
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "import.sql"
                first = write_sql(path, [row], bundle)
                execute(path.read_text())
                execute(path.read_text())
                self.assertEqual(execute("SELECT COUNT(*) FROM bus_published_performance"), "1")
                second = write_sql(path, [{**row, "on_time_pct": 82}], bundle)
                execute(path.read_text())
                self.assertNotEqual(first, second)
                self.assertEqual(execute("SELECT COUNT(*) FROM bus_published_imports WHERE is_active"), "1")
                self.assertEqual(execute("SELECT COUNT(*) FROM bus_published_performance"), "2")
                self.assertEqual(execute("SELECT p.on_time_pct FROM bus_published_performance p JOIN bus_published_imports i USING(import_id) WHERE i.is_active"), "82")
                raw = execute("SELECT encode(raw_payload_gzip,'hex') FROM bus_published_imports WHERE is_active")
                self.assertEqual(json.loads(gzip.decompress(bytes.fromhex(raw))), bundle)
        finally:
            subprocess.run(["docker", "exec", container, "dropdb", "-U", "postgres", database], check=True, capture_output=True)

if __name__ == "__main__":
    unittest.main()
