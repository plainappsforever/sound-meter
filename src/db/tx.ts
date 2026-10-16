// Serialised write queue, one per database FILE (= one native connection).
//
// expo-sqlite (and the Node fake in tests) share ONE connection whose async calls interleave at every `await`.
// Without a queue, a write that runs between another operation's BEGIN and ROLLBACK joins that transaction and is
// rolled back with it, and a second BEGIN throws "cannot start a transaction within a transaction". So every write
// runs as one unit through this queue: units run strictly one after another, in call order.
//
// A unit receives a handle (a Db that is only valid while the unit runs). Use the handle for every statement in the
// unit; name the parameter `db` so it shadows the outer connection. A nested withWrite/withTransaction called with
// the handle joins the running unit instead of queueing behind itself (which would deadlock). A call with the outer
// connection from inside a unit waits for the unit to end. Reads go through withRead (they wait for open units); a bare getAllAsync outside the queue is dirty.
import { retryingCalls } from './native-retry';
import type { Db } from './types';

type Unit = { open: boolean; depth: number };

const units = new WeakMap<object, Unit>(); // handle -> its unit
const tails = new WeakMap<object, Promise<unknown>>(); // queue key -> end of its queue
const files = new Map<string, object>(); // database file -> the one queue key for every JS handle on it

/**
 * The queue belongs to the CONNECTION, not to the JS object: expo-sqlite gives every `openDatabaseAsync(name)` with the
 * same options the same cached native connection but a new JS object (e.g. the UI's handle and a background
 * task's handle). So handles that name a database file (`databasePath`) share that file's queue; a handle without one
 * (the Node test fake) is its own queue.
 */
function queueKey(db: Db): object {
  const path = (db as { databasePath?: unknown }).databasePath;
  if (typeof path !== 'string' || path === '') return db;
  let key = files.get(path);
  if (!key) files.set(path, (key = {}));
  return key;
}
const noop = () => undefined;
const CLOSED = 'database handle used after its write unit ended';

function makeHandle(conn: Db, unit: Unit): Db {
  const guard = () => {
    if (!unit.open) throw new Error(CLOSED);
  };
  const native = retryingCalls(conn); // each native step retried alone after the Android shared-object race
  const handle = {
    execAsync: (...a: Parameters<Db['execAsync']>) => (guard(), native.execAsync(...a)),
    runAsync: (...a: Parameters<Db['runAsync']>) => (guard(), native.runAsync(...a)),
    getAllAsync: (...a: Parameters<Db['getAllAsync']>) => (guard(), native.getAllAsync(...a)),
    getFirstAsync: (...a: Parameters<Db['getFirstAsync']>) => (guard(), native.getFirstAsync(...a)),
  } as unknown as Db;
  units.set(handle, unit);
  return handle;
}

/** Runs `fn` as one unit of the connection's write queue (a single write, or several that need no rollback). */
export function withWrite<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  const unit = units.get(db);
  if (unit) return unit.open ? fn(db) : Promise.reject(new Error(CLOSED)); // nested: join the running unit
  const key = queueKey(db);
  const result = (tails.get(key) ?? Promise.resolve()).then(async () => {
    const own: Unit = { open: true, depth: 0 };
    try {
      return await fn(makeHandle(db, own));
    } finally {
      own.open = false;
    }
  });
  tails.set(key, result.then(noop, noop));
  return result;
}

/** Runs a read behind the write queue (and joins the running unit when given its handle): never sees uncommitted rows. */
export function withRead<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return withWrite(db, fn);
}

async function quietly(db: Db, sql: string) {
  try {
    await db.execAsync(sql);
  } catch {
    // SQLite may already have rolled back by itself (e.g. disk full); the original error is what matters.
  }
}

/**
 * Runs `fn` in BEGIN IMMEDIATE ... COMMIT as one queue unit; rolls back and rethrows on error. Nested inside another
 * transaction it becomes a SAVEPOINT: an inner failure undoes only the inner part, the outer transaction decides.
 */
export function withTransaction<T>(db: Db, fn: (db: Db) => Promise<T>): Promise<T> {
  return withWrite(db, async (tx) => {
    const unit = units.get(tx) as Unit;
    const nested = unit.depth > 0;
    const name = `sp${unit.depth}`;
    unit.depth++;
    try {
      await tx.execAsync(nested ? `SAVEPOINT ${name};` : 'BEGIN IMMEDIATE;');
      try {
        const result = await fn(tx);
        await tx.execAsync(nested ? `RELEASE ${name};` : 'COMMIT;');
        return result;
      } catch (error) {
        await quietly(tx, nested ? `ROLLBACK TO ${name}; RELEASE ${name};` : 'ROLLBACK;');
        throw error;
      }
    } finally {
      unit.depth--;
    }
  });
}
