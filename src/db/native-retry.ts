// Retry for one Android expo-modules-core race (found in warranty-wallet, decision D118).
//
// expo-modules-core 57 (Android) keeps every shared object (each expo-sqlite NativeStatement, the NativeDatabase, ...)
// in a plain HashMap. Writes to it are locked, but the READ that turns an async call's arguments back into native
// objects runs on a background thread WITHOUT the lock. When the map resizes meanwhile, the lookup misses a live object
// and the call fails with "Cannot use shared object that was already released" BEFORE the native function body runs.
// So the failed step did nothing and repeating that one step is exact. iOS is not affected.
//
// Only src/db/tx.ts uses this (every database call goes through its handles). Do not add retries elsewhere.
// - exec / getAll / getFirst: one native call (or a side-effect-free read) -> retried as a whole.
// - run: prepare, execute, finalize as separate steps, each retried alone, so a write never runs twice (a whole-call
//   retry would repeat the INSERT when only the finalize step was lost). Handles without prepareAsync (the Node test
//   fake, which has no race) use their own runAsync.
// Any other error is passed on unchanged at once.
import type { Db } from './types';

const RACE_MESSAGE = 'already released';
/** Waits before attempt 2, 3, 4 (the resize window is microseconds; three retries are plenty). */
const BACKOFF_MS = [0, 5, 25];

/** True for the expo-modules-core race (any error whose message, or a cause's message, names it). */
export function isReleasedObjectRace(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const message = typeof e === 'object' && 'message' in e ? String((e as Error).message) : String(e);
    if (message.includes(RACE_MESSAGE)) return true;
    e = typeof e === 'object' && 'cause' in e ? (e as { cause?: unknown }).cause : null;
  }
  return false;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs one native step, repeating it only after the race (up to 3 retries). */
export async function retryRace<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await step();
    } catch (error) {
      if (!isReleasedObjectRace(error) || attempt >= BACKOFF_MS.length) throw error;
      await wait(BACKOFF_MS[attempt]);
    }
  }
}

type Statement = { executeAsync(...params: unknown[]): Promise<unknown>; finalizeAsync(): Promise<void> };
type Prepares = { prepareAsync?: (source: string) => Promise<Statement> };

/** The four calls the queue uses, each native step retried on its own. */
export function retryingCalls(conn: Db): Pick<Db, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'> {
  const c = conn as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> & Prepares;
  return {
    execAsync: (...a: Parameters<Db['execAsync']>) => retryRace(() => conn.execAsync(...a)),
    getAllAsync: ((...a: unknown[]) => retryRace(() => c.getAllAsync(...a))) as Db['getAllAsync'],
    getFirstAsync: ((...a: unknown[]) => retryRace(() => c.getFirstAsync(...a))) as Db['getFirstAsync'],
    runAsync: (async (source: string, ...params: unknown[]) => {
      if (typeof c.prepareAsync !== 'function') return conn.runAsync(source, ...(params as []));
      const prepare = c.prepareAsync.bind(conn);
      const statement = await retryRace(() => prepare(source));
      try {
        return await retryRace(() => statement.executeAsync(...params));
      } finally {
        await retryRace(() => statement.finalizeAsync());
      }
    }) as Db['runAsync'],
  };
}
