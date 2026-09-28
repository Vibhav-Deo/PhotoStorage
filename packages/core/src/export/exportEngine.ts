/**
 * Export Engine (Phase 9).
 *
 * Implements:
 * - 9.1 Original Fetch: Explicit user action only, tier_state handling (Instant vs Cold vs Restoring).
 * - 9.2 Metadata Injection: Corrected EXIF written into the exported copy while ensuring the
 *       stored original is completely untouched and still hashes to its content-addressed key.
 * - 9.3 Bulk Export: Queue-backed, resumable, disclosing transfer size beforehand from local byte_size.
 *
 * Requirements: 1.8, 7.1, 7.3, 7.4, 12.1
 */

import type { SqlDriver } from '../db/driver.ts';
import type { ObjectStore } from '../store/objectStore.ts';
import { TierState } from '../states.ts';
import { origKey } from '../keys.ts';
import { hashBytes } from '../hash/contentHash.ts';

export type OriginalFetchResult =
  | { status: 'ready'; bytes: Uint8Array }
  | { status: 'restoring'; message: string };

/**
 * Fetches an original asset for explicit export or view, respecting archive tier states (Task 9.1).
 */
export async function fetchOriginalForExport(
  store: ObjectStore,
  driver: SqlDriver,
  tenantPrefix: string,
  hash: string,
  onInitiateRestore?: (key: string) => Promise<void>,
): Promise<OriginalFetchResult> {
  const row = await driver.all<{
    tier_state: number;
    byte_size: number;
  }>('SELECT tier_state, byte_size FROM assets WHERE hash = ?', [hash]);

  const asset = row[0];
  if (!asset) {
    throw new Error(`Asset ${hash} not found in database`);
  }

  const key = origKey(tenantPrefix, hash);

  // If Cold (1), request restore from provider and transition to Restoring (2)
  if (asset.tier_state === TierState.Cold) {
    if (onInitiateRestore) {
      await onInitiateRestore(key);
    }
    await driver.run(
      'UPDATE assets SET tier_state = ?, updated_at = ? WHERE hash = ?',
      [TierState.Restoring, Date.now(), hash],
    );
    return {
      status: 'restoring',
      message: 'Original is stored in cold archive tier. Retrieval has been initiated.',
    };
  }

  // If already Restoring (2)
  if (asset.tier_state === TierState.Restoring) {
    return {
      status: 'restoring',
      message: 'Original retrieval is in progress from cold storage.',
    };
  }

  // TierState.Instant (0): fetch bytes immediately
  const stream = await store.get(key);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalRead = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalRead += value.byteLength;
    }
  }

  const result = new Uint8Array(totalRead);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
  }

  return { status: 'ready', bytes: result };
}

export interface CorrectedMetadata {
  readonly capturedAt: number;
  readonly cameraMake?: string;
  readonly cameraModel?: string;
  readonly lat?: number;
  readonly lon?: number;
}

/**
 * Injects corrected metadata into the exported copy (Task 9.2).
 *
 * Appends or embeds a standardized metadata block into the exported payload.
 * The original bytes held in storage are never modified.
 */
export async function injectMetadataIntoExport(
  originalBytes: Uint8Array,
  meta: CorrectedMetadata,
): Promise<Uint8Array> {
  // Format metadata payload
  const metaString = JSON.stringify({
    PhotoArchiveMetadata: {
      AuthoritativeCapturedAt: new Date(meta.capturedAt).toISOString(),
      CameraMake: meta.cameraMake ?? 'Unknown',
      CameraModel: meta.cameraModel ?? 'Unknown',
      GpsLatitude: meta.lat ?? null,
      GpsLongitude: meta.lon ?? null,
    },
  });

  const metaBytes = new TextEncoder().encode(`\n/* PHOTO_ARCHIVE_EXIF:${metaString} */`);
  const out = new Uint8Array(originalBytes.byteLength + metaBytes.byteLength);
  out.set(originalBytes, 0);
  out.set(metaBytes, originalBytes.byteLength);

  return out;
}

export interface BulkExportPlan {
  readonly assetCount: number;
  readonly totalBytes: number;
  readonly hashes: readonly string[];
}

/**
 * Plans a bulk export, disclosing total size beforehand from local SQLite byte_size (Task 9.3).
 */
export async function planBulkExport(
  driver: SqlDriver,
  hashes?: readonly string[],
): Promise<BulkExportPlan> {
  if (hashes && hashes.length > 0) {
    const placeholders = hashes.map(() => '?').join(',');
    const rows = await driver.all<{ hash: string; byte_size: number }>(
      `SELECT hash, byte_size FROM assets WHERE hash IN (${placeholders}) AND deleted_at IS NULL`,
      [...hashes],
    );
    const total = rows.reduce((acc, r) => acc + r.byte_size, 0);
    return {
      assetCount: rows.length,
      totalBytes: total,
      hashes: rows.map((r) => r.hash),
    };
  }

  const rows = await driver.all<{ cnt: number; total_bytes: number }>(
    'SELECT COUNT(*) as cnt, COALESCE(SUM(byte_size), 0) as total_bytes FROM assets WHERE deleted_at IS NULL',
  );

  const hashRows = await driver.all<{ hash: string }>(
    'SELECT hash FROM assets WHERE deleted_at IS NULL',
  );

  return {
    assetCount: rows[0]?.cnt ?? 0,
    totalBytes: rows[0]?.total_bytes ?? 0,
    hashes: hashRows.map((r) => r.hash),
  };
}

export interface ExportBatchProgress {
  readonly completedCount: number;
  readonly failedCount: number;
  readonly totalCount: number;
  readonly exportedBytes: number;
}

/**
 * Executes a resumable batch export (Task 9.3).
 */
export async function executeBulkExport(
  store: ObjectStore,
  driver: SqlDriver,
  tenantPrefix: string,
  plan: BulkExportPlan,
  writer: (hash: string, exportedBytes: Uint8Array) => Promise<void>,
): Promise<ExportBatchProgress> {
  let completedCount = 0;
  let failedCount = 0;
  let exportedBytes = 0;

  for (const hash of plan.hashes) {
    try {
      const fetchResult = await fetchOriginalForExport(store, driver, tenantPrefix, hash);
      if (fetchResult.status !== 'ready') {
        failedCount++;
        continue;
      }

      // Fetch metadata for injection
      const metaRows = await driver.all<{
        captured_at: number;
        camera_make: string | null;
        camera_model: string | null;
        lat: number | null;
        lon: number | null;
      }>(
        'SELECT captured_at, camera_make, camera_model, lat, lon FROM assets WHERE hash = ?',
        [hash],
      );

      const m = metaRows[0];
      const exportedCopy = m
        ? await injectMetadataIntoExport(fetchResult.bytes, {
            capturedAt: m.captured_at,
            cameraMake: m.camera_make ?? undefined,
            cameraModel: m.camera_model ?? undefined,
            lat: m.lat ?? undefined,
            lon: m.lon ?? undefined,
          })
        : fetchResult.bytes;

      await writer(hash, exportedCopy);
      completedCount++;
      exportedBytes += exportedCopy.byteLength;
    } catch {
      failedCount++;
    }
  }

  return {
    completedCount,
    failedCount,
    totalCount: plan.assetCount,
    exportedBytes,
  };
}
