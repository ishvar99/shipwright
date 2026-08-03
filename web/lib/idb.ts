/**
 * IndexedDB, wrapped in five promises.
 *
 * Not localStorage: a repository's text runs to megabytes and localStorage caps around 5MB
 * (cookies at 4KB). Measured quota in this browser was 10GB. Not a library either — the five
 * operations below are the whole surface this app needs.
 *
 * Every call opens the database. That is deliberate: a cached handle goes stale when another
 * tab triggers an upgrade, and open() on an existing database is microseconds.
 */

const DB = "shipwright";
const VERSION = 1;

export const STORES = ["repos", "files", "jobs"] as const;
export type Store = (typeof STORES)[number];

/** Rejects rather than throws synchronously, so every caller can use one catch. */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb unavailable"));
    // Another tab holds an older version open; without this the promise never settles.
    req.onblocked = () => reject(new Error("Close other Shipwright tabs and reload."));
  });
}

function run<T>(store: Store, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = body(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error ?? new Error("indexeddb write failed"));
        tx.oncomplete = () => db.close();
      }),
  );
}

export const idbGet = <T>(store: Store, key: string) =>
  run<T | undefined>(store, "readonly", (s) => s.get(key));

export const idbAll = <T>(store: Store) => run<T[]>(store, "readonly", (s) => s.getAll());

export const idbPut = (store: Store, key: string, value: unknown) =>
  run<IDBValidKey>(store, "readwrite", (s) => s.put(value, key));

export const idbDel = (store: Store, key: string) =>
  run<undefined>(store, "readwrite", (s) => s.delete(key));

/** One transaction for many rows: a repository import writes hundreds of files, and a
 * transaction each would be hundreds of round trips. */
export function idbBulkPut(store: Store, rows: { key: string; value: unknown }[]): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        for (const r of rows) os.put(r.value, r.key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error("indexeddb bulk write failed"));
        // Quota exceeded surfaces here, not on the individual put.
        tx.onabort = () => reject(tx.error ?? new Error("Not enough browser storage."));
      }),
  );
}

/** Deleting a repository must not leave its files behind — they are the bulk of the quota. */
export function idbDeletePrefix(store: Store, prefix: string): Promise<void> {
  return open().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const os = tx.objectStore(store);
        const req = os.openKeyCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return;
          os.delete(cur.key);
          cur.continue();
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error("indexeddb delete failed"));
      }),
  );
}
