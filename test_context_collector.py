import json
import unittest
from datetime import date, datetime, timezone

from context_collector import (
    parse_archive_header,
    parse_archive_row,
    parse_live_observations,
    parse_tii_daily_class,
    parse_tii_sites,
    parse_tii_week,
    warning_rows,
)


class WeatherParsingTests(unittest.TestCase):
    def test_live_report_time_is_irish_local(self) -> None:
        summer = {"date": "24-07-2026", "reportTime": "19:00", "temperature": "4",
                  "rainfall": " 0.2 ", "windSpeed": "7", "windGust": "-", "humidity": " 98 "}
        (row,) = parse_live_observations(532, [summer, {"date": "garbage"}])

        # 19:00 IST is 18:00 UTC
        self.assertEqual(row[1], datetime(2026, 7, 24, 18, tzinfo=timezone.utc))
        self.assertEqual(row[3], 0.2)
        self.assertIsNone(row[5])
        self.assertEqual(row[7], 98.0)

    def test_live_missing_value_codes_are_not_stored(self) -> None:
        malin = {"date": "25-11-2026", "reportTime": "03:00", "temperature": "-",
                 "humidity": "-99", "weatherDescription": "N/A"}
        (row,) = parse_live_observations(1575, [malin])

        self.assertIsNone(row[2])
        self.assertIsNone(row[7])
        self.assertIsNone(row[10])

    def test_archive_columns_follow_the_header_not_a_fixed_order(self) -> None:
        header = parse_archive_header(
            "date,ind,rain,ind,temp,ind,wetb,dewpt,vappr,rhum,msl,ind,wdsp,ind,wddir,ww,w,sun,vis,clht,clamt\n"
        )
        row = parse_archive_row(
            532, header,
            "01-nov-2026 00:00,2,0.4,0,11.8,0,11.4,11.1,13.2,95,1033.7,2,6,2,310,50,52,0.0,6000,12,7\n",
        )

        self.assertEqual(row[1], datetime(2026, 11, 1, tzinfo=timezone.utc))
        self.assertEqual((row[2], row[3], row[4], row[6], row[7], row[8], row[9]),
                         (11.8, 0.4, 6.0, 310.0, 95.0, 1033.7, 6000.0))
        self.assertIsNone(parse_archive_header("Station Name: DUBLIN AIRPORT"))
        self.assertIsNone(parse_archive_row(532, header, "01-nov-2026 00:00,2\n"))

    def test_warnings_without_an_id_still_get_a_stable_key(self) -> None:
        warning = {"headline": "Wind warning", "onset": "2026-11-25T06:00:00Z", "regions": ["EI07"]}
        self.assertEqual(warning_rows([warning])[0][0], warning_rows([dict(warning)])[0][0])
        self.assertEqual(warning_rows([{**warning, "id": "w1"}])[0][0], "w1")


class TrafficParsingTests(unittest.TestCase):
    def test_tii_speeds_are_converted_from_mm_per_second(self) -> None:
        (site,) = parse_tii_sites({"data": {"a": {
            "id": "a", "cosit": "000000001011", "speedLimit": 22222,
            "location": {"lat": 53.4, "lng": -6.2},
            "parameters": {"category": "Regional", "county": "Dublin"},
        }}})
        self.assertEqual(site[8], 80)

        week = parse_tii_week("a", date(2026, 11, 24), {"data": {
            "sourceDays": {"0": "2026-11-22 00:00:00", "1": "2026-11-17 00:00:00"},
            "speedBins": [None, [0, 4470]],
            "total": {"count": 432858, "averageSpeed": 18146.6, "workDayAverageSpeed": 17896.9},
            "byDirection": [{"direction": 2, "count": 1, "averageSpeed": 19472.9}],
        }})
        self.assertEqual(week[2], ["2026-11-17", "2026-11-22"])
        self.assertEqual(week[4], 65.3)
        self.assertEqual(json.loads(week[7])[0]["avg_kmh"], 70.1)
        self.assertIsNone(parse_tii_week("a", date(2026, 11, 24), {"data": []}))

    def test_bulk_class_csv(self) -> None:
        header = '"cosit","class","year","month","day","VehicleCount"\n'
        rows = parse_tii_daily_class(header + '"000000001012","1","2019","6","1","236"\n')
        self.assertEqual(rows, [("000000001012", date(2019, 6, 1), 1, 236)])
        # a damaged row must fail the whole file, not quietly shrink the day
        with self.assertRaises(ValueError):
            parse_tii_daily_class(header + '"000000001012","x","2019","6","2","236"\n')


if __name__ == "__main__":
    unittest.main()
