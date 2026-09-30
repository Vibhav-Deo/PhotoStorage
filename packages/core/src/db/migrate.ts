/**
 * Forward-only schema migration, keyed on `schema_meta`.
 *
 * The same runner executes on the device against `expo-sqlite` (task 4.4) and in Node
 * against `node:sqlite` (the importer, and the tests in this package). It reaches SQLite
 * only through {@link SqlDriver}, so neither implementation is a dependency of the other and
 * neither can drift ahead of the other on schema.
 *
 * ## Forward-only, and what that rules out
 *
 * There is no `down`. A downgrade path is a promise to be able to discard data correctly,
 * and this database is the only local record of a library that may no longer exist on the
 * device — the whole point of Requirement 6 is deleting the originals. So the only
 * transitions are "apply the next version" and "refuse".
 *
 * Refusal matters as much as application. A database written by a *newer* build than the one
 * now running it is a real situation: a user downgrades an app, or a synced backup is
 * restored onto an older install. Continuing there means running today's queries against
 * tomorrow's schema, and the failure would be a wrong answer rather than an error. So it
 * stops, with the two version numbers in the message.
 *
 * ## Transactions
 *
 * One transaction per migration, not one for the whole run. If version 3 fails, versions 1
 * and 2 stay applied and `schema_meta` says 2, so the next launch resumes at exactly the
 * right place. Wrapping everything in one transaction would instead make a five-version
 * upgrade all-or-nothing, which on a device — where the process can be killed mid-write —
 * turns a recoverable interruption into a repeated one.
 *
 * SQLite is transactional for DDL, which is what makes this work at all: a failed
 * `CREATE INDEX` rolls back the `CREATE TABLE` before it, and `schema_meta` is written
 * inside the same transaction as the statements it describes. The version can therefore never
 * claim a migration that did not fully run.
 *
 * `BEGIN IMMEDIATE` rather than a deferred `BEGIN`, so the write lock is taken up front. A
 * deferred transaction acquires it on first write, which means DDL can fail with `SQLITE_BUSY`
 * partway in — and on a phone the other writer is the app's own background upload queue.
 */

import { assertFts5 } from './capability.ts';
import type { SqlDriver } from './driver.ts';
import { MIGRATIONS, SCHEMA_META_DDL, type Migration } from './schema.ts';

/** The `schema_meta` key holding the applied schema version, as a decimal string. */
export const SCHEMA_VERSION_KEY = 'schema_version';

/** The version reported for a database no migration has touched. */
export const UNMIGRATED_VERSION = 0;

/**
 * Thrown for every migration failure: a malformed migration list, a database from the
 * future, unreadable bookkeeping, or a statement that failed. Carries the version it was
 * working on when there is one, because "which migration" is the first question.
 */
export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  /** The migration being applied, or `undefined` for failures outside a specific version. */
  readonly version: number | undefined;

  constructor(message: string, options?: { readonly version?: number; readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.version = options?.version;
  }
}

export interface MigrateOptions {
  /** Defaults to {@link MIGRATIONS}. Overridden only by tests. */
  readonly migrations?: readonly Migration[];
  /**
   * Assert FTS5 before applying any migration that declares an FTS5 table. Default true.
   *
   * Without it a build whose configuration removed FTS5 fails on `CREATE VIRTUAL TABLE` with
   * a bare "no such module" and the actual cause — `expo.sqlite.enableFTS: false`, or
   * `expo.sqlite.useLibSQL: true` — is nowhere in the message. Turn it off only where a
   * token-table fallback replaces `ocr_fts` (task 6.4).
   */
  readonly assertFts5Capability?: boolean;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly statementCount: number;
}

export interface MigrationResult {
  /** Version found in `schema_meta` before the run. 0 for a new database. */
  readonly fromVersion: number;
  /** Version in `schema_meta` after the run. */
  readonly toVersion: number;
  /** Empty when the database was already current, which is the common case at startup. */
  readonly applied: readonly AppliedMigration[];
}

/**
 * `PRAGMA`s that belong to the connection rather than to the schema, so they have to be
 * re-applied every time a database is opened — they are not persisted and a migration cannot
 * carry them.
 *
 * Only foreign key enforcement, which SQLite leaves *off* by default. The schema's
 * `REFERENCES` clauses would otherwise be documentation: `album_members` could name an asset
 * that does not exist, and `vector_slots` could hold a slot for a hash that was never
 * ingested, both of which surface later as a timeline row with no content behind it.
 */
export const CONNECTION_PRAGMAS: readonly string[] = ['PRAGMA foreign_keys = ON'];

/**
 * Applies {@link CONNECTION_PRAGMAS}. Call once per opened connection, before
 * {@link migrate} — `foreign_keys` is a no-op inside a transaction, so it cannot be set from
 * within a migration.
 */
export async function applyConnectionPragmas(driver: SqlDriver): Promise<void> {
  for (const pragma of CONNECTION_PRAGMAS) {
    await driver.exec(pragma);
  }
}

/**
 * Reads the applied schema version, creating `schema_meta` if it is absent so that a brand
 * new database reads as {@link UNMIGRATED_VERSION} rather than raising.
 */
export async function currentSchemaVersion(driver: SqlDriver): Promise<number> {
  await driver.exec(SCHEMA_META_DDL);
  const rows = await driver.all<{ value: string | null }>(
    'SELECT value FROM schema_meta WHERE key = ?',
    [SCHEMA_VERSION_KEY],
  );
  const raw = rows[0]?.value;
  if (raw === undefined || raw === null) return UNMIGRATED_VERSION;

  // Parsed with a regex rather than `Number`, which reads '' as 0 and ' 2 ' as 2. A blank
  // value coerced to 0 would re-run the initial migration against a populated database.
  const version = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(version)) {
    throw new MigrationError(
      `schema_meta.${SCHEMA_VERSION_KEY} is ${JSON.stringify(raw)}, which is not a schema ` +
        'version. The bookkeeping row has been corrupted; recovering the database is a ' +
        'restore-from-change-log problem, not something a migration can repair.',
    );
  }
  return version;
}

/**
 * Brings the database at `driver` up to the latest version in the migration list, applying
 * only the migrations it has not already seen. Safe to call on every launch; a database that
 * is already current performs one read and no writes.
 */
export async function migrate(
  driver: SqlDriver,
  options: MigrateOptions = {},
): Promise<MigrationResult> {
  const migrations = options.migrations ?? MIGRATIONS;
  assertWellFormed(migrations);

  const latest = migrations[migrations.length - 1]?.version ?? UNMIGRATED_VERSION;
  const fromVersion = await currentSchemaVersion(driver);

  if (fromVersion > latest) {
    throw new MigrationError(
      `the database is at schema version ${fromVersion} but this build only knows up to ` +
        `${latest}. Migration is forward-only and there is no downgrade path, so this build ` +
        'must not touch it — an older build reading a newer schema produces wrong answers ' +
        'rather than errors. Install a build at or above the database version.',
    );
  }

  const pending = migrations.filter((migration) => migration.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [] };
  }

  if ((options.assertFts5Capability ?? true) && pending.some(declaresFts5Table)) {
    await assertFts5(driver);
  }

  const applied: AppliedMigration[] = [];
  for (const migration of pending) {
    await apply(driver, migration);
    applied.push({
      version: migration.version,
      name: migration.name,
      statementCount: migration.statements.length,
    });
  }

  return { fromVersion, toVersion: latest, applied };
}

async function apply(driver: SqlDriver, migration: Migration): Promise<void> {
  await driver.exec('BEGIN IMMEDIATE');
  try {
    for (const [index, statement] of migration.statements.entries()) {
      try {
        await driver.exec(statement);
      } catch (error) {
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) failed at statement ` +
            `${index + 1} of ${migration.statements.length}: ${describe(error)}\n` +
            `  ${firstLine(statement)}`,
          { version: migration.version, cause: error },
        );
      }
    }
    await driver.run(
      `INSERT INTO schema_meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SCHEMA_VERSION_KEY, String(migration.version)],
    );
    await driver.exec('COMMIT');
  } catch (error) {
    // The rollback is what keeps a half-applied version from being recorded. If it fails
    // too, the original error is the one worth reporting — a failed ROLLBACK generally means
    // the transaction was already gone.
    try {
      await driver.exec('ROLLBACK');
    } catch {
      // Intentionally swallowed; see above.
    }
    throw error instanceof MigrationError
      ? error
      : new MigrationError(
          `migration ${migration.version} (${migration.name}) failed: ${describe(error)}`,
          { version: migration.version, cause: error },
        );
  }
}

/**
 * Versions must start at 1 and ascend by exactly one. A gap or a duplicate is not a
 * cosmetic problem: `schema_meta` records a single number, so version 4 existing without
 * version 3 means a database recorded as 4 has never been told what 3 did, and there is no
 * way to notice afterwards.
 */
function assertWellFormed(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new MigrationError('the migration list is empty; there is no schema to apply.');
  }
  for (const [index, migration] of migrations.entries()) {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `migrations must be contiguous and ascending from 1: position ${index} declares ` +
          `version ${migration.version}, expected ${expected}.`,
        { version: migration.version },
      );
    }
    if (migration.statements.length === 0) {
      throw new MigrationError(
        `migration ${migration.version} (${migration.name}) has no statements.`,
        { version: migration.version },
      );
    }
    for (const statement of migration.statements) {
      if (TRANSACTION_CONTROL.test(statement)) {
        throw new MigrationError(
          `migration ${migration.version} (${migration.name}) contains transaction control. ` +
            'The runner owns the transaction; a statement that commits it breaks the guarantee ' +
            'that schema_meta and the schema move together.',
          { version: migration.version },
        );
      }
    }
  }
}

const TRANSACTION_CONTROL = /^\s*(?:begin|commit|end|rollback|savepoint|release)\b/i;

function declaresFts5Table(migration: Migration): boolean {
  return migration.statements.some((statement) => /using\s+fts5/i.test(statement));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(statement: string): string {
  const line = statement.trim().split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
