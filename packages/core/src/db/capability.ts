/**
 * Detects whether the SQLite behind a driver actually gives us FTS5 *as the schema uses it*,
 * and asserts it at startup.
 *
 * ## Why this is asserted rather than assumed
 *
 * Spike 0.2 read `expo-sqlite@57.0.2` from its published tarball: it vendors its own SQLite
 * amalgamation and both `ios/ExpoSQLite.podspec` and `android/build.gradle` append
 * `-DSQLITE_ENABLE_FTS5=1` symmetrically. FTS5 is therefore compiled in by default on both
 * platforms — but *by default*, which is not the same as always. Two build settings remove
 * it, neither of them in this package and neither of them loud:
 *
 * - `expo-build-properties` with `expo.sqlite.enableFTS: false` skips the flags outright.
 * - `expo.sqlite.useLibSQL: true` swaps in a prebuilt binary the flags do not control.
 *
 * So FTS5 availability is a property of the *app's build configuration*, not of the library,
 * and it can be taken away by an edit to `app.json` that mentions neither search nor
 * SQLite. Left unchecked, the symptom is that OCR search silently returns nothing.
 *
 * ## Why one check is not enough
 *
 * `PRAGMA compile_options` describes whichever `sqlite3` the process linked. That is
 * authoritative about the library and says nothing about the specific virtual table the
 * schema declares, so every functional property below is established by executing it:
 * `remove_diacritics 2` needs SQLite 3.27 or newer, `bm25()` is what search ranking depends
 * on, and prefix queries are what makes a search box feel responsive.
 *
 * The version string gets its own check for a reason specific to iOS. If `ExpoSQLite`'s
 * vendored amalgamation ever loses a symbol race with the platform's own `libsqlite3`,
 * everything still works and the compile options still list FTS5 — Apple enables it — but
 * they are Apple's options, not the ones the podspec sets. Apple's SQLite runs several minor
 * versions behind, so the version number is the cheapest way to notice the substitution.
 *
 * ## Known limitation, carried forward from spike 0.2
 *
 * `unicode61` classifies Han and kana as alphanumeric, so an unbroken CJK run indexes as a
 * *single* token: `東京都渋谷区の看板` is one term, and neither `渋谷` nor `渋谷*` retrieves it,
 * because a prefix must match a token start. {@link Fts5Capability.probeTokens} exposes the
 * tokenizer's real output so this stays visible rather than inferred. It is a defect in
 * coverage, not in availability, so it does not affect {@link Fts5Capability.usable} — the
 * fix (CJK character bigrams in a second column, or the token-table fallback) is a task 6.4
 * decision.
 */

import type { SqlDriver } from './driver.ts';
import { OCR_FTS_DDL } from './schema.ts';

/**
 * The SQLite amalgamation version vendored by `expo-sqlite@57.0.2`, read from
 * `vendor/sqlite3/sqlite3.h` in the published tarball.
 *
 * A mismatch is only a finding on a device — see the iOS note above. Off-device runs link
 * Node's own SQLite (3.50.4, one patch release away) and are expected to differ, so this is
 * reported rather than enforced.
 */
export const EXPO_SQLITE_VENDORED_SQLITE_VERSION = '3.50.3';

/** Probe table names. Dropped before and after the probe; never part of the schema. */
const PROBE_TABLE = 'ocr_fts_capability_probe';
const PROBE_VOCAB_TABLE = 'ocr_fts_capability_probe_vocab';

/**
 * Exercises Latin text, a combining mark, a CJK run, a decimal, and a hyphenated code —
 * the shapes OCR of real signage and receipts produces.
 */
const TOKENIZER_PROBE_TEXT = '東京都渋谷区の看板 Shibuya ward sign 12.50 SFO-NRT Café';

export interface Fts5Capability {
  /** The driver that was probed, for the report. */
  readonly driver: string;
  readonly sqliteVersion: string;
  readonly sqliteVersionMatchesExpoVendored: boolean;
  /**
   * Full `PRAGMA compile_options` output. Worth recording verbatim: it is the only direct
   * evidence of how the shipped binary was built.
   */
  readonly compileOptions: readonly string[];
  /** False if the build defines `SQLITE_OMIT_COMPILEOPTION_DIAGS`, which silences the pragma. */
  readonly compileOptionsReadable: boolean;
  readonly declaresFts5: boolean;
  /** The schema's own `ocr_fts` declaration, run under a probe name. */
  readonly createsOcrFtsTable: boolean;
  /** A term with a combining mark is found by its unaccented form, and vice versa. */
  readonly foldsDiacritics: boolean;
  readonly hasBm25: boolean;
  readonly supportsPrefixQuery: boolean;
  /** `fts5vocab`, used to expose the tokenizer's real output. Diagnostic only. */
  readonly hasFts5Vocab: boolean;
  /** Tokens produced for {@link TOKENIZER_PROBE_TEXT}. Makes the CJK behaviour visible. */
  readonly probeTokens: readonly string[];
  /** Every functional check passed, so the schema's `ocr_fts` can be used unchanged. */
  readonly usable: boolean;
  readonly notes: readonly string[];
}

/**
 * Thrown when FTS5 is missing or does not behave as the schema needs. The message names the
 * two build settings that cause it, because that is the only actionable information: nothing
 * in this package can restore the capability.
 */
export class Fts5UnavailableError extends Error {
  override readonly name = 'Fts5UnavailableError';
  readonly capability: Fts5Capability;

  constructor(capability: Fts5Capability) {
    super(
      `FTS5 is not usable on ${capability.driver} (sqlite ${capability.sqliteVersion}). ` +
        'The OCR search index cannot be created. On the mobile app this almost always means ' +
        'the build configuration removed it: check that expo-build-properties does not set ' +
        'expo.sqlite.enableFTS to false, and that expo.sqlite.useLibSQL is not true — libSQL ' +
        'is a prebuilt binary that the FTS compile flags do not reach. Findings: ' +
        (capability.notes.length > 0 ? capability.notes.join(' | ') : 'none recorded.'),
    );
    this.capability = capability;
  }
}

/**
 * Runs every check and reports. Never throws for a missing capability — that is
 * {@link assertFts5}'s job — so a caller that wants to degrade rather than fail can.
 *
 * Creates and drops two tables on the connection it is given. Must not be called inside a
 * transaction.
 */
export async function detectFts5(driver: SqlDriver): Promise<Fts5Capability> {
  const notes: string[] = [];

  const versionRows = await driver.all<{ v: string }>('SELECT sqlite_version() AS v');
  const sqliteVersion = versionRows[0]?.v ?? 'unknown';
  const sqliteVersionMatchesExpoVendored = sqliteVersion === EXPO_SQLITE_VENDORED_SQLITE_VERSION;
  if (!sqliteVersionMatchesExpoVendored) {
    notes.push(
      `sqlite_version() is ${sqliteVersion}, not the ${EXPO_SQLITE_VENDORED_SQLITE_VERSION} that ` +
        'expo-sqlite@57.0.2 vendors. Expected off-device, which links Node\u2019s own SQLite. On a ' +
        'device it is a finding: it would mean the vendored amalgamation is not the library in ' +
        'use, so the build flags in ExpoSQLite.podspec and android/build.gradle do not apply.',
    );
  }

  let compileOptions: string[] = [];
  try {
    const rows = await driver.all<{ compile_options: string }>('PRAGMA compile_options');
    compileOptions = rows.map((row) => row.compile_options);
  } catch {
    // Left empty; `compileOptionsReadable` reports it.
  }
  const compileOptionsReadable = compileOptions.length > 0;
  if (!compileOptionsReadable) {
    notes.push(
      'PRAGMA compile_options returned nothing, which means SQLITE_OMIT_COMPILEOPTION_DIAGS is ' +
        'defined. The functional checks are then the only evidence available.',
    );
  }
  const declaresFts5 = compileOptions.includes('ENABLE_FTS5');

  // Everything from here is executed rather than declared.
  let createsOcrFtsTable = false;
  let foldsDiacritics = false;
  let hasBm25 = false;
  let supportsPrefixQuery = false;
  let hasFts5Vocab = false;
  let probeTokens: string[] = [];

  try {
    await driver.exec(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    await driver.exec(OCR_FTS_DDL.replace('ocr_fts', PROBE_TABLE));
    createsOcrFtsTable = true;
  } catch (error) {
    notes.push(`the schema\u2019s ocr_fts declaration failed: ${message(error)}`);
  }

  if (createsOcrFtsTable) {
    try {
      await driver.run(`INSERT INTO ${PROBE_TABLE}(hash, text) VALUES (?, ?)`, [
        'probe',
        TOKENIZER_PROBE_TEXT,
      ]);

      // remove_diacritics 2 has to work both ways: an accented document found by an
      // unaccented query, and the reverse.
      foldsDiacritics =
        (await matchCount(driver, 'cafe')) === 1 && (await matchCount(driver, 'caf\u00e9')) === 1;
      if (!foldsDiacritics) {
        notes.push(
          'the tokenizer did not fold diacritics in both directions, so remove_diacritics 2 is ' +
            'not in effect even though the CREATE succeeded.',
        );
      }
    } catch (error) {
      notes.push(`diacritic folding check failed: ${message(error)}`);
    }

    try {
      const ranked = await driver.all<{ rank: number }>(
        `SELECT bm25(${PROBE_TABLE}) AS rank FROM ${PROBE_TABLE} WHERE ${PROBE_TABLE} MATCH ? ORDER BY rank`,
        ['shibuya'],
      );
      const rank = ranked[0]?.rank;
      // FTS5 returns bm25 negated, so ORDER BY rank ASC is best-first. A non-negative score
      // would mean ranking is inverted, which is worse than it being absent.
      hasBm25 = ranked.length === 1 && typeof rank === 'number' && rank < 0;
      if (!hasBm25) {
        notes.push('bm25() did not return a negative score for a matching row.');
      }
    } catch (error) {
      notes.push(`bm25() is unavailable: ${message(error)}`);
    }

    try {
      supportsPrefixQuery = (await matchCount(driver, 'shib*')) === 1;
      if (!supportsPrefixQuery) {
        notes.push('prefix queries did not match, so incremental OCR search is not available.');
      }
    } catch (error) {
      notes.push(`prefix query failed: ${message(error)}`);
    }

    // fts5vocab is how the tokenizer's real output becomes visible. Diagnostic, so a failure
    // here must not affect `usable`.
    try {
      await driver.exec(`DROP TABLE IF EXISTS ${PROBE_VOCAB_TABLE}`);
      await driver.exec(
        `CREATE VIRTUAL TABLE ${PROBE_VOCAB_TABLE} USING fts5vocab(${PROBE_TABLE}, 'row')`,
      );
      const rows = await driver.all<{ term: string }>(
        `SELECT term FROM ${PROBE_VOCAB_TABLE} ORDER BY term`,
      );
      hasFts5Vocab = true;
      probeTokens = rows.map((row) => row.term);
    } catch {
      notes.push('fts5vocab is unavailable, so the tokenizer output could not be listed.');
    }
  }

  // The probe leaves nothing behind. It runs against the app's own database, and a stray
  // virtual table there would show up as unexplained schema on a later integrity check.
  await dropQuietly(driver, PROBE_VOCAB_TABLE);
  await dropQuietly(driver, PROBE_TABLE);

  const usable = createsOcrFtsTable && foldsDiacritics && hasBm25 && supportsPrefixQuery;

  if (usable && !declaresFts5 && compileOptionsReadable) {
    notes.push(
      'FTS5 works but ENABLE_FTS5 is absent from compile_options, which is contradictory and ' +
        'worth understanding before relying on it.',
    );
  }

  return {
    driver: driver.name,
    sqliteVersion,
    sqliteVersionMatchesExpoVendored,
    compileOptions,
    compileOptionsReadable,
    declaresFts5,
    createsOcrFtsTable,
    foldsDiacritics,
    hasBm25,
    supportsPrefixQuery,
    hasFts5Vocab,
    probeTokens,
    usable,
    notes,
  };
}

/**
 * The startup assertion spike 0.2 asked for. Throws {@link Fts5UnavailableError} unless the
 * schema's `ocr_fts` declaration can be created and ranks the way search depends on.
 *
 * Call this on every launch rather than only when migrating: the database can already be at
 * the current schema version while a new app build has removed the capability underneath it.
 */
export async function assertFts5(driver: SqlDriver): Promise<Fts5Capability> {
  const capability = await detectFts5(driver);
  if (!capability.usable) {
    throw new Fts5UnavailableError(capability);
  }
  return capability;
}

async function matchCount(driver: SqlDriver, query: string): Promise<number> {
  const rows = await driver.all<{ hash: string }>(
    `SELECT hash FROM ${PROBE_TABLE} WHERE ${PROBE_TABLE} MATCH ?`,
    [query],
  );
  return rows.length;
}

async function dropQuietly(driver: SqlDriver, table: string): Promise<void> {
  try {
    await driver.exec(`DROP TABLE IF EXISTS ${table}`);
  } catch {
    // A build without FTS5 can fail to drop a table it could not create. Nothing to do.
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
