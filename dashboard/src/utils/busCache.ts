const DB_NAME = "irish-bus-cache";
const STORE = "snapshots";
const MAX_ENTRIES = 64;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface BusSnapshot<Data> {
  savedAt: number;
  data: Data;
}

export function decodeBusSnapshot<Data>(
  value: unknown,
  validate: (data: unknown) => data is Data,
  now = Date.now(),
): BusSnapshot<Data> | undefined {
  if (!value || typeof value !== "object" || !("savedAt" in value) || !("data" in value)) return;
  if (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt)) return;
  if (value.savedAt > now || now - value.savedAt > MAX_AGE_MS || !validate(value.data)) return;
  return { savedAt: value.savedAt, data: value.data };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE).createIndex("savedAt", "savedAt");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readBusSnapshot(key: string): Promise<unknown> {
  const db = await openDatabase();
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}

export async function writeBusSnapshot<Data>(key: string, snapshot: BusSnapshot<Data>) {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(snapshot, key);
    // Retain the newest 64 scopes, so route browsing cannot grow storage forever.
    let count = 0;
    const cursor = store.index("savedAt").openCursor(null, "prev");
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      count += 1;
      if (count > MAX_ENTRIES) entry.delete();
      entry.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}
