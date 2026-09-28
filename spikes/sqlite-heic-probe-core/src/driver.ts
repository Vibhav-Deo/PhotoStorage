/**
 * The narrowest SQLite surface the probe needs.
 *
 * Deliberately smaller than either real driver's API so that `expo-sqlite` on a
 * device and `node:sqlite` on a dev machine can both satisfy it, and so the
 * capability detector and both index implementations are written exactly once.
 * A divergence between the two runs therefore isolates the *runtime*, not the
 * SQL.
 */

export type SqlParam = string | number | null;

export interface SqlDriver {
  /** Identifies the run in the report, e.g. `expo-sqlite (ios)`. */
  readonly name: string;
  /** Multi-statement DDL. No parameters, no results. */
  exec(sql: string): Promise<void>;
  all<TRow extends object>(sql: string, params?: readonly SqlParam[]): Promise<TRow[]>;
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;
}

/**
 * The version of the SQLite amalgamation vendored by `expo-sqlite@57.0.2`, read
 * from `vendor/sqlite3/sqlite3.h` in the published npm tarball.
 *
 * The probe reports any mismatch, because a mismatch is the signature of a
 * problem that would otherwise be invisible: on iOS a symbol collision with the
 * platform's own `libsqlite3` would silently link the *system* SQLite instead of
 * the vendored one, and the system build's compile options are Apple's, not the
 * ones `ExpoSQLite.podspec` sets. Apple's SQLite is several minor versions
 * behind, so the version string alone is enough to detect the substitution.
 */
export const EXPECTED_VENDORED_SQLITE_VERSION = '3.50.3';
