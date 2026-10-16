/**
 * @jest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { isReleasedObjectRace, retryingCalls } from './native-retry';
import { withTransaction } from './tx';
import type { Db } from './types';

const RACE = new Error(
  "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: Cannot use shared object that was already released"
);

type Step = 'prepare' | 'execute' | 'finalize' | 'exec' | 'getAll' | 'getFirst';
/** A fake expo-sqlite handle that records native work and fails chosen steps with the race. */
function fakeDb(failures: Partial<Record<Step, number>>) {
  const left = { ...failures };
  const log: string[] = [];
  const maybeFail = (step: Step) => {
    if ((left[step] ?? 0) > 0) {
      left[step]! -= 1;
      throw RACE;
    }
  };
  const db = {
    async execAsync(sql: string) {
      maybeFail('exec');
      log.push(`exec ${sql}`);
    },
    async getAllAsync(sql: string) {
      maybeFail('getAll');
      log.push(`getAll ${sql}`);
      return [{ one: 1 }];
    },
    async getFirstAsync(sql: string) {
      maybeFail('getFirst');
      log.push(`getFirst ${sql}`);
      return { one: 1 };
    },
    async runAsync(): Promise<never> {
      throw new Error('the original runAsync must not be used');
    },
    async prepareAsync(sql: string) {
      maybeFail('prepare');
      log.push(`prepare ${sql}`);
      return {
        async executeAsync(...params: unknown[]) {
          maybeFail('execute');
          log.push(`execute ${JSON.stringify(params)}`);
          return { lastInsertRowId: 7, changes: 1 };
        },
        async finalizeAsync() {
          maybeFail('finalize');
          log.push('finalize');
        },
      };
    },
  };
  return { db: db as unknown as Db, log };
}

describe('retry of lost native steps (Android shared-object race)', () => {
  it('recognises the race by its message, also as a cause', () => {
    expect(isReleasedObjectRace(RACE)).toBe(true);
    expect(isReleasedObjectRace(new Error('outer', { cause: RACE }))).toBe(true);
    expect(isReleasedObjectRace(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isReleasedObjectRace(null)).toBe(false);
  });

  it.each(['prepare', 'execute', 'finalize'] as const)('a write runs exactly once when %s is lost once', async (step) => {
    const { db, log } = fakeDb({ [step]: 1 });
    const result = await retryingCalls(db).runAsync('INSERT INTO t VALUES (?)', 5);
    expect(result.changes).toBe(1);
    expect(log.filter((l) => l.startsWith('execute'))).toEqual(['execute [5]']);
    expect(log.filter((l) => l === 'finalize')).toHaveLength(1);
  });

  it('retries exec and reads once, and gives up after three retries', async () => {
    const { db, log } = fakeDb({ getAll: 1, getFirst: 1, exec: 1 });
    const calls = retryingCalls(db);
    await expect(calls.getAllAsync('SELECT 1')).resolves.toEqual([{ one: 1 }]);
    await expect(calls.getFirstAsync('SELECT 2')).resolves.toEqual({ one: 1 });
    await calls.execAsync('BEGIN');
    expect(log).toEqual(['getAll SELECT 1', 'getFirst SELECT 2', 'exec BEGIN']);
    const stubborn = fakeDb({ getFirst: 4 });
    await expect(retryingCalls(stubborn.db).getFirstAsync('SELECT 3')).rejects.toBe(RACE);
  });

  it('surfaces other errors unchanged, without retry', async () => {
    const { db } = fakeDb({});
    const failure = new Error('no such table: x');
    let attempts = 0;
    (db as unknown as { prepareAsync: () => Promise<never> }).prepareAsync = async () => {
      attempts++;
      throw failure;
    };
    await expect(retryingCalls(db).runAsync('INSERT INTO x VALUES (1)')).rejects.toBe(failure);
    expect(attempts).toBe(1);
  });

  it('is active inside withTransaction (BEGIN and a write each lose a step once; the write still runs once)', async () => {
    const { db, log } = fakeDb({ exec: 1, execute: 1 });
    await withTransaction(db, (tx) => tx.runAsync('INSERT INTO t VALUES (1)'));
    expect(log.filter((l) => l.startsWith('execute'))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith('exec '))).toEqual(['exec BEGIN IMMEDIATE;', 'exec COMMIT;']);
  });
});

describe('source rule: one database wrapper per process', () => {
  const root = join(__dirname, '..'); // src/
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
    }
  };
  walk(root);
  const rel = (p: string) => relative(join(root, '..'), p);
  // Code only: comment lines may name the APIs.
  const code = (p: string) =>
    readFileSync(p, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  it('calls openDatabaseAsync/openDatabaseSync only in src/db/connection.ts', () => {
    const openers = files.filter((f) => /openDatabase(Async|Sync)\b/.test(code(f))).map(rel);
    expect(openers).toEqual(['src/db/connection.ts']);
  });

  it("never uses expo-sqlite's SQLiteProvider or useSQLiteContext (use src/db/provider.tsx)", () => {
    const offenders = files
      .filter((f) => /\b(SQLiteProvider|useSQLiteContext)\b[^;]*from\s*'expo-sqlite'/s.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
