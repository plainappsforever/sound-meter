// The app's ONE JS database wrapper per JS context (found in warranty-wallet, decision D118).
//
// expo-sqlite gives every `openDatabaseAsync('app.db')` the SAME cached native connection under a NEW JS wrapper, and on
// Android a wrapper that is garbage-collected closes that shared native connection (no reference count), leaving every
// other wrapper dead. So the UI (`DatabaseProvider`), background tasks and every other caller share this one wrapper,
// held for the lifetime of the JS context and never closed. Do not call `openDatabaseAsync` or use expo-sqlite's
// `SQLiteProvider` anywhere else (`connection.test.ts` scans src/).
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'app.db';

let opened: Promise<SQLiteDatabase> | null = null;

/** The app's handle: opened once, kept forever. A failed open is forgotten so the next call tries again. */
export function appDatabase(): Promise<SQLiteDatabase> {
  if (!opened) {
    opened = openDatabaseAsync(DATABASE_NAME);
    opened.catch(() => {
      opened = null;
    });
  }
  return opened;
}
