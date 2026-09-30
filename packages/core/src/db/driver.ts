/**
 * The narrowest SQLite surface this package needs.
 *
 * Deliberately smaller than either real driver's API. The same schema and the same
 * migration runner have to execute against `expo-sqlite` on a device (task 4.4) and against
 * `node:sqlite` in the importer and in these tests, and the only way to be sure the *SQL*
 * is identical in both places is to have written it once. A behavioural difference between
 * the two runs then isolates the runtime rather than the statements.
 *
 * Three methods, because that is all a migration needs. Notably absent:
 *
 * - **No transaction method.** Transactions are issued as SQL through {@link SqlDriver.exec}
 *   (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`). Every driver spells its own transaction
 *   helper differently — `withTransactionAsync`, a callback, a `Disposable` — and adopting
 *   any one of them would push that shape onto the others.
 * - **No connection lifecycle.** Opening and closing a database is platform-specific;
 *   whoever opens the handle owns it. The runner is handed something already open.
 * - **No streaming reads.** Migrations are DDL plus small bookkeeping rows.
 *
 * Everything here is async even though `node:sqlite` is synchronous, because the mobile
 * driver is not and the narrower of the two shapes has to win.
 */

/**
 * A value that can cross the driver boundary as a bound parameter or a column value.
 *
 * `Uint8Array` is present for `assets.thumbhash` and `vector_full.vec`; `bigint` because
 * `node:sqlite` returns one for integers outside the safe double range, which epoch
 * milliseconds and byte sizes will not reach but a checked driver should still be able to
 * name.
 */
export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

/** A row as returned by a driver: column name to value. */
export type SqlRow = Record<string, unknown>;

export interface SqlDriver {
  /**
   * Identifies the runtime in error messages and capability reports, e.g.
   * `expo-sqlite (ios)` or `node:sqlite (node v22.19.0)`. Diagnostic only — nothing
   * branches on it, because a runner that special-cases a driver is no longer proof that
   * both runtimes take the same path.
   */
  readonly name: string;

  /**
   * Executes SQL that returns no rows. Implementations may accept several statements
   * separated by semicolons, but nothing in this package relies on that: migrations run one
   * statement per call so that a failure names the statement that failed.
   */
  exec(sql: string): Promise<void>;

  /** Runs a query and materializes every row. */
  all<TRow extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<TRow[]>;

  /** Runs a statement for its effect. */
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;

  /** Runs a query and returns the first row, or `undefined` if no rows matched. */
  get<TRow extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<TRow | undefined>;
}
