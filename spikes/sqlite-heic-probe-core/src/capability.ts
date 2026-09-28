/**
 * Detects whether the SQLite behind a driver actually gives us FTS5 *as the
 * design uses it*.
 *
 * ## Why this is more than one check
 *
 * `PRAGMA compile_options` tells you the flags of whichever `sqlite3` the process
 * linked, which is authoritative about the library but says nothing about the
 * specific virtual table the design declares:
 *
 *     CREATE VIRTUAL TABLE ocr_fts USING fts5(
 *       hash UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');
 *
 * `remove_diacritics 2` needs SQLite 3.27 or newer, `bm25()` is what the design's
 * ranking depends on, and prefix queries are what an OCR search box needs to feel
 * responsive. Each is checked by executing it, because a compile flag being
 * present is not the same as the feature behaving.
 *
 * The version string gets its own check for a reason specific to iOS: if
 * `ExpoSQLite`'s vendored amalgamation ever loses a symbol race with the
 * platform's own `libsqlite3`, everything still works and the compile options
 * still list FTS5 — Apple enables it — but they are Apple's options, not the ones
 * `ExpoSQLite.podspec` sets. The version number is the cheapest way to notice.
 */

import { EXPECTED_VENDORED_SQLITE_VERSION, type SqlDriver } from './driver.ts';

export interface Fts5Capability {
  readonly sqliteVersion: string;
  readonly sqliteVersionMatchesVendored: boolean;
  /**
   * Full `PRAGMA compile_options` output. Worth recording verbatim: it is the
   * only direct evidence of how the shipped binary was built.
   */
  readonly compileOptions: readonly string[];
  /** False if the build defines `SQLITE_OMIT_COMPILEOPTION_DIAGS`, which makes the pragma silent. */
  readonly compileOptionsReadable: boolean;
  readonly declaresFts5: boolean;
  readonly declaresFts4: boolean;
  /** `CREATE VIRTUAL TABLE ... USING fts5(...)` with the design's exact options. */
  readonly createsDesignTable: boolean;
  /** A term with a combining mark is found by its unaccented form, and vice versa. */
  readonly foldsDiacritics: boolean;
  readonly hasBm25: boolean;
  readonly supportsPrefixQuery: boolean;
  /** `fts5vocab`, used below to expose the tokenizer's actual output. Diagnostic only. */
  readonly hasFts5Vocab: boolean;
  /**
   * Tokens the tokenizer produced for a probe string. This is what makes the CJK
   * behaviour visible rather than inferred.
   */
  readonly probeTokens: readonly string[];
  /** Every functional check passed, so the design's schema can be used unchanged. */
  readonly usable: boolean;
  readonly notes: readonly string[];
}

/** The design's `ocr_fts` declaration, copied verbatim so a drift is a test failure. */
export const DESIGN_FTS5_DDL =
  "CREATE VIRTUAL TABLE ocr_fts USING fts5(hash UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')";

const TOKENIZER_PROBE_TEXT = '東京都渋谷区の看板 Shibuya ward sign 12.50 SFO-NRT Café';

export async function detectFts5(driver: SqlDriver): Promise<Fts5Capability> {
  const notes: string[] = [];

  const versionRows = await driver.all<{ v: string }>('SELECT sqlite_version() AS v');
  const sqliteVersion = versionRows[0]?.v ?? 'unknown';
  const sqliteVersionMatchesVendored = sqliteVersion === EXPECTED_VENDORED_SQLITE_VERSION;
  if (!sqliteVersionMatchesVendored) {
    notes.push(
      `sqlite_version() is ${sqliteVersion}, not the ${EXPECTED_VENDORED_SQLITE_VERSION} ` +
        `that expo-sqlite@57.0.2 vendors. Expected for the off-device reference, which links ` +
        `Node's own SQLite. On a device it is a finding: it would mean the vendored ` +
        `amalgamation is not the library in use, so the build flags in ExpoSQLite.podspec and ` +
        `android/build.gradle do not apply and nothing below can be attributed to them.`
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
      'PRAGMA compile_options returned nothing, which means SQLITE_OMIT_COMPILEOPTION_DIAGS ' +
        'is defined. The functional checks below are then the only evidence available.'
    );
  }

  const declaresFts5 = compileOptions.includes('ENABLE_FTS5');
  const declaresFts4 = compileOptions.includes('ENABLE_FTS4');

  // Everything from here on is executed rather than declared.
  let createsDesignTable = false;
  let foldsDiacritics = false;
  let hasBm25 = false;
  let supportsPrefixQuery = false;
  let hasFts5Vocab = false;
  let probeTokens: string[] = [];

  try {
    await driver.exec('DROP TABLE IF EXISTS ocr_fts_probe');
    await driver.exec(DESIGN_FTS5_DDL.replace('ocr_fts', 'ocr_fts_probe'));
    createsDesignTable = true;
  } catch (error) {
    notes.push(`the design's ocr_fts declaration failed: ${message(error)}`);
  }

  if (createsDesignTable) {
    await driver.run('INSERT INTO ocr_fts_probe(hash, text) VALUES (?, ?)', [
      'probe',
      TOKENIZER_PROBE_TEXT,
    ]);

    // remove_diacritics 2 has to work in both directions: an accented document
    // found by an unaccented query, and the reverse.
    try {
      const unaccented = await driver.all<{ hash: string }>(
        'SELECT hash FROM ocr_fts_probe WHERE ocr_fts_probe MATCH ?',
        ['cafe']
      );
      const accented = await driver.all<{ hash: string }>(
        'SELECT hash FROM ocr_fts_probe WHERE ocr_fts_probe MATCH ?',
        ['café']
      );
      foldsDiacritics = unaccented.length === 1 && accented.length === 1;
      if (!foldsDiacritics) {
        notes.push(
          'the tokenizer did not fold diacritics in both directions, so ' +
            "remove_diacritics 2 is not in effect even though the CREATE succeeded."
        );
      }
    } catch (error) {
      notes.push(`diacritic folding check failed: ${message(error)}`);
    }

    try {
      const ranked = await driver.all<{ hash: string; rank: number }>(
        'SELECT hash, bm25(ocr_fts_probe) AS rank FROM ocr_fts_probe WHERE ocr_fts_probe MATCH ? ORDER BY rank',
        ['shibuya']
      );
      // FTS5 returns bm25 negated so that ORDER BY rank ASC is best-first.
      hasBm25 = ranked.length === 1 && typeof ranked[0]?.rank === 'number' && ranked[0].rank < 0;
      if (!hasBm25) {
        notes.push('bm25() did not return a negative score for a matching row.');
      }
    } catch (error) {
      notes.push(`bm25() is unavailable: ${message(error)}`);
    }

    try {
      const prefixed = await driver.all<{ hash: string }>(
        'SELECT hash FROM ocr_fts_probe WHERE ocr_fts_probe MATCH ?',
        ['shib*']
      );
      supportsPrefixQuery = prefixed.length === 1;
      if (!supportsPrefixQuery) {
        notes.push('prefix queries did not match, so incremental OCR search is not available.');
      }
    } catch (error) {
      notes.push(`prefix query failed: ${message(error)}`);
    }

    // fts5vocab is how the tokenizer's real output becomes visible. It is a
    // diagnostic, so a failure here must not affect `usable`.
    try {
      await driver.exec('DROP TABLE IF EXISTS ocr_fts_probe_vocab');
      await driver.exec(
        "CREATE VIRTUAL TABLE ocr_fts_probe_vocab USING fts5vocab(ocr_fts_probe, 'row')"
      );
      const rows = await driver.all<{ term: string }>(
        'SELECT term FROM ocr_fts_probe_vocab ORDER BY term'
      );
      hasFts5Vocab = true;
      probeTokens = rows.map((row) => row.term);
    } catch {
      notes.push('fts5vocab is unavailable, so the tokenizer output could not be listed.');
    }
  }

  const usable =
    createsDesignTable && foldsDiacritics && hasBm25 && supportsPrefixQuery;

  if (usable && !declaresFts5 && compileOptionsReadable) {
    notes.push(
      'FTS5 works but ENABLE_FTS5 is absent from compile_options, which is contradictory ' +
        'and worth understanding before relying on it.'
    );
  }

  return {
    sqliteVersion,
    sqliteVersionMatchesVendored,
    compileOptions,
    compileOptionsReadable,
    declaresFts5,
    declaresFts4,
    createsDesignTable,
    foldsDiacritics,
    hasBm25,
    supportsPrefixQuery,
    hasFts5Vocab,
    probeTokens,
    usable,
    notes,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
