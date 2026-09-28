/**
 * `SqlDriver` over Node's built-in `node:sqlite`.
 *
 * ## Why this is a legitimate reference for the FTS5 question
 *
 * Node 22 statically links its own SQLite amalgamation. Read from
 * `PRAGMA compile_options` on Node 22.19.0, that build declares:
 *
 *     ENABLE_FTS3  ENABLE_FTS3_PARENTHESIS  ENABLE_FTS5  ENABLE_MATH_FUNCTIONS ...
 *
 * at `sqlite_version()` 3.50.4. The amalgamation `expo-sqlite@57.0.2` vendors is
 * 3.50.3, built with `-DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1
 * -DSQLITE_ENABLE_FTS5=1` on both platforms. One patch release apart, with the
 * same FTS5 module compiled in.
 *
 * That makes this run authoritative about everything that is a property of *FTS5
 * itself* — whether the design's `ocr_fts` declaration is valid, whether
 * `remove_diacritics 2` folds the way the design assumes, how `unicode61` treats
 * CJK, whether `bm25()` ranks as expected, and whether the token-table fallback
 * reproduces those rankings.
 *
 * It is authoritative about nothing that is a property of the *shipped mobile
 * binary*: that the flags in `ExpoSQLite.podspec` and `android/build.gradle`
 * survive into the app, and that nothing on iOS links Apple's `libsqlite3`
 * instead. Only a device answers those, which is what the Expo app in
 * `sqlite-heic-probe/` is for.
 */

import { DatabaseSync } from 'node:sqlite';

import type { SqlDriver, SqlParam } from '../sqlite-heic-probe-core/src/index.ts';

export class NodeSqliteDriver implements SqlDriver {
  readonly name = `node:sqlite (node ${process.version})`;

  private readonly db = new DatabaseSync(':memory:');

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async all<TRow extends object>(sql: string, params: readonly SqlParam[] = []): Promise<TRow[]> {
    return this.db.prepare(sql).all(...(params as SqlParam[])) as TRow[];
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as SqlParam[]));
  }

  close(): void {
    this.db.close();
  }
}
