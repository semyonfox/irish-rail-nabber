import { useEffect, useMemo, useState } from "react";
import { DELAY_HISTORY } from "../graphql/queries";
import { usePollingQuery } from "./usePollingQuery";

export interface StoredDelayPoint {
  bucket: string;
  avgLateMinutes: number;
  p95LateMinutes: number;
  maxLateMinutes: number;
  onTimePct: number;
  eventCount: number;
}

interface DelayHistoryData {
  delayHistory: StoredDelayPoint[];
}

const DB_NAME = "irish-rail-history";
const STORE_NAME = "snapshots";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readSnapshot(scope: string): Promise<StoredDelayPoint[]> {
  const database = await openDatabase();
  return new Promise<StoredDelayPoint[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(scope);
    request.onsuccess = () =>
      resolve((request.result as StoredDelayPoint[] | undefined) ?? []);
    request.onerror = () => reject(request.error);
  }).finally(() => database.close());
}

async function writeSnapshot(scope: string, points: StoredDelayPoint[]) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(points, scope);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  }).finally(() => database.close());
}

function mergePoints(current: StoredDelayPoint[], incoming: StoredDelayPoint[]) {
  const byBucket = new Map(current.map((point) => [point.bucket, point]));
  for (const point of incoming) byBucket.set(point.bucket, point);
  return [...byBucket.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}

export function useHistorySync(stationCode?: string) {
  const scope = stationCode || "network";
  const [points, setPoints] = useState<StoredDelayPoint[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [cursor, setCursor] = useState<string>();

  useEffect(() => {
    let active = true;
    setLoaded(false);
    readSnapshot(scope)
      .catch(() => [])
      .then((stored) => {
        if (!active) return;
        setPoints(stored);
        setCursor(stored.at(-1)?.bucket);
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [scope]);

  const [{ data, fetching, error }, retry] = usePollingQuery<DelayHistoryData>({
    query: DELAY_HISTORY,
    variables: { stationCode, hours: 0, bucket: "hour", since: cursor },
    pause: !loaded,
    pollInterval: 300000,
  });

  useEffect(() => {
    if (!data?.delayHistory) return;
    setPoints((current) => {
      const merged = mergePoints(current, data.delayHistory);
      void writeSnapshot(scope, merged).catch(() => undefined);
      setCursor(merged.at(-1)?.bucket);
      return merged;
    });
  }, [data?.delayHistory, scope]);

  return useMemo(
    () => ({ points, fetching: !loaded || fetching, error, retry }),
    [error, fetching, loaded, points, retry],
  );
}
