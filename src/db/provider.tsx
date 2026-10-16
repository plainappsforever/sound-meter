// Replaces expo-sqlite's SQLiteProvider (which opens its own wrapper and closes it on unmount; see connection.ts).
// Same contract for screens: `useSQLiteContext()`. `onInit` (migrations, ...) runs once per JS context, before any
// screen renders.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';

import { appDatabase } from './connection';

const Context = createContext<SQLiteDatabase | null>(null);
let initialised: Promise<SQLiteDatabase> | null = null;

export function DatabaseProvider({ onInit, children }: { onInit: (db: SQLiteDatabase) => Promise<void>; children: ReactNode }) {
  const [db, setDb] = useState<SQLiteDatabase | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    initialised ??= appDatabase().then(async (opened) => {
      await onInit(opened);
      return opened;
    });
    initialised.then(
      (opened) => active && setDb(opened),
      (e: Error) => {
        initialised = null;
        if (active) setError(e);
      }
    );
    return () => {
      active = false;
    };
  }, [onInit]);
  if (error) throw error;
  if (!db) return null;
  return <Context.Provider value={db}>{children}</Context.Provider>;
}

/** The app's database handle (inside `DatabaseProvider`). */
export function useSQLiteContext(): SQLiteDatabase {
  const db = useContext(Context);
  if (!db) throw new Error('useSQLiteContext must be used inside DatabaseProvider');
  return db;
}
