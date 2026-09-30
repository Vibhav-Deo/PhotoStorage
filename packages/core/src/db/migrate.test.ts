/**
 * The migration runner, against `node:sqlite`.
 *
 * Three things are being established here, in order of how expensive they are to get wrong:
 *
 * 1. **A populated database survives a migration.** The empty case is the easy one and it is
 *    tested first, but the case that matters is the one where the user already has a library:
 *    a migration that drops rows is data loss on a device whose originals may already have
 *    been reclaimed. Every table is populated before the next version is applied, and every
 *    row is read back afterwards.
 * 2. **A failed migration leaves nothing behind.** `schema_meta` is written inside the same
 *    transaction as the statements it describes, so a version can never claim work that did
 *    not complete. That is asserted by deliberately failing a migration halfway.
 * 3. **The partial indexes are actually used.** They exist to make the timeline fast, and an
 *    index the planner declines to use is dead weight that still costs writes. `EXPLAIN QUERY
 *    PLAN` is the only way to know, so it is checked rather than assumed.
 *
 * Node's SQLite is 3.50.4 against the 3.50.3 that `expo-sqlite` vendors, so everything here
 * is a property of SQLite and carries over to the device. What does not carry over is the
 * shipped mobile binary's build configuration, which is why `capability.ts` exists.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { Fts5UnavailableError } from './capability.ts';
import type { SqlDriver, SqlRow, SqlValue } from './driver.ts';
import {
  MigrationError,
  SCHEMA_VERSION_KEY,
  UNMIGRATED_VERSION,
  applyConnectionPragmas,
  currentSchemaVersion,
  migrate,
} from './migrate.ts';
import { NodeSqliteDriver } from './nodeSqliteDriver.ts';
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from './schema.ts';

/** Tables the design's schema defines, excluding FTS5's own shadow tables. */
const DESIGN_TABLES = [
  'album_members',
  'albums',
  'assets',
  'jobs',
  'local_assets',
  'ocr_fts',
  'purge_audit',
  'schema_meta',
  'sync_state',
  'thumb_cache',
  'vector_full',
  'vector_slots',
];

const DESIGN_INDEXES = [
  'idx_assets_pending',
  'idx_assets_purgable',
  'idx_assets_timeline',
  'idx_assets_version',
  'idx_jobs_runnable',
  'idx_local_unhashed',
  'idx_thumb_cache_lru',
  'idx_vector_slots_model',
];

let driver: NodeSqliteDriver;

beforeEach(() => {
  driver = new NodeSqliteDriver();
  return () => {
    driver.close();
  };
});

async function names(target: SqlDriver, type: 'table' | 'index'): Promise<string[]> {
  const rows = await target.all<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type = ? ORDER BY name',
    [type],
  );
  return rows.map((row) => row.name);
}

/**
 * A row in every table, wired together the way real data is: the local asset, the album
 * membership, the vector slot, and the OCR text all reference the asset's hash, so a
 * migration that loses the asset row cannot pass by keeping the others.
 */
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

async function populate(target: SqlDriver): Promise<void> {
  for (const [hash, capturedAt, deletedAt] of [
    [HASH, 1_562_264_551_000, null],
    [OTHER_HASH, 1_562_264_000_000, 1_700_000_000_000],
  ] as const) {
    await target.run(
      `INSERT INTO assets(hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash,
                          favorite, remote_state, local_state, deleted_at, updated_at)
       VALUES (?, 0, 3841204, 'image/heic', ?, 1, ?, ?, 2, 2, ?, 1)`,
      // `favorite` is bound as a boolean on purpose: the driver narrows it to the 0/1 the
      // column stores, and nothing else in the schema would exercise that.
      [hash, capturedAt, new Uint8Array([1, 2, 3, 4]), true, deletedAt],
    );
  }
  await target.run(
    `INSERT INTO local_assets(local_id, hash, platform, hash_state, first_seen, last_seen)
     VALUES ('PH-1', ?, 0, 0, 1, 1)`,
    [HASH],
  );
  await target.run(
    `INSERT INTO albums(id, title, created_at, updated_at) VALUES ('alb-1', 'Summer 2019', 1, 1)`,
  );
  await target.run(`INSERT INTO album_members(album_id, hash, position) VALUES ('alb-1', ?, 0)`, [
    HASH,
  ]);
  await target.run(`INSERT INTO vector_slots(slot, hash, model_id) VALUES (0, ?, 'm1')`, [HASH]);
  await target.run(`INSERT INTO vector_full(hash, model_id, vec) VALUES (?, 'm1', ?)`, [
    HASH,
    new Uint8Array([9, 9]),
  ]);
  await target.run(`INSERT INTO ocr_fts(hash, text) VALUES (?, 'Shibuya ward sign')`, [HASH]);
  await target.run(
    `INSERT INTO jobs(kind, hash, state, next_attempt_at, created_at) VALUES (6, ?, 0, 10, 1)`,
    [HASH],
  );
  await target.run(
    `INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES ('u/th/x.webp', 2048, 5)`,
  );
  await target.run(
    `INSERT INTO purge_audit(hash, local_id, remote_key, byte_size, verify_method, verified_at,
                             outcome)
     VALUES (?, 'PH-1', 'u/orig/x', 3841204, 0, 7, 0)`,
    [HASH],
  );
}

async function count(target: SqlDriver, table: string): Promise<number> {
  const rows = await target.all<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return rows[0]?.n ?? -1;
}

describe('migrating an empty database', () => {
  it('applies every migration and records the version', async () => {
    const result = await migrate(driver);

    expect(result.fromVersion).toBe(UNMIGRATED_VERSION);
    expect(result.toVersion).toBe(SCHEMA_VERSION);
    expect(result.applied.map((entry) => entry.version)).toEqual([1]);
    expect(result.applied[0]?.name).toBe('initial-schema');
    expect(await currentSchemaVersion(driver)).toBe(SCHEMA_VERSION);
  });

  it('creates every table and index the design defines', async () => {
    await migrate(driver);

    const tables = await names(driver, 'table');
    for (const table of DESIGN_TABLES) {
      expect(tables, `missing table ${table}`).toContain(table);
    }
    expect(await names(driver, 'index')).toEqual(expect.arrayContaining(DESIGN_INDEXES));
  });

  it('is a no-op on the second call, which is what startup does', async () => {
    await migrate(driver);
    const again = await migrate(driver);

    expect(again).toEqual({
      fromVersion: SCHEMA_VERSION,
      toVersion: SCHEMA_VERSION,
      applied: [],
    });
  });
});

describe('migrating a populated database', () => {
  /** A realistic next version: one added column, one added index, one backfill. */
  const V2: Migration = {
    version: 2,
    name: 'add-scene-label',
    statements: [
      'ALTER TABLE assets ADD COLUMN scene_label TEXT',
      'CREATE INDEX idx_assets_scene ON assets(scene_label) WHERE scene_label IS NOT NULL',
      "UPDATE assets SET scene_label = 'unlabelled' WHERE scene_label IS NULL",
    ],
  };
  const WITH_V2 = [...MIGRATIONS, V2];

  it('keeps every row and applies only the pending version', async () => {
    await migrate(driver);
    await populate(driver);

    const result = await migrate(driver, { migrations: WITH_V2 });

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(result.applied.map((entry) => entry.version)).toEqual([2]);

    for (const table of [
      'assets',
      'local_assets',
      'albums',
      'album_members',
      'vector_slots',
      'vector_full',
      'jobs',
      'thumb_cache',
      'purge_audit',
    ]) {
      expect(await count(driver, table), `${table} lost rows`).toBeGreaterThan(0);
    }
    expect(await count(driver, 'assets')).toBe(2);

    const rows = await driver.all<{
      hash: string;
      scene_label: string;
      thumbhash: Uint8Array;
      favorite: number;
    }>('SELECT hash, scene_label, thumbhash, favorite FROM assets WHERE hash = ?', [HASH]);
    expect(rows[0]?.scene_label).toBe('unlabelled');
    expect(rows[0]?.favorite).toBe(1);
    // The blob has to survive too — a thumbhash is the only thing standing between a reclaimed
    // original and an empty grid cell (Req 4.5).
    expect(Array.from(rows[0]?.thumbhash ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('leaves the FTS index queryable afterwards', async () => {
    await migrate(driver);
    await populate(driver);
    await migrate(driver, { migrations: WITH_V2 });

    const hits = await driver.all<{ hash: string }>(
      'SELECT hash FROM ocr_fts WHERE ocr_fts MATCH ?',
      ['shibuya'],
    );
    expect(hits.map((hit) => hit.hash)).toEqual([HASH]);
  });

  it('is a no-op once the populated database is current', async () => {
    await migrate(driver);
    await populate(driver);
    await migrate(driver, { migrations: WITH_V2 });

    const again = await migrate(driver, { migrations: WITH_V2 });
    expect(again.applied).toEqual([]);
    expect(await count(driver, 'assets')).toBe(2);
  });
});

describe('forward-only', () => {
  it('refuses a database written by a newer build', async () => {
    await migrate(driver);
    await driver.run('UPDATE schema_meta SET value = ? WHERE key = ?', ['99', SCHEMA_VERSION_KEY]);

    await expect(migrate(driver)).rejects.toThrow(MigrationError);
    await expect(migrate(driver)).rejects.toThrow(/version 99 but this build only knows up to 1/);
  });

  it('refuses bookkeeping that is not a version', async () => {
    await migrate(driver);
    await driver.run('UPDATE schema_meta SET value = ? WHERE key = ?', ['', SCHEMA_VERSION_KEY]);

    // Number('') is 0, which would silently re-run every migration against a populated
    // database. It has to be rejected rather than coerced.
    await expect(currentSchemaVersion(driver)).rejects.toThrow(/not a schema version/);
  });

  it('rejects a migration list with a gap', async () => {
    const gapped = [...MIGRATIONS, { version: 3, name: 'gap', statements: ['SELECT 1'] }];
    await expect(migrate(driver, { migrations: gapped })).rejects.toThrow(
      /contiguous and ascending/,
    );
  });

  it('rejects a migration that controls its own transaction', async () => {
    const committing = [...MIGRATIONS, { version: 2, name: 'sneaky', statements: ['COMMIT'] }];
    await expect(migrate(driver, { migrations: committing })).rejects.toThrow(
      /transaction control/,
    );
  });
});

describe('a failed migration is atomic', () => {
  const BROKEN: Migration = {
    version: 2,
    name: 'broken',
    statements: [
      'CREATE TABLE half_applied (id INTEGER PRIMARY KEY)',
      'CREATE INDEX idx_nope ON not_a_table(column_that_is_not_there)',
    ],
  };

  it('rolls back the whole version and leaves schema_meta alone', async () => {
    await migrate(driver);
    await populate(driver);

    await expect(migrate(driver, { migrations: [...MIGRATIONS, BROKEN] })).rejects.toThrow(
      /migration 2 \(broken\) failed at statement 2 of 2/,
    );

    expect(await currentSchemaVersion(driver)).toBe(1);
    expect(await names(driver, 'table')).not.toContain('half_applied');
    expect(await count(driver, 'assets')).toBe(2);
  });

  it('carries the version on the error', async () => {
    await migrate(driver);
    const error = await migrate(driver, { migrations: [...MIGRATIONS, BROKEN] }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as MigrationError).version).toBe(2);
  });

  it('can be retried once the migration is fixed', async () => {
    await migrate(driver);
    await populate(driver);
    await migrate(driver, { migrations: [...MIGRATIONS, BROKEN] }).catch(() => undefined);

    const fixed: Migration = {
      version: 2,
      name: 'fixed',
      statements: ['CREATE TABLE half_applied (id INTEGER PRIMARY KEY)'],
    };
    const result = await migrate(driver, { migrations: [...MIGRATIONS, fixed] });

    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(2);
    expect(await count(driver, 'assets')).toBe(2);
  });
});

describe('the partial indexes are used, not merely present', () => {
  async function plan(sql: string): Promise<string> {
    const rows = await driver.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`);
    return rows.map((row) => row.detail).join(' | ');
  }

  beforeEach(async () => {
    await migrate(driver);
    await populate(driver);
  });

  it('serves the timeline query without sorting', async () => {
    const detail = await plan(
      'SELECT hash FROM assets WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 100',
    );

    expect(detail).toContain('idx_assets_timeline');
    // A TEMP B-TREE here would mean the index supplied the rows but not the order, which at
    // 500,000 assets is the difference between a scrolling grid and a stalled one.
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('returns the timeline excluding tombstones', async () => {
    const rows = await driver.all<{ hash: string }>(
      'SELECT hash FROM assets WHERE deleted_at IS NULL ORDER BY captured_at DESC',
    );
    expect(rows.map((row) => row.hash)).toEqual([HASH]);
  });

  it('serves the upload backlog query', async () => {
    expect(await plan('SELECT hash FROM assets WHERE remote_state <> 2')).toContain(
      'idx_assets_pending',
    );
  });

  it('serves the reclamation candidate query', async () => {
    expect(await plan('SELECT hash FROM assets WHERE local_state = 2')).toContain(
      'idx_assets_purgable',
    );
  });

  it('serves the unhashed local asset query', async () => {
    expect(await plan('SELECT local_id FROM local_assets WHERE hash_state = 0')).toContain(
      'idx_local_unhashed',
    );
  });

  it('serves the job claim query in priority order', async () => {
    const detail = await plan(
      `SELECT id FROM jobs WHERE state IN (0, 3) AND next_attempt_at <= 100
       ORDER BY priority, next_attempt_at LIMIT 1`,
    );
    expect(detail).toContain('idx_jobs_runnable');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('serves LRU eviction order', async () => {
    expect(await plan('SELECT key FROM thumb_cache ORDER BY last_accessed LIMIT 10')).toContain(
      'idx_thumb_cache_lru',
    );
  });
});

describe('connection pragmas', () => {
  it('enable foreign key enforcement, which SQLite leaves off by default', async () => {
    await migrate(driver);
    await driver.exec('PRAGMA foreign_keys = OFF');

    await applyConnectionPragmas(driver);

    const rows = await driver.all<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(rows[0]?.foreign_keys).toBe(1);
    // With enforcement on, a membership row cannot name an album that does not exist — which
    // would otherwise surface as a timeline entry with nothing behind it.
    await expect(
      driver.run(`INSERT INTO album_members(album_id, hash) VALUES ('ghost', ?)`, [HASH]),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe('FTS5 capability', () => {
  /** A driver whose SQLite has FTS5 compiled out, which is what the two Expo build settings produce. */
  class NoFts5Driver implements SqlDriver {
    readonly name = 'node:sqlite (fts5 removed)';
    private readonly inner: NodeSqliteDriver;

    // A field and an assignment rather than a parameter property: `erasableSyntaxOnly` is on
    // repo-wide, and a parameter property is syntax that has to be transformed, not stripped.
    constructor(inner: NodeSqliteDriver) {
      this.inner = inner;
    }

    async exec(sql: string): Promise<void> {
      if (/using\s+fts5/i.test(sql)) throw new Error('no such module: fts5');
      return this.inner.exec(sql);
    }
    async all<TRow extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<TRow[]> {
      return this.inner.all<TRow>(sql, params);
    }
    async run(sql: string, params?: readonly SqlValue[]): Promise<void> {
      return this.inner.run(sql, params);
    }
    async get<TRow extends SqlRow = SqlRow>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<TRow | undefined> {
      return this.inner.get<TRow>(sql, params);
    }
  }

  it('fails before applying anything, and names the build settings that cause it', async () => {
    const blind = new NoFts5Driver(driver);

    const error = await migrate(blind).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Fts5UnavailableError);
    expect((error as Error).message).toMatch(/expo\.sqlite\.enableFTS/);
    expect((error as Error).message).toMatch(/useLibSQL/);
    // Nothing was applied, so the failure is a build-configuration problem rather than a
    // half-created database.
    expect(await currentSchemaVersion(driver)).toBe(UNMIGRATED_VERSION);
    expect(await names(driver, 'table')).toEqual(['schema_meta']);
  });

  it('can be waived, for the token-table fallback path (task 6.4)', async () => {
    const noFtsSchema: Migration[] = [
      { version: 1, name: 'no-fts', statements: ['CREATE TABLE t (id INTEGER PRIMARY KEY)'] },
    ];
    const blind = new NoFts5Driver(driver);

    // No migration declares an FTS5 table, so the assertion does not run at all.
    await expect(migrate(blind, { migrations: noFtsSchema })).resolves.toMatchObject({
      toVersion: 1,
    });
  });
});

describe('property: migrating in stages converges on migrating in one shot', () => {
  /**
   * Synthetic migrations rather than the real ones, because the property is about the runner:
   * whichever versions a database has already seen, continuing from there has to produce the
   * same schema and the same rows as applying everything at once. That is the invariant an app
   * upgrade path depends on — a user who skipped three releases must end up where a fresh
   * install does.
   */
  function synthetic(length: number): Migration[] {
    return Array.from({ length }, (_, index) => {
      const version = index + 1;
      return {
        version,
        name: `synthetic-${String(version)}`,
        statements: [
          `CREATE TABLE t${String(version)} (id INTEGER PRIMARY KEY, note TEXT)`,
          `INSERT INTO t${String(version)}(note) VALUES ('applied at v${String(version)}')`,
        ],
      };
    });
  }

  /** Schema *and* contents, because a migration that runs twice would duplicate its rows. */
  async function snapshot(target: SqlDriver): Promise<string> {
    const objects = await target.all<{ type: string; name: string; sql: string | null }>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    );
    const version = await currentSchemaVersion(target);
    const notes: string[] = [];
    for (const object of objects) {
      if (object.type !== 'table' || object.name === 'schema_meta') continue;
      const rows = await target.all<{ note: string }>(
        `SELECT note FROM ${object.name} ORDER BY id`,
      );
      notes.push(...rows.map((row) => `${object.name}:${row.note}`));
    }
    return JSON.stringify({ version, objects, notes });
  }

  it('holds for any set of intermediate stops', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 6 }), { maxLength: 4 }),
        async (total, rawStops) => {
          const all = synthetic(total);
          const stops = [...new Set(rawStops.filter((stop) => stop <= total))].sort(
            (a, b) => a - b,
          );

          const staged = new NodeSqliteDriver();
          const oneShot = new NodeSqliteDriver();
          try {
            for (const stop of stops) {
              await migrate(staged, { migrations: all.slice(0, stop) });
            }
            await migrate(staged, { migrations: all });
            await migrate(oneShot, { migrations: all });

            expect(await snapshot(staged)).toBe(await snapshot(oneShot));
          } finally {
            staged.close();
            oneShot.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
