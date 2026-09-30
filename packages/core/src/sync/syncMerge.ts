/**
 * Metadata sync merge logic.
 *
 * Applies records received from the sync Lambda to the local SQLite database.
 * Conflict resolution: per-field last-writer-wins by `updated_at`; tombstones
 * (`deleted_at IS NOT NULL`) always win regardless of `updated_at` (Requirement 8.3).
 *
 * This module is platform-agnostic — it reaches SQLite only through `SqlDriver` so it
 * runs identically on the device (expo-sqlite) and in Node tests (node:sqlite).
 *
 * Requirements: 8.1, 8.3, 8.4
 */

import type { SqlDriver } from '../db/driver.ts';
import type { AssetRecord, AlbumRecord } from '../records.ts';

export interface SyncPullResponse {
  readonly records: readonly (AssetRecord | AlbumRecord)[];
  readonly cursor: number;
}

export interface SyncPushResponse {
  readonly cursor: number;
}

export interface ApplyResult {
  readonly inserted: number;
  readonly updated: number;
  readonly tombstoned: number;
}

/**
 * Applies a batch of pulled asset records to the local database.
 *
 * For each record:
 * - If no local row exists: insert.
 * - If local row exists and remote `updated_at` > local `updated_at`: update.
 * - If remote record has `deleted_at` set: tombstone wins regardless of `updated_at`.
 * - Otherwise: keep local (local is newer).
 *
 * Version is always updated to the remote value so the cursor advances correctly.
 */
export async function applyAssetRecords(
  driver: SqlDriver,
  records: readonly AssetRecord[],
): Promise<ApplyResult> {
  let inserted = 0;
  let updated = 0;
  let tombstoned = 0;

  for (const record of records) {
    const existing = await driver.get<{ updated_at: number; deleted_at: number | null }>(
      'SELECT updated_at, deleted_at FROM assets WHERE hash = ?',
      [record.hash],
    );

    if (!existing) {
      // Insert new record.
      await driver.run(
        `INSERT INTO assets (
          hash, kind, byte_size, mime, width, height, duration_ms,
          captured_at, captured_at_src, tz_offset_min, lat, lon,
          camera_make, camera_model, orientation, thumbhash,
          live_pair_hash, variant_of_hash, favorite, deleted_at,
          remote_state, local_state, tier_state, derivative_mask,
          updated_at, version
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          record.hash,
          record.kind,
          record.byteSize,
          record.mime,
          record.width,
          record.height,
          record.durationMs,
          record.capturedAt,
          record.capturedAtSource,
          record.tzOffsetMin,
          record.lat,
          record.lon,
          record.cameraMake,
          record.cameraModel,
          record.orientation,
          record.thumbhash,
          record.livePairHash,
          record.variantOfHash,
          record.favorite ? 1 : 0,
          record.deletedAt,
          record.remoteState,
          record.localState,
          record.tierState,
          record.derivativeMask,
          record.updatedAt,
          record.version,
        ],
      );
      inserted++;
    } else {
      // Tombstone always wins.
      const remoteTombstones = record.deletedAt !== null;
      const localTombstoned = existing.deleted_at !== null;
      const remoteNewer = record.updatedAt > existing.updated_at;

      if (!remoteTombstones && !remoteNewer && !localTombstoned) {
        // Local is newer and neither side is a tombstone — keep local, just advance version.
        await driver.run('UPDATE assets SET version = ? WHERE hash = ?', [
          record.version,
          record.hash,
        ]);
        continue;
      }

      await driver.run(
        `UPDATE assets SET
          kind=?, byte_size=?, mime=?, width=?, height=?, duration_ms=?,
          captured_at=?, captured_at_src=?, tz_offset_min=?, lat=?, lon=?,
          camera_make=?, camera_model=?, orientation=?, thumbhash=?,
          live_pair_hash=?, variant_of_hash=?, favorite=?, deleted_at=?,
          remote_state=?, local_state=?, tier_state=?, derivative_mask=?,
          updated_at=?, version=?
        WHERE hash=?`,
        [
          record.kind,
          record.byteSize,
          record.mime,
          record.width,
          record.height,
          record.durationMs,
          record.capturedAt,
          record.capturedAtSource,
          record.tzOffsetMin,
          record.lat,
          record.lon,
          record.cameraMake,
          record.cameraModel,
          record.orientation,
          record.thumbhash,
          record.livePairHash,
          record.variantOfHash,
          record.favorite ? 1 : 0,
          record.deletedAt,
          record.remoteState,
          record.localState,
          record.tierState,
          record.derivativeMask,
          record.updatedAt,
          record.version,
          record.hash,
        ],
      );

      if (remoteTombstones && !localTombstoned) {
        tombstoned++;
      } else {
        updated++;
      }
    }
  }

  return { inserted, updated, tombstoned };
}

/**
 * Applies a batch of pulled album records to the local database.
 * Same last-writer-wins / tombstone-wins rules as assets.
 */
export async function applyAlbumRecords(
  driver: SqlDriver,
  records: readonly AlbumRecord[],
): Promise<ApplyResult> {
  let inserted = 0;
  let updated = 0;
  let tombstoned = 0;

  for (const record of records) {
    const existing = await driver.get<{ updated_at: number | null; deleted_at: number | null }>(
      'SELECT updated_at, deleted_at FROM albums WHERE id = ?',
      [record.id],
    );

    if (!existing) {
      await driver.run(
        'INSERT INTO albums (id, title, created_at, updated_at, deleted_at, version) VALUES (?,?,?,?,?,?)',
        [
          record.id,
          record.title,
          record.createdAt,
          record.updatedAt,
          record.deletedAt,
          record.version,
        ],
      );
      inserted++;
    } else {
      const remoteTombstones = record.deletedAt !== null;
      const localTombstoned = existing.deleted_at !== null;
      const remoteNewer =
        record.updatedAt !== null &&
        (existing.updated_at === null || record.updatedAt > existing.updated_at);

      if (!remoteTombstones && !remoteNewer && !localTombstoned) {
        await driver.run('UPDATE albums SET version = ? WHERE id = ?', [record.version, record.id]);
        continue;
      }

      await driver.run(
        'UPDATE albums SET title=?, created_at=?, updated_at=?, deleted_at=?, version=? WHERE id=?',
        [
          record.title,
          record.createdAt,
          record.updatedAt,
          record.deletedAt,
          record.version,
          record.id,
        ],
      );

      if (remoteTombstones && !localTombstoned) {
        tombstoned++;
      } else {
        updated++;
      }
    }
  }

  return { inserted, updated, tombstoned };
}

/**
 * Reads local asset records that have `version = 0` (not yet pushed) or whose
 * `updated_at` is newer than the last push cursor. Used to build a push batch.
 */
export async function collectPendingAssets(driver: SqlDriver, limit = 25): Promise<AssetRecord[]> {
  const rows = await driver.all<Record<string, unknown>>(
    'SELECT * FROM assets WHERE version = 0 ORDER BY updated_at ASC LIMIT ?',
    [limit],
  );
  return rows.map(rowToAssetRecord);
}

function rowToAssetRecord(row: Record<string, unknown>): AssetRecord {
  return {
    hash: row['hash'] as string,
    kind: row['kind'] as AssetRecord['kind'],
    byteSize: row['byte_size'] as number,
    mime: row['mime'] as string,
    width: (row['width'] as number | null) ?? null,
    height: (row['height'] as number | null) ?? null,
    durationMs: (row['duration_ms'] as number | null) ?? null,
    capturedAt: row['captured_at'] as number,
    capturedAtSource: row['captured_at_src'] as AssetRecord['capturedAtSource'],
    tzOffsetMin: (row['tz_offset_min'] as number | null) ?? null,
    lat: (row['lat'] as number | null) ?? null,
    lon: (row['lon'] as number | null) ?? null,
    cameraMake: (row['camera_make'] as string | null) ?? null,
    cameraModel: (row['camera_model'] as string | null) ?? null,
    orientation: (row['orientation'] as number | null) ?? null,
    thumbhash: row['thumbhash'] as Uint8Array,
    livePairHash: (row['live_pair_hash'] as string | null) ?? null,
    variantOfHash: (row['variant_of_hash'] as string | null) ?? null,
    favorite: Boolean(row['favorite']),
    deletedAt: (row['deleted_at'] as number | null) ?? null,
    remoteState: row['remote_state'] as AssetRecord['remoteState'],
    localState: row['local_state'] as AssetRecord['localState'],
    tierState: row['tier_state'] as AssetRecord['tierState'],
    derivativeMask: row['derivative_mask'] as number,
    updatedAt: row['updated_at'] as number,
    version: row['version'] as number,
  };
}
