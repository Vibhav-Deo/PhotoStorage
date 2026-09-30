/**
 * The two records that sync.
 *
 * `AssetRecord` and `AlbumRecord` are the shapes carried by `MetadataSync.pull` and
 * `.push`, and they mirror the `assets` and `albums` tables one field per column. Keeping
 * them aligned is deliberate: the change log exists to reconstruct a timeline row on a new
 * device, so a field that is not here cannot survive a device reset (Requirement 8.2).
 *
 * Two conventions worth stating, because both are load-bearing under
 * `exactOptionalPropertyTypes`:
 *
 * - Nullable columns are typed `T | null`, never optional. The distinction between a field
 *   that is absent and one that is explicitly unknown matters for an archive — `lat: null`
 *   records that a photo has no location, whereas a missing `lat` would mean the record was
 *   never populated — so the type system is not allowed to blur them. A row read from
 *   SQLite always has every key.
 * - No field holds a URL or an object key. Keys are computed from the content hash at read
 *   time by `keys.ts` (Requirement 12.4), which is what makes a CDN retrofit or a storage
 *   provider swap free of any data migration.
 *
 * Fields are `readonly` because these records are snapshots. Mutation goes through the
 * repository layer, which writes SQLite and bumps `updatedAt`.
 */

import type {
  AssetKind,
  CapturedAtSource,
  DerivativeMask,
  LocalState,
  RemoteState,
  TierState,
} from './states.ts';

/**
 * One row of the `assets` table: one unique piece of content, keyed by the SHA-256 of its
 * original bytes (Requirement 3.1). This is the deduplication boundary — the same photo
 * arriving from Google Takeout and from the device library converges here (Requirement
 * 3.2), which is why platform photo library identifiers live in a separate `local_assets`
 * table and are not part of this record.
 */
export interface AssetRecord {
  /** SHA-256 hex of the original bytes, lowercase. Primary key and the basis of every key. */
  readonly hash: string;
  readonly kind: AssetKind;
  /** Size of the original in bytes. Local, so bulk export can disclose transfer volume
   *  without any network call (Requirement 7.3). */
  readonly byteSize: number;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  /** Video only. */
  readonly durationMs: number | null;
  /** Epoch milliseconds. Authoritative for timeline ordering. */
  readonly capturedAt: number;
  /** Where {@link capturedAt} came from. Never discarded (Requirement 1.3). */
  readonly capturedAtSource: CapturedAtSource;
  /** Minutes east of UTC at capture time. Null when the original recorded no offset. */
  readonly tzOffsetMin: number | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly cameraMake: string | null;
  readonly cameraModel: string | null;
  /** EXIF orientation, 1-8. */
  readonly orientation: number | null;
  /** ~25 bytes. Retained for every asset regardless of cache eviction (Requirement 4.5). */
  readonly thumbhash: Uint8Array;
  /** The companion half of a Live Photo. */
  readonly livePairHash: string | null;
  /** Set on a Takeout `-edited` variant, pointing at the unedited base (Requirement 1.5). */
  readonly variantOfHash: string | null;
  readonly favorite: boolean;
  /** Tombstone in epoch milliseconds. Rows are never hard-deleted, so a device that has
   *  been offline for a long time still learns about the deletion (Requirement 8.3). */
  readonly deletedAt: number | null;
  readonly remoteState: RemoteState;
  readonly localState: LocalState;
  readonly tierState: TierState;
  readonly derivativeMask: DerivativeMask;
  /** Epoch milliseconds. Drives per-field last-writer-wins conflict resolution. */
  readonly updatedAt: number;
  /** Assigned by the sync relay's atomic counter. Orders delta pulls; 0 until published. */
  readonly version: number;
}

/**
 * One row of the `albums` table. Membership lives in `album_members` and is by reference,
 * so an asset in many albums is still stored once (Requirement 3.5).
 *
 * Albums come from named Takeout folders carrying a `metadata.json`. A `Photos from YYYY`
 * folder is a chronological bucket, not an album, and never produces one of these.
 */
export interface AlbumRecord {
  readonly id: string;
  readonly title: string;
  /** Epoch milliseconds. Null when the source gave no creation time. */
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  /** Tombstone in epoch milliseconds. */
  readonly deletedAt: number | null;
  readonly version: number;
}
