"""Regression coverage for the movement fix recovered from legacy master."""
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

from daemon import IrishRailDaemon


def movement(location, order, arrival="12:00", date="14 Sep 2026"):
    return (
        f"<movement><TrainCode> A1 </TrainCode><TrainDate>{date}</TrainDate>"
        f"<LocationCode>{location}</LocationCode><LocationOrder>{order}</LocationOrder>"
        f"<Arrival>{arrival}</Arrival><StopType>-</StopType></movement>"
    )


def feed(*stops):
    return "<movements>" + "".join(stops) + "</movements>"


class RecordingPool:
    def __init__(self):
        self.rows = []
        self.pending = []
        self.fail_commit = False
        self.fail_after = None

    @asynccontextmanager
    async def connection(self):
        try:
            yield self
        finally:
            self.pending = []

    async def execute(self, _statement, values):
        if self.fail_after == len(self.pending):
            raise RuntimeError("insert failed")
        self.pending.append(values)

    async def commit(self):
        if self.fail_commit:
            raise RuntimeError("commit failed")
        self.rows.extend(self.pending)
        self.pending = []


class MovementDedupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.daemon = IrishRailDaemon("unused")
        self.pool = RecordingPool()
        self.daemon.pool = self.pool
        self.daemon.fetch_api = AsyncMock(return_value=feed(
            movement("cnlly", 1), movement("bray", 2)
        ))

    async def fetch(self):
        return await self.daemon._fetch_train_movements("A1", "14 Sep 2026")

    async def test_only_the_changed_stop_is_inserted(self):
        self.assertEqual(await self.fetch(), 2)
        self.assertEqual(await self.fetch(), -1)
        self.daemon.fetch_api.return_value = feed(
            movement("cnlly", 1), movement("bray", 2, arrival="12:03")
        )
        self.assertEqual(await self.fetch(), 1)
        self.assertEqual(len(self.pool.rows), 3)
        self.assertEqual(self.pool.rows[-1][2], "BRAY")
        self.assertEqual(self.pool.rows[-1][12], "12:03")
        self.assertIsNone(self.pool.rows[-1][16])

    async def test_commit_failure_does_not_suppress_the_retry(self):
        self.pool.fail_commit = True
        self.assertEqual(await self.fetch(), 0)
        self.assertEqual(self.daemon.prev_movement_hashes, {})
        self.assertEqual(self.pool.rows, [])
        self.pool.fail_commit = False
        self.assertEqual(await self.fetch(), 2)

    async def test_insert_failure_does_not_publish_partial_hashes(self):
        self.pool.fail_after = 1
        self.assertEqual(await self.fetch(), 0)
        self.assertEqual(self.daemon.prev_movement_hashes, {})
        self.assertEqual(self.pool.rows, [])
        self.pool.fail_after = None
        self.assertEqual(await self.fetch(), 2)

    async def test_repeated_station_visits_have_separate_hashes(self):
        self.daemon.fetch_api.return_value = feed(
            movement("bray", 1), movement("bray", 3, arrival="12:30")
        )
        self.assertEqual(await self.fetch(), 2)
        self.assertEqual(await self.fetch(), -1)
        self.assertEqual(len(self.daemon.prev_movement_hashes), 2)

    async def test_cleanup_keeps_all_stops_for_active_services(self):
        await self.fetch()
        self.daemon.prev_movement_hashes[("old", "13 Sep 2026", "BRAY", 1)] = "old"
        self.daemon.fetch_api.return_value = (
            "<trains><train><TrainCode> A1 </TrainCode>"
            "<TrainDate>14 Sep 2026</TrainDate></train></trains>"
        )
        await self.daemon.cleanup_stale_hashes()
        self.assertEqual(len(self.daemon.prev_movement_hashes), 2)
        self.assertTrue(all(key[0] == "A1" for key in self.daemon.prev_movement_hashes))


if __name__ == "__main__":
    unittest.main()
