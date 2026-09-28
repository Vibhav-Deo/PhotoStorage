/**
 * The device database schema, as an ordered list of forward-only migrations.
 *
 * The SQL here is transcribed from the "Device SQLite schema" section of `design.md`, which
 * is the authority. It is reproduced rather than generated for one reason: a migration that
 * has run on a user's device is history, and history does not get regenerated. Version 1 is
 * whatever version 1 was on the day it shipped, so its statements are literal text that a
 * later change must not be able to reach. Schema changes append a version; they never edit
 * one.
 *
 * ## Numeric column values
 *
 * Several columns store the state values from `states.ts`, and five of the indexes are
 * *partial*, which puts those numbers inside the DDL itself — `WHERE remote_state <> 2`
 * means "not verified" only for as long as `RemoteState.Verified` is 2. The numbers are
 * written as literals here (a migration cannot interpolate a constant that a later release
 * might change and still be history), and `schema.test.ts` asserts each predicate against
 * the constant it encodes. A renumbering in `states.ts` therefore fails a test in this
 * package rather than quietly inverting an index's meaning.
 *
 * ## Why the indexes are partial
 *
 * These five are load-bearing rather than incidental:
 *
 * | Index | Serves |
 * |---|---|
 * | `idx_assets_timeline` | The timeline. Tombstones are never hard-deleted (Req 8.3), so the partial predicate is what keeps them out of the hottest scan in the app (Req 4.1, 4.3). |
 * | `idx_assets_pending` | "What still needs uploading." Excludes the verified majority, so the index stays small as the library converges. |
 * | `idx_assets_purgable` | "What can be reclaimed." Matches a single state, so the index holds only candidates. |
 * | `idx_local_unhashed` | The ingest work list. Shrinks to nothing as hashing completes. |
 * | `idx_jobs_runnable` | Claiming the next job. Excludes `done` and `dead`, which accumulate forever. |
 *
 * In each case the excluded rows are the ones that grow without bound, which is what makes
 * the predicate worth its awkwardness.
 */

/** One forward-only schema change. Applied whole, inside a transaction, or not at all. */
export interface Migration {
  /** 1-based, contiguous, ascending. The value written to `schema_meta`. */
  readonly version: number;
  /** Human-readable label. Appears in errors and in the migration result. */
  readonly name: string;
  /**
   * Executed in order, one statement per driver call so a failure can name the statement.
   * No statement may open or close a transaction — the runner owns that.
   */
  readonly statements: readonly string[];
}

/**
 * The `ocr_fts` declaration, verbatim from the design including the tokenizer options.
 *
 * Exported because spike 0.2 established that this exact declaration is the thing worth
 * probing: `remove_diacritics 2` needs SQLite 3.27+, and a build with FTS5 compiled out
 * fails here rather than anywhere earlier. The capability detector creates a copy of it
 * under a probe name, so the schema and the check can never drift apart.
 */
export const OCR_FTS_DDL =
  "CREATE VIRTUAL TABLE ocr_fts USING fts5(hash UNINDEXED, text, tokenize='unicode61 remove_diacritics 2')";

/**
 * `schema_meta` is the runner's own bookkeeping, so it is created with `IF NOT EXISTS` and
 * the runner also creates it before reading the version. It appears in migration 1 as well
 * so that the migration list remains a complete description of the schema.
 */
export const SCHEMA_META_DDL =
  'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)';

const MIGRATION_1_INITIAL: Migration = {
  version: 1,
  name: 'initial-schema',
  statements: [
    // One row per unique piece of content. Content-addressed, so this is the dedupe boundary.
    `CREATE TABLE assets (
  hash              TEXT PRIMARY KEY,          -- sha256 hex of original bytes
  kind              INTEGER NOT NULL,          -- 0=image 1=video 2=motion_component
  byte_size         INTEGER NOT NULL,
  mime              TEXT NOT NULL,
  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,                   -- video only
  captured_at       INTEGER NOT NULL,          -- epoch ms, authoritative
  captured_at_src   INTEGER NOT NULL,          -- 0=exif 1=takeout_json 2=file_mtime 3=user
  tz_offset_min     INTEGER,
  lat               REAL,
  lon               REAL,
  camera_make       TEXT,
  camera_model      TEXT,
  orientation       INTEGER,
  thumbhash         BLOB NOT NULL,             -- ~25 bytes, never evicted (Req 4.5)
  live_pair_hash    TEXT,                      -- companion asset for Live Photos
  variant_of_hash   TEXT,                      -- set for '-edited' Takeout variants (Req 1.5)
  favorite          INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                   -- tombstone; never hard-deleted (Req 8.3)
  remote_state      INTEGER NOT NULL,          -- 0=local_only 1=uploading 2=verified 3=failed
  local_state       INTEGER NOT NULL,          -- 0=absent 1=present 2=purge_eligible 3=purged
  tier_state        INTEGER NOT NULL DEFAULT 0,-- 0=instant 1=cold 2=restoring (Req 12.1)
  derivative_mask   INTEGER NOT NULL DEFAULT 0,-- bitfield of derivatives confirmed present
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0 -- server-assigned sync version
)`,

    // Timeline is the hottest query. Partial index excludes tombstones from the scan.
    'CREATE INDEX idx_assets_timeline ON assets(captured_at DESC) WHERE deleted_at IS NULL',
    'CREATE INDEX idx_assets_version  ON assets(version)',
    'CREATE INDEX idx_assets_pending  ON assets(remote_state) WHERE remote_state <> 2',
    'CREATE INDEX idx_assets_purgable ON assets(local_state)  WHERE local_state = 2',

    // Platform photo library identifiers. Separate table because one hash may map to several
    // local ids (camera roll duplicates), and local ids are device-scoped and never sync.
    `CREATE TABLE local_assets (
  local_id     TEXT PRIMARY KEY,               -- PHAsset.localIdentifier | MediaStore _ID
  hash         TEXT REFERENCES assets(hash),   -- NULL until hashed
  platform     INTEGER NOT NULL,               -- 0=ios 1=android
  hash_state   INTEGER NOT NULL,               -- 0=pending 1=done 2=unreadable
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
)`,
    'CREATE INDEX idx_local_unhashed ON local_assets(hash_state) WHERE hash_state = 0',

    // Slot mapping into the packed coarse vector buffer. The vectors themselves are NOT
    // stored as rows — see coarse.bin in the design.
    `CREATE TABLE vector_slots (
  slot      INTEGER PRIMARY KEY,               -- byte offset = slot * coarse_dim
  hash      TEXT NOT NULL UNIQUE REFERENCES assets(hash),
  model_id  TEXT NOT NULL
)`,
    'CREATE INDEX idx_vector_slots_model ON vector_slots(model_id)',

    // Full-precision vectors, used only to rerank the coarse candidate set. Point lookups
    // only, never scanned. Nullable and evictable; the coarse buffer is what search needs.
    `CREATE TABLE vector_full (
  hash      TEXT PRIMARY KEY REFERENCES assets(hash),
  model_id  TEXT NOT NULL,
  vec       BLOB NOT NULL                      -- fp16, nativeDim
)`,

    OCR_FTS_DDL,

    `CREATE TABLE albums (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  deleted_at INTEGER,
  version    INTEGER NOT NULL DEFAULT 0
)`,

    // Membership is by reference, so an asset in many albums is still stored once (Req 3.5).
    `CREATE TABLE album_members (
  album_id TEXT NOT NULL REFERENCES albums(id),
  hash     TEXT NOT NULL REFERENCES assets(hash),
  position INTEGER,
  PRIMARY KEY (album_id, hash)
)`,

    // Durable work queue. Every pipeline stage is a job so ingest is resumable across
    // process death, reboot, and network loss (Req 2.4, 1.9).
    `CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            INTEGER NOT NULL,            -- see IngestStage
  hash            TEXT,
  local_id        TEXT,
  priority        INTEGER NOT NULL DEFAULT 100,-- lower runs first
  state           INTEGER NOT NULL DEFAULT 0,  -- 0=pending 1=running 2=done 3=failed 4=dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
)`,
    'CREATE INDEX idx_jobs_runnable ON jobs(priority, next_attempt_at) WHERE state IN (0, 3)',

    // Bounded thumbnail cache accounting. Managed explicitly rather than delegated to the
    // image library, because a hard size cap and LRU eviction are required from first
    // release (Req 12.2).
    `CREATE TABLE thumb_cache (
  key           TEXT PRIMARY KEY,              -- object key
  bytes         INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL
)`,
    'CREATE INDEX idx_thumb_cache_lru ON thumb_cache(last_accessed)',

    // Deletion audit trail. User-inspectable, never auto-pruned (Req 6.8, 6.10).
    `CREATE TABLE purge_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  hash               TEXT NOT NULL,
  local_id           TEXT NOT NULL,
  remote_key         TEXT NOT NULL,
  remote_etag        TEXT,
  byte_size          INTEGER NOT NULL,
  verify_method      INTEGER NOT NULL,         -- 0=full_redownload_sha256
  verified_at        INTEGER NOT NULL,
  purge_requested_at INTEGER,
  purge_confirmed_at INTEGER,
  outcome            INTEGER                   -- 0=purged 1=declined 2=failed
)`,

    'CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT)',
    SCHEMA_META_DDL,
  ],
};

/**
 * Every migration, in ascending version order. Append only.
 *
 * The runner validates the shape of this list rather than trusting it, because a duplicated
 * or skipped version would make `schema_meta` disagree with what is actually in the
 * database.
 */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_1_INITIAL];

/** The version a fully migrated database reports. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
