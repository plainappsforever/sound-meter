import type { SQLiteDatabase } from 'expo-sqlite';

/** The subset of expo-sqlite used by data functions. Tests supply a Node SQLite implementation. */
export type Db = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
