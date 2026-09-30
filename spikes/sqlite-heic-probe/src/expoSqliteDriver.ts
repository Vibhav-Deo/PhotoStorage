/**
 * `SqlDriver` over `expo-sqlite`, so the device run is graded by exactly the same
 * code as the Node reference.
 *
 * This file holds no probe logic on purpose. Its only job is to make the on-device
 * runtime satisfy the same three-method contract, which is what lets a divergence
 * between the two runs be attributed to the runtime rather than to the SQL, the
 * corpus, or the grading.
 *
 * ## What source says about the library underneath (read from expo-sqlite@57.0.2 on npm)
 *
 * `expo-sqlite` vendors its own SQLite amalgamation at `vendor/sqlite3/sqlite3.c`
 * (version 3.50.3) and compiles it as part of the module on both platforms, rather
 * than linking the platform's SQLite. FTS5 is enabled by default on both:
 *
 * - iOS, `ios/ExpoSQLite.podspec`:
 *     `unless podfile_properties['expo.sqlite.enableFTS'] == 'false'`
 *       -> `-DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1`
 *   applied through `OTHER_CFLAGS`, and mirrored into `OTHER_SWIFT_FLAGS` as `-Xcc`.
 * - Android, `android/build.gradle`:
 *     `if (findProperty('expo.sqlite.enableFTS') != 'false')` -> the same three flags,
 *   passed to CMake as `SQLITE_BUILDFLAGS` and applied by `android/CMakeLists.txt`
 *   via `add_compile_options` to the same vendored `sqlite3.c`.
 *
 * So the flag is opt-*out*, symmetric across platforms, and applied to a single
 * vendored source file. Two consequences worth carrying into the design:
 *
 * 1. Nothing has to be configured to get FTS5. But `expo-build-properties` with
 *    `expo.sqlite.enableFTS: false` — or the `useLibSQL` variant, which swaps in a
 *    prebuilt binary whose FTS5 status these flags do not control — would remove
 *    it. That makes FTS5 availability a property of the app's build configuration,
 *    which is exactly the kind of thing that regresses silently. The design should
 *    treat the runtime capability check as a startup assertion, not a one-time
 *    spike question.
 * 2. Reading the flags is not the same as observing the behaviour, which is why
 *    this probe exists.
 */

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';

import type { SqlDriver, SqlParam } from '../../sqlite-heic-probe-core/src/index.ts';

export class ExpoSqliteDriver implements SqlDriver {
  readonly name = `expo-sqlite (${Platform.OS} ${String(Platform.Version)})`;

  private constructor(private readonly db: SQLite.SQLiteDatabase) {}

  /**
   * Opens an on-disk database rather than `:memory:`.
   *
   * On-disk is the configuration the product ships, and it is the one where a
   * virtual table's shadow tables actually get written, so an FTS5 problem that
   * only appears on real storage is not hidden.
   */
  static async open(): Promise<ExpoSqliteDriver> {
    const db = await SQLite.openDatabaseAsync('fts-probe.db');
    return new ExpoSqliteDriver(db);
  }

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async all<TRow extends object>(sql: string, params: readonly SqlParam[] = []): Promise<TRow[]> {
    return this.db.getAllAsync<TRow>(sql, params as SQLite.SQLiteBindValue[]);
  }

  async run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    await this.db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}
