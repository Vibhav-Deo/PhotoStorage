/**
 * `SqlDriver` over Node's built-in `node:sqlite`.
 *
 * **Not exported from this package's root.** It is reachable only as
 * `@photo-archive/core/node-sqlite`, because `index.ts` is what Metro bundles for the app and
 * a bare `node:sqlite` import in that graph fails the bundle. The device driver is
 * `expo-sqlite` and arrives in task 4.4; this one exists so the schema and the migration
 * runner are exercised in CI, and so the importer has a database without a native dependency.
 *
 * Node 22 statically links its own SQLite amalgamation, built with `ENABLE_FTS5` at
 * `sqlite_version()` 3.50.4 — one patch release from the 3.50.3 that `expo-sqlite@57.0.2`
 * vendors, with the same FTS5 module compiled in. That makes tests here authoritative about
 * everything that is a property of *SQLite*: whether the schema's DDL is valid, whether the
 * partial indexes are chosen by the planner, whether `ocr_fts` ranks as search expects.
 *
 * It is authoritative about nothing that is a property of the *shipped mobile binary*, which
 * is exactly why `capability.ts` runs on the device connection too.
 *
 * `node:sqlite` is still flagged experimental on Node 22 and prints a warning on first use.
 */

import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlRow, SqlValue } from './driver.ts';

export interface NodeSqliteDriverOptions {
  /** Defaults to `:memory:`. */
  readonly path?: string;
}

export class NodeSqliteDriver implements SqlDriver {
  readonly name: string;

  private readonly db: DatabaseSync;

  constructor(options: NodeSqliteDriverOptions = {}) {
    const path = options.path ?? ':memory:';
    this.db = new DatabaseSync(path);
    this.name = `node:sqlite (node ${process.version}, ${path})`;
  }

  // `node:sqlite` is synchronous, so nothing here is `async`. Every method still routes
  // through `settle`, which matters more than it looks: a synchronous `throw` from a
  // Promise-returning method is a different failure mode from a rejected promise — it escapes
  // `.catch()` and `rejects.toThrow()` entirely — and the mobile driver will only ever reject.
  // The contract has to be the same on both or a caller that works on one breaks on the other.

  exec(sql: string): Promise<void> {
    return settle(() => {
      this.db.exec(sql);
    });
  }

  all<TRow extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<TRow[]> {
    return settle(() => {
      // `node:sqlite` returns rows with a null prototype, which is a surprise to anything
      // that treats them as plain objects — `toEqual`, spreads into class instances, JSON
      // round trips. Copying is cheaper than every caller having to know.
      const rows = this.db.prepare(sql).all(...toBindings(params));
      return rows.map((row) => ({ ...row }) as TRow);
    });
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    return settle(() => {
      this.db.prepare(sql).run(...toBindings(params));
    });
  }

  get<TRow extends SqlRow = SqlRow>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<TRow | undefined> {
    return settle(() => {
      const rows = this.db.prepare(sql).all(...toBindings(params));
      const first = rows[0];
      return first !== undefined ? ({ ...first } as TRow) : undefined;
    });
  }

  close(): void {
    this.db.close();
  }
}

/** Turns a synchronous throw into a rejection, so the driver never fails two different ways. */
function settle<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * `node:sqlite` accepts no booleans, so they are narrowed to SQLite's own representation —
 * the same 0/1 the schema stores in `assets.favorite`.
 */
function toBindings(params: readonly SqlValue[]): (string | number | bigint | null | Uint8Array)[] {
  return params.map((param) => (typeof param === 'boolean' ? (param ? 1 : 0) : param));
}
