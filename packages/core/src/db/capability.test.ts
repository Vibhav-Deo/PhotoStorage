/**
 * The FTS5 capability assertion.
 *
 * What this can and cannot establish is worth being explicit about, because spike 0.2's whole
 * finding was that the question has two halves. Node's SQLite settles everything that is a
 * property of *FTS5*: that the schema's `ocr_fts` declaration is valid, that
 * `remove_diacritics 2` folds both ways, that `bm25()` ranks the way search depends on. It
 * settles nothing about the *shipped mobile binary*, which is precisely why the detector
 * exists and why it runs on the device connection at startup.
 *
 * So the tests here are of two kinds: the detector agrees with reality on a build that has
 * FTS5, and it fails usefully on one that does not. The second kind is the one that will
 * matter, and it is simulated, because a Node build without FTS5 is not something CI can
 * produce.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXPO_SQLITE_VENDORED_SQLITE_VERSION,
  Fts5UnavailableError,
  assertFts5,
  detectFts5,
} from './capability.ts';
import type { SqlDriver, SqlRow, SqlValue } from './driver.ts';
import { NodeSqliteDriver } from './nodeSqliteDriver.ts';

let driver: NodeSqliteDriver;

beforeEach(() => {
  driver = new NodeSqliteDriver();
});

afterEach(() => {
  driver.close();
});

/**
 * Rewrites or fails statements on the way through, to stand in for a build whose SQLite was
 * compiled differently. `sabotage` returns a replacement SQL string, or throws to simulate a
 * missing module.
 */
class RewritingDriver implements SqlDriver {
  readonly name: string;
  private readonly inner: SqlDriver;
  private readonly sabotage: (sql: string) => string;

  constructor(name: string, inner: SqlDriver, sabotage: (sql: string) => string) {
    this.name = name;
    this.inner = inner;
    this.sabotage = sabotage;
  }

  async exec(sql: string): Promise<void> {
    return this.inner.exec(this.sabotage(sql));
  }
  async all<TRow extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<TRow[]> {
    return this.inner.all<TRow>(this.sabotage(sql), params);
  }
  async run(sql: string, params?: readonly SqlValue[]): Promise<void> {
    return this.inner.run(this.sabotage(sql), params);
  }
  async get<TRow extends SqlRow = SqlRow>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<TRow | undefined> {
    return this.inner.get<TRow>(this.sabotage(sql), params);
  }
}

describe('on a build that has FTS5', () => {
  it('reports every functional check passing', async () => {
    const capability = await detectFts5(driver);

    expect(capability.usable).toBe(true);
    expect(capability.createsOcrFtsTable).toBe(true);
    expect(capability.foldsDiacritics).toBe(true);
    expect(capability.hasBm25).toBe(true);
    expect(capability.supportsPrefixQuery).toBe(true);
  });

  it('reads the compile options and finds ENABLE_FTS5 among them', async () => {
    const capability = await detectFts5(driver);

    expect(capability.compileOptionsReadable).toBe(true);
    expect(capability.declaresFts5).toBe(true);
  });

  it('notes the version difference from the amalgamation expo-sqlite vendors', async () => {
    const capability = await detectFts5(driver);

    // Node links its own SQLite, so off-device this mismatch is expected rather than a
    // problem. It is reported because on iOS the same signal means the vendored build lost a
    // symbol race with Apple's libsqlite3 and none of the podspec's flags apply.
    expect(capability.sqliteVersion).not.toBe(EXPO_SQLITE_VENDORED_SQLITE_VERSION);
    expect(capability.sqliteVersionMatchesExpoVendored).toBe(false);
    expect(capability.notes.join(' ')).toMatch(/ExpoSQLite\.podspec/);
  });

  it('exposes the CJK tokenization defect rather than hiding it', async () => {
    const capability = await detectFts5(driver);

    // unicode61 treats an unbroken Han run as one token, so no prefix query can reach into it.
    // Recorded here because the failure mode in production is silent: Japanese signage indexes
    // and never retrieves. Handling it is a task 6.4 decision.
    expect(capability.hasFts5Vocab).toBe(true);
    expect(capability.probeTokens).toContain(
      '\u6771\u4eac\u90fd\u6e0b\u8c37\u533a\u306e\u770b\u677f',
    );
    expect(capability.probeTokens).toContain('shibuya');
  });

  it('leaves no probe tables behind', async () => {
    await detectFts5(driver);

    const rows = await driver.all<{ name: string }>('SELECT name FROM sqlite_master');
    expect(rows.filter((row) => row.name.includes('probe'))).toEqual([]);
  });

  it('resolves the assertion', async () => {
    await expect(assertFts5(driver)).resolves.toMatchObject({ usable: true });
  });
});

describe('on a build without FTS5', () => {
  it('reports unusable and throws an error naming the build settings', async () => {
    const blind = new RewritingDriver('expo-sqlite (ios, enableFTS=false)', driver, (sql) => {
      if (/using\s+fts5/i.test(sql)) throw new Error('no such module: fts5');
      return sql;
    });

    const capability = await detectFts5(blind);
    expect(capability.usable).toBe(false);
    expect(capability.createsOcrFtsTable).toBe(false);
    expect(capability.notes.join(' ')).toMatch(/no such module: fts5/);

    const error = await assertFts5(blind).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Fts5UnavailableError);
    expect((error as Error).message).toContain('expo.sqlite.enableFTS');
    expect((error as Error).message).toContain('useLibSQL');
    // The report travels with the error so a diagnostics screen can show what was observed.
    expect((error as Fts5UnavailableError).capability.usable).toBe(false);
  });
});

describe('on a build where FTS5 exists but behaves differently', () => {
  it('catches a tokenizer that does not fold diacritics', async () => {
    // An older SQLite accepts `remove_diacritics 2` only from 3.27. Dropping the option
    // reproduces what a pre-3.27 build effectively gives you: the table is created, search
    // works, and `cafe` silently stops matching `Café`.
    const stripped = new RewritingDriver('sqlite (remove_diacritics 0)', driver, (sql) =>
      sql.replace(
        "tokenize='unicode61 remove_diacritics 2'",
        "tokenize='unicode61 remove_diacritics 0'",
      ),
    );

    const capability = await detectFts5(stripped);

    expect(capability.createsOcrFtsTable).toBe(true);
    expect(capability.foldsDiacritics).toBe(false);
    expect(capability.usable).toBe(false);
    expect(capability.notes.join(' ')).toMatch(/did not fold diacritics/);
    await expect(assertFts5(stripped)).rejects.toThrow(Fts5UnavailableError);
  });
});
