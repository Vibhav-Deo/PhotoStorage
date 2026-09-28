/**
 * Deduplication: one asset per digest, one source reference per place the bytes were found
 * (Requirement 3.2).
 *
 * This is not a space optimization bolted onto ingest. It is the product's premise. The same
 * photo almost always exists in *both* Google Photos and iCloud, so a two-source migration
 * collapses a large fraction of its items on the way in — and it collapses them before the
 * expensive work, because a digest that is already known needs no decode, no derivative, no
 * embedding, and no upload. Getting this wrong does not merely waste bytes; it doubles every
 * per-item cost in the pipeline and shows the user their library twice.
 *
 * ## Where the two references live
 *
 * `assets` is keyed by hash and is the dedupe boundary — one row per unique piece of content.
 * Source references are deliberately elsewhere, because they are many-to-one and because they
 * are not portable: the schema's own comment says a hash may map to several local ids, and
 * local ids are device-scoped and never sync.
 *
 * - **Device sources** live in `local_assets`, one row per `PHAsset.localIdentifier` or
 *   MediaStore `_ID`. Two camera-roll duplicates are two rows pointing at one hash.
 * - **Takeout sources** are paths within a logical export, and have no table. That is
 *   correct rather than missing: they are meaningful only during an import run, they are not
 *   device state, and nothing after the reconciliation report reads them. {@link DedupeLedger}
 *   is where an import run holds them, and task 2.12's report is what they feed.
 *
 * So {@link AssetSource} spans both, and there are two layers here on purpose:
 *
 * | Layer | Scope | Used by |
 * |---|---|---|
 * | {@link DedupeLedger} | In memory, one run, any source kind | Takeout importer (Phase 2) |
 * | {@link resolveDedupe} / {@link bindDeviceSource} | SQLite, durable, device sources | Device ingest (Phase 7) |
 *
 * ## The ordering constraint, which is not obvious
 *
 * `local_assets.hash` is `REFERENCES assets(hash)` and foreign keys are enforced
 * (`CONNECTION_PRAGMAS`), while `assets` declares `captured_at` and `thumbhash` `NOT NULL`.
 * The asset row therefore cannot exist until `ExtractMeta` and `Derive` have run, which is
 * *after* `Hash`. A digest computed at the `Hash` stage consequently has nowhere to live in
 * `local_assets` yet, and travels in `jobs.hash` — which carries no foreign key — until the
 * asset row exists.
 *
 * {@link bindDeviceSource} therefore refuses rather than letting SQLite raise a bare
 * `FOREIGN KEY constraint failed`, whose message says nothing about sequencing.
 *
 * ## The Android redaction tripwire
 *
 * Open question 7 in `design.md` is the most consequential unresolved item in the project: on
 * Android 10+, bytes read through MediaStore have location EXIF stripped unless the app holds
 * `ACCESS_MEDIA_LOCATION` and calls `MediaStore.setRequireOriginal`. Redacted bytes are
 * different bytes, so they hash differently — meaning the pipeline could hash a redacted copy,
 * upload it, verify *it*, and then delete the true original with every check passing.
 *
 * Task 7.2 owns the fix. What is cheap to do here is make a divergence *loud*: a local asset
 * whose recorded digest changes between two reads is exactly what the redaction bug looks
 * like from this side, since granting or losing `ACCESS_MEDIA_LOCATION` changes the bytes the
 * same asset yields. {@link bindDeviceSource} refuses to overwrite a recorded digest with a
 * different one and throws {@link SourceHashDivergenceError}, which names the hazard. That
 * converts a silent, irreversible failure into a per-item error. It does not detect a library
 * that has been redacted consistently from the first read — nothing at this layer can — which
 * is why 7.2 still has to hold the permission and call `setRequireOriginal`.
 */

import { isContentHash } from '../keys.ts';
import type { SqlDriver } from '../db/driver.ts';
import type { ContentHash } from '../hash/contentHash.ts';
import { HashState, Platform } from '../states.ts';

// ---------------------------------------------------------------------------
// Source references
// ---------------------------------------------------------------------------

/**
 * A place bytes were found. One asset may have many.
 *
 * The `kind` discriminants are strings rather than the numeric `const` objects in `states.ts`
 * because — unlike every value in that file — these are **not persisted**: a device source's
 * durable form is a `local_assets` row, and a Takeout source's durable form is a line in the
 * reconciliation report. Nothing reinterprets an old row if these strings change.
 */
export type AssetSource = DeviceSource | TakeoutSource;

/** An item in the device photo library. Persists as a `local_assets` row. */
export interface DeviceSource {
  readonly kind: 'device';
  /** `PHAsset.localIdentifier` on iOS, MediaStore `_ID` on Android. */
  readonly localId: string;
  readonly platform: Platform;
}

/** A media file inside a Google Takeout export. Lives only for the duration of an import. */
export interface TakeoutSource {
  readonly kind: 'takeout';
  /**
   * Path relative to the root of the *logical* export, `/`-separated, so a multi-part archive
   * set yields one flat namespace and the same file cannot be counted once per part
   * (Requirement 1.1).
   */
  readonly path: string;
}

/**
 * A stable string identity for a source reference.
 *
 * Includes the platform for a device source because a `PHAsset.localIdentifier` and a
 * MediaStore `_ID` come from different namespaces and could otherwise collide as bare strings
 * — a library restored across platforms would then have two distinct assets sharing one
 * reference, which is the failure mode dedupe bookkeeping is least able to notice.
 */
export function sourceRefId(source: AssetSource): string {
  return source.kind === 'device'
    ? `device:${String(source.platform)}:${source.localId}`
    : `takeout:${source.path}`;
}

/** Human-readable form for error messages and the reconciliation report. */
export function describeSource(source: AssetSource): string {
  return source.kind === 'device'
    ? `${source.platform === Platform.Ios ? 'iOS' : 'Android'} local asset ${source.localId}`
    : `Takeout file ${source.path}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The same source produced two different digests.
 *
 * On Android this is the signature of open question 7 — see this module's header. Elsewhere it
 * means the file changed between reads, or the read is not returning the bytes it claims to.
 * Either way the asset must not proceed: the digest is the object key and the thing
 * verification compares against, so continuing would archive one set of bytes under a name
 * derived from another.
 */
export class SourceHashDivergenceError extends Error {
  override readonly name = 'SourceHashDivergenceError';
  readonly source: AssetSource;
  readonly recorded: string;
  readonly observed: string;

  constructor(source: AssetSource, recorded: string, observed: string) {
    super(
      `${describeSource(source)} hashed to ${observed} but ${recorded} was already recorded ` +
        'for it. The same source cannot have two digests: on Android this is what EXIF ' +
        'redaction looks like (bytes read through MediaStore have location stripped without ' +
        'ACCESS_MEDIA_LOCATION and setRequireOriginal, and redacted bytes hash differently), ' +
        'and elsewhere it means the original changed between reads. Either way the item must ' +
        'not be uploaded or verified under either digest until it is resolved.',
    );
    this.source = source;
    this.recorded = recorded;
    this.observed = observed;
  }
}

/**
 * Two different byte counts under one digest.
 *
 * A SHA-256 collision would be a first for the world, so in practice this is a corrupted
 * `assets` row or a `byteSize` that came from somewhere other than the hashing pass. It is
 * checked because `byte_size` is what the multipart plan and the export-size disclosure are
 * computed from, and a wrong one produces a composite checksum that can never match.
 */
export class ContentSizeConflictError extends Error {
  override readonly name = 'ContentSizeConflictError';
  readonly hash: string;

  constructor(hash: string, recorded: number, observed: number) {
    super(
      `sha256 ${hash} is recorded as ${String(recorded)} bytes but was just measured at ` +
        `${String(observed)}. One digest cannot describe two sizes; the recorded row or the ` +
        'measurement is wrong, and neither may be used to derive a multipart plan.',
    );
    this.hash = hash;
  }
}

/** A dedupe operation was given something that is not a content hash. A programming error. */
export class InvalidContentHashError extends Error {
  override readonly name = 'InvalidContentHashError';

  constructor(value: string) {
    super(
      `${JSON.stringify(value)} is not a content hash: 64 lowercase hex characters are ` +
        'required, and uppercase is rejected rather than folded so that one set of bytes ' +
        'cannot produce two object keys',
    );
  }
}

/**
 * A digest was bound to a source before the asset row it references existed. See this module's
 * header on the ordering constraint.
 */
export class AssetRowMissingError extends Error {
  override readonly name = 'AssetRowMissingError';
  readonly hash: string;

  constructor(source: AssetSource, hash: string) {
    super(
      `cannot bind ${describeSource(source)} to sha256 ${hash}: no assets row exists for it. ` +
        'local_assets.hash is a foreign key into assets, and the assets row cannot be written ' +
        'until ExtractMeta and Derive have supplied captured_at and thumbhash. Carry the digest ' +
        'in the job row until then.',
    );
    this.hash = hash;
  }
}

function assertContentHashShape(value: string): void {
  if (!isContentHash(value)) throw new InvalidContentHashError(value);
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * What a newly hashed source turned out to be.
 *
 * The distinction is what the pipeline branches on: {@link Duplicate} skips `Derive`, `Embed`,
 * `Ocr`, and both upload stages, since the object and its derivatives already exist under this
 * key. {@link Repeat} additionally means nothing at all changed, which is the normal outcome of
 * resuming an interrupted run (Requirements 1.9, 2.4).
 */
export const Sighting = {
  /** No source had produced this digest before. Run the full pipeline. */
  First: 'first',
  /** Another source already produced it. Record the reference and skip the expensive stages. */
  Duplicate: 'duplicate',
  /** This same source already produced it. Idempotent re-run; nothing to do. */
  Repeat: 'repeat',
} as const;
export type Sighting = (typeof Sighting)[keyof typeof Sighting];

/** The result of offering a hashed source to a dedupe index. */
export interface SightingResult {
  readonly hash: string;
  readonly byteSize: number;
  readonly sighting: Sighting;
  /** Every source now pointing at this digest, the one just recorded included. */
  readonly sources: readonly AssetSource[];
}

// ---------------------------------------------------------------------------
// In-memory ledger: one import run, any source kind
// ---------------------------------------------------------------------------

interface LedgerEntry {
  readonly byteSize: number;
  readonly sources: AssetSource[];
  readonly refIds: Set<string>;
}

/**
 * Dedupe bookkeeping for a single import run.
 *
 * This is the layer the Takeout importer resolves against, because Takeout source references
 * are paths in an export rather than device state and have no table to live in. It is also the
 * layer that answers the reconciliation report's "deduplicated" count and the bytes that count
 * saved (Requirement 1.10).
 *
 * Memory is proportional to distinct digests plus source references, at roughly a hundred bytes
 * each — a few hundred MB at the 500,000-item scale of Requirement 12, and about 1 MB at the
 * reference scale. If that ever becomes the constraint, `assets` is already the durable index
 * and this becomes a cache in front of it; nothing outside this class would change.
 */
export class DedupeLedger {
  private readonly byHash = new Map<string, LedgerEntry>();
  private readonly byRefId = new Map<string, string>();
  private duplicateBytesSaved = 0;

  /**
   * Offers a hashed source to the ledger.
   *
   * @throws {SourceHashDivergenceError} if this source previously produced a different digest.
   * @throws {ContentSizeConflictError} if this digest was previously a different size.
   */
  record(source: AssetSource, content: ContentHash): SightingResult {
    assertContentHashShape(content.hash);

    const refId = sourceRefId(source);
    const previous = this.byRefId.get(refId);
    if (previous !== undefined && previous !== content.hash) {
      throw new SourceHashDivergenceError(source, previous, content.hash);
    }

    const existing = this.byHash.get(content.hash);
    if (existing === undefined) {
      this.byHash.set(content.hash, {
        byteSize: content.byteSize,
        sources: [source],
        refIds: new Set([refId]),
      });
      this.byRefId.set(refId, content.hash);
      return {
        hash: content.hash,
        byteSize: content.byteSize,
        sighting: Sighting.First,
        sources: [source],
      };
    }

    if (existing.byteSize !== content.byteSize) {
      throw new ContentSizeConflictError(content.hash, existing.byteSize, content.byteSize);
    }

    if (existing.refIds.has(refId)) {
      return {
        hash: content.hash,
        byteSize: existing.byteSize,
        sighting: Sighting.Repeat,
        sources: [...existing.sources],
      };
    }

    existing.refIds.add(refId);
    existing.sources.push(source);
    this.byRefId.set(refId, content.hash);
    this.duplicateBytesSaved += existing.byteSize;

    return {
      hash: content.hash,
      byteSize: existing.byteSize,
      sighting: Sighting.Duplicate,
      sources: [...existing.sources],
    };
  }

  /** The digest recorded for `source`, or `null` if it has not been hashed in this run. */
  hashOf(source: AssetSource): string | null {
    return this.byRefId.get(sourceRefId(source)) ?? null;
  }

  /** Every source pointing at `hash`, in the order they were recorded. */
  sourcesOf(hash: string): readonly AssetSource[] {
    return [...(this.byHash.get(hash)?.sources ?? [])];
  }

  /** Distinct pieces of content, and so the number of objects that will be stored. */
  get contentCount(): number {
    return this.byHash.size;
  }

  /** Source references seen, across every kind. Always at least {@link contentCount}. */
  get sourceCount(): number {
    return this.byRefId.size;
  }

  /**
   * Bytes not stored because the content was already known. The headline number in the
   * reconciliation report, and the one that makes a two-source migration's saving visible.
   */
  get bytesSavedByDedupe(): number {
    return this.duplicateBytesSaved;
  }
}

// ---------------------------------------------------------------------------
// Durable resolution against SQLite: device sources
// ---------------------------------------------------------------------------

/** What the database already knows about a freshly computed digest. */
export interface DedupeDecision {
  readonly hash: string;
  readonly byteSize: number;
  /**
   * {@link Sighting.Repeat} when this very source is already bound to this digest,
   * {@link Sighting.Duplicate} when the asset row exists, {@link Sighting.First} otherwise.
   */
  readonly sighting: Sighting;
  /**
   * True when an `assets` row exists for the digest, so `Derive`, `Embed`, `Ocr`, and both
   * upload stages can be skipped and only the source reference needs recording.
   */
  readonly assetExists: boolean;
  /** Device sources already bound to this digest, excluding the one being resolved. */
  readonly otherSources: readonly DeviceSource[];
}

/**
 * Read-only: decides what a freshly computed digest means, without writing anything.
 *
 * Separate from {@link bindDeviceSource} because the two happen at different points. This runs
 * at the end of the `Hash` stage to decide whether the expensive stages are needed at all; the
 * binding can only happen once an `assets` row exists, which for genuinely new content is
 * several stages later (see this module's header).
 *
 * @throws {ContentSizeConflictError} if `assets` records a different size for this digest.
 */
export async function resolveDedupe(
  driver: SqlDriver,
  source: DeviceSource,
  content: ContentHash,
): Promise<DedupeDecision> {
  assertContentHashShape(content.hash);

  const assetRows = await driver.all<{ byte_size: number }>(
    'SELECT byte_size FROM assets WHERE hash = ?',
    [content.hash],
  );
  const recordedSize = assetRows[0]?.byte_size;
  if (recordedSize !== undefined && Number(recordedSize) !== content.byteSize) {
    throw new ContentSizeConflictError(content.hash, Number(recordedSize), content.byteSize);
  }
  const assetExists = recordedSize !== undefined;

  const bound = await deviceSourcesFor(driver, content.hash);
  const refId = sourceRefId(source);
  const otherSources = bound.filter((candidate) => sourceRefId(candidate) !== refId);

  const sighting =
    otherSources.length < bound.length
      ? Sighting.Repeat
      : assetExists || otherSources.length > 0
        ? Sighting.Duplicate
        : Sighting.First;

  return { hash: content.hash, byteSize: content.byteSize, sighting, assetExists, otherSources };
}

export interface BindDeviceSourceOptions {
  /** Epoch milliseconds for `first_seen` / `last_seen`. Injected so tests need no clock. */
  readonly now?: number;
}

/**
 * Records that `source` holds the content identified by `content.hash`, creating or updating
 * its `local_assets` row.
 *
 * Idempotent: rebinding the same source to the same digest updates `last_seen` and nothing
 * else, so a resumed ingest can re-run it freely (Requirement 2.4). Two different local ids
 * bound to one digest produce two rows and one asset, which is Requirement 3.2 in its device
 * form.
 *
 * @throws {SourceHashDivergenceError} if a different digest is already recorded for this
 *   source. See this module's header — on Android this is the EXIF redaction tripwire.
 * @throws {AssetRowMissingError} if no `assets` row exists for the digest yet.
 */
export async function bindDeviceSource(
  driver: SqlDriver,
  source: DeviceSource,
  content: ContentHash,
  options: BindDeviceSourceOptions = {},
): Promise<SightingResult> {
  assertContentHashShape(content.hash);
  const now = options.now ?? Date.now();

  await driver.exec('BEGIN IMMEDIATE');
  try {
    const existing = await driver.all<{ hash: string | null }>(
      'SELECT hash FROM local_assets WHERE local_id = ?',
      [source.localId],
    );
    const recorded = existing[0]?.hash ?? null;
    if (recorded !== null && recorded !== content.hash) {
      throw new SourceHashDivergenceError(source, recorded, content.hash);
    }

    // Checked rather than left to the foreign key, because SQLite's own message is
    // 'FOREIGN KEY constraint failed' with no column, no value, and no hint about stage order.
    const assetRows = await driver.all<{ byte_size: number }>(
      'SELECT byte_size FROM assets WHERE hash = ?',
      [content.hash],
    );
    const recordedSize = assetRows[0]?.byte_size;
    if (recordedSize === undefined) {
      throw new AssetRowMissingError(source, content.hash);
    }
    if (Number(recordedSize) !== content.byteSize) {
      throw new ContentSizeConflictError(content.hash, Number(recordedSize), content.byteSize);
    }

    if (existing.length === 0) {
      await driver.run(
        `INSERT INTO local_assets(local_id, hash, platform, hash_state, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [source.localId, content.hash, source.platform, HashState.Done, now, now],
      );
    } else {
      await driver.run(
        'UPDATE local_assets SET hash = ?, platform = ?, hash_state = ?, last_seen = ? WHERE local_id = ?',
        [content.hash, source.platform, HashState.Done, now, source.localId],
      );
    }

    await driver.exec('COMMIT');

    const sources = await deviceSourcesFor(driver, content.hash);
    return {
      hash: content.hash,
      byteSize: content.byteSize,
      sighting:
        recorded === content.hash
          ? Sighting.Repeat
          : sources.length > 1
            ? Sighting.Duplicate
            : Sighting.First,
      sources,
    };
  } catch (error) {
    // Without the rollback a divergence or a missing asset row would leave the write lock held
    // and the next stage would fail with SQLITE_BUSY instead of the real reason.
    try {
      await driver.exec('ROLLBACK');
    } catch {
      // Intentionally swallowed: a failed rollback usually means the transaction is already
      // gone, and the original error is the one worth reporting.
    }
    throw error;
  }
}

/**
 * Every device source bound to `hash`, ordered by `local_id` so the result is stable.
 *
 * More than one is the normal case, not an anomaly: camera-roll duplicates, and the same photo
 * present on two devices whose libraries both sync here.
 */
export async function deviceSourcesFor(
  driver: SqlDriver,
  hash: string,
): Promise<readonly DeviceSource[]> {
  assertContentHashShape(hash);
  const rows = await driver.all<{ local_id: string; platform: number }>(
    'SELECT local_id, platform FROM local_assets WHERE hash = ? ORDER BY local_id',
    [hash],
  );
  return rows.map((row): DeviceSource => ({
    kind: 'device',
    localId: row.local_id,
    platform: Number(row.platform) as Platform,
  }));
}

/**
 * Marks a local original as unreadable, which is the design's specified handling when the
 * bytes cannot be read or decoded — Android below API 28 for HEIC (spike 0.2), and any corrupt
 * file.
 *
 * Recorded rather than skipped, because an item that was never hashed can never be verified
 * and so can never become purge-eligible, and the user is entitled to know it was left behind
 * (Requirements 1.10, 2.7). The row is created if enumeration has not produced one yet, so the
 * `Hash` stage can report a failure it discovered first.
 */
export async function markSourceUnreadable(
  driver: SqlDriver,
  source: DeviceSource,
  options: BindDeviceSourceOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  await driver.run(
    `INSERT INTO local_assets(local_id, hash, platform, hash_state, first_seen, last_seen)
       VALUES (?, NULL, ?, ?, ?, ?)
       ON CONFLICT(local_id) DO UPDATE SET hash_state = excluded.hash_state,
                                           last_seen = excluded.last_seen`,
    [source.localId, source.platform, HashState.Unreadable, now, now],
  );
}
