/**
 * `expo-sqlite` implementation of `SqlDriver` for the mobile app.
 *
 * The same migration runner and schema from `packages/core` run here unchanged —
 * the driver is the only platform-specific piece (Requirement 4.1, task 4.4).
 *
 * `expo-sqlite` uses `withTransactionAsync` for transactions, but the migration runner
 * issues `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` as SQL through `exec`, which is
 * exactly what `execAsync` handles. No special transaction wiring needed.
 *
 * Requirements: 4.1
 */

import type { SqlDriver, SqlRow, SqlValue } from '@photo-archive/core';
import type { SQLiteBindValue, SQLiteDatabase } from 'expo-sqlite';

/**
 * Converts a `SqlValue` to an `SQLiteBindValue`. `bigint` is not in expo-sqlite's bind
 * type (epoch ms and byte sizes stay within safe integer range), so we coerce to number.
 * `boolean` is also absent — coerce to 0/1 as SQLite stores booleans.
 */
function toBindValue(v: SqlValue): SQLiteBindValue {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function toBindParams(params: readonly SqlValue[] | undefined): SQLiteBindValue[] {
  return params ? params.map(toBindValue) : [];
}

export class ExpoSqliteDriver implements SqlDriver {
  readonly name: string;
  private readonly _db: SQLiteDatabase;

  constructor(db: SQLiteDatabase, databaseName = 'photo-archive.db') {
    this._db = db;
    this.name = `expo-sqlite (${databaseName})`;
  }

  async exec(sql: string): Promise<void> {
    await this._db.execAsync(sql);
  }

  async all<TRow extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<TRow[]> {
    const rows = await this._db.getAllAsync(sql, toBindParams(params));
    return rows as TRow[];
  }

  async run(sql: string, params?: readonly SqlValue[]): Promise<void> {
    await this._db.runAsync(sql, toBindParams(params));
  }

  async get<TRow extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<TRow | undefined> {
    const row = await this._db.getFirstAsync(sql, toBindParams(params));
    return (row ?? undefined) as TRow | undefined;
  }
}
