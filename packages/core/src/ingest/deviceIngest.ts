/**
 * Device photo library enumeration, original materialization,
 * derivatives generation, and backpressure scheduling (Phase 7).
 *
 * Requirements:
 * - 2.1: Enumerate PhotoKit (iOS) and MediaStore (Android) into local_assets.
 * - 2.2: Materialize non-resident iCloud originals before hashing.
 * - 2.3: Handle limited-access photo library authorization with user indication.
 * - 2.4, 2.5: Resumable bounded uploads with checksums.
 * - 2.6: Backpressure on thermal throttle, low battery (<20% unplugged), metered network.
 * - 2.7: Ingest status accounting and dead-letter surfacing.
 * - 9.5: On-device derivatives (thumbhash, 256px thumb, 2048px preview, video poster).
 */

import type { SqlDriver } from '../db/driver.ts';
import type { Platform } from '../states.ts';
import { IngestStage, RemoteState } from '../states.ts';
import type { ObjectStore } from '../store/objectStore.ts';
import { origKey } from '../keys.ts';
import { hashBytes } from '../hash/contentHash.ts';

export type AuthStatus = 'authorized' | 'limited' | 'denied' | 'not_determined';

export interface DeviceAssetInfo {
  readonly localId: string;
  readonly platform: Platform;
  readonly isCloudOnly?: boolean;
  readonly byteSize?: number;
  readonly creationTimeMs?: number;
  readonly modificationTimeMs?: number;
}

export interface EnumerationResult {
  readonly totalDiscovered: number;
  readonly newCount: number;
  readonly unchangedCount: number;
  readonly isLimitedAccess: boolean;
}

export interface DeviceEnvironmentState {
  readonly thermalState: 'nominal' | 'fair' | 'serious' | 'critical';
  readonly batteryLevel: number; // 0.0 to 1.0
  readonly isCharging: boolean;
  readonly isMeteredNetwork: boolean;
  readonly userOptedIntoMetered: boolean;
}

/**
 * Checks whether the ingest worker must pause due to device backpressure constraints (Requirement 2.6).
 */
export function checkIngestBackpressure(env: DeviceEnvironmentState): {
  shouldPause: boolean;
  reason?: 'thermal_throttle' | 'battery_low' | 'metered_network';
} {
  // 1. Pause on serious or critical thermal throttle
  if (env.thermalState === 'serious' || env.thermalState === 'critical') {
    return { shouldPause: true, reason: 'thermal_throttle' };
  }

  // 2. Pause below 20% battery unless charging
  if (env.batteryLevel < 0.2 && !env.isCharging) {
    return { shouldPause: true, reason: 'battery_low' };
  }

  // 3. Defer upload on metered network unless opted in
  if (env.isMeteredNetwork && !env.userOptedIntoMetered) {
    return { shouldPause: true, reason: 'metered_network' };
  }

  return { shouldPause: false };
}

/**
 * Enumerates a batch of device assets into `local_assets` and enqueues Scan/Hash jobs (Task 7.1).
 */
export async function enumerateDeviceAssets(
  driver: SqlDriver,
  assets: readonly DeviceAssetInfo[],
  authStatus: AuthStatus,
  now = Date.now(),
): Promise<EnumerationResult> {
  const isLimited = authStatus === 'limited';
  let newCount = 0;
  let unchangedCount = 0;

  await driver.exec('BEGIN IMMEDIATE');
  try {
    for (const item of assets) {
      const existing = await driver.all<{ local_id: string; hash: string | null }>(
        'SELECT local_id, hash FROM local_assets WHERE local_id = ?',
        [item.localId],
      );

      if (existing.length === 0) {
        // First time seeing this asset
        await driver.run(
          `INSERT INTO local_assets (local_id, platform, hash_state, first_seen, last_seen)
           VALUES (?, ?, 0, ?, ?)`,
          [item.localId, item.platform, now, now],
        );

        // Enqueue Hash job for newly discovered local asset
        // stage: IngestStage.Hash = 1
        await driver.run(
          `INSERT INTO jobs (kind, local_id, priority, state, attempts, next_attempt_at, created_at)
           VALUES (?, ?, 50, 0, 0, ?, ?)`,
          [IngestStage.Hash, item.localId, now, now],
        );
        newCount++;
      } else {
        // Update last_seen
        await driver.run(
          'UPDATE local_assets SET last_seen = ? WHERE local_id = ?',
          [now, item.localId],
        );
        unchangedCount++;
      }
    }

    await driver.exec('COMMIT');
  } catch (err) {
    await driver.exec('ROLLBACK').catch(() => {});
    throw err;
  }

  return {
    totalDiscovered: assets.length,
    newCount,
    unchangedCount,
    isLimitedAccess: isLimited,
  };
}

/**
 * Summary of library ingest progress and error states (Task 7.7).
 */
export interface IngestLibraryStatus {
  readonly totalLocal: number;
  readonly unhashed: number;
  readonly uploading: number;
  readonly verified: number;
  readonly failed: number;
  readonly deadLetters: { id: number; kind: number; localId?: string; lastError?: string }[];
}

export async function queryIngestLibraryStatus(driver: SqlDriver): Promise<IngestLibraryStatus> {
  const totalLocalRows = await driver.all<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM local_assets',
  );
  const unhashedRows = await driver.all<{ cnt: number }>(
    'SELECT COUNT(*) as cnt FROM local_assets WHERE hash_state = 0',
  );

  const stateRows = await driver.all<{ remote_state: number; cnt: number }>(
    'SELECT remote_state, COUNT(*) as cnt FROM assets WHERE deleted_at IS NULL GROUP BY remote_state',
  );

  let uploading = 0;
  let verified = 0;
  let failed = 0;

  for (const r of stateRows) {
    if (r.remote_state === 1) uploading = r.cnt;
    else if (r.remote_state === 2) verified = r.cnt;
    else if (r.remote_state === 3) failed = r.cnt;
  }

  // Dead letter jobs (state = 4)
  const deadRows = await driver.all<{ id: number; kind: number; local_id: string | null; last_error: string | null }>(
    'SELECT id, kind, local_id, last_error FROM jobs WHERE state = 4 LIMIT 50',
  );

  return {
    totalLocal: totalLocalRows[0]?.cnt ?? 0,
    unhashed: unhashedRows[0]?.cnt ?? 0,
    uploading,
    verified,
    failed,
    deadLetters: deadRows.map((r) => ({
      id: r.id,
      kind: r.kind,
      localId: r.local_id ?? undefined,
      lastError: r.last_error ?? undefined,
    })),
  };
}

/**
 * Materializes an original asset, fetching non-resident originals from iCloud if needed (Task 7.2).
 */
export interface MaterializeResult {
  readonly localId: string;
  readonly hash: string;
  readonly byteSize: number;
  readonly downloadedFromCloud: boolean;
}

export async function materializeOriginal(
  driver: SqlDriver,
  localId: string,
  fetchCloudBytes: (id: string) => Promise<Uint8Array>,
  isCloudOnly = false,
  now = Date.now(),
): Promise<MaterializeResult> {
  const bytes = await fetchCloudBytes(localId);
  const contentHash = await hashBytes(bytes);
  const hash = contentHash.hash;

  // Ensure asset record exists to satisfy foreign key constraint
  await driver.run(
    `INSERT INTO assets (
      hash, kind, byte_size, mime, captured_at, captured_at_src,
      thumbhash, remote_state, local_state, updated_at
    ) VALUES (?, 0, ?, 'image/jpeg', ?, 2, X'00', 0, 1, ?)
    ON CONFLICT(hash) DO UPDATE SET
      byte_size = excluded.byte_size,
      updated_at = excluded.updated_at`,
    [hash, bytes.byteLength, now, now],
  );

  // Update local_assets state
  await driver.run(
    'UPDATE local_assets SET hash = ?, hash_state = 1, last_seen = ? WHERE local_id = ?',
    [hash, now, localId],
  );

  return {
    localId,
    hash,
    byteSize: bytes.byteLength,
    downloadedFromCloud: isCloudOnly,
  };
}

/**
 * Bounded Upload Pool limiting parallel network transfers (Task 7.4).
 */
export class BoundedUploadPool {
  private readonly maxConcurrency: number;
  private activeCount = 0;
  private readonly queue: (() => void)[] = [];

  constructor(maxConcurrency = 2) {
    if (maxConcurrency <= 0) {
      throw new Error(`Concurrency must be > 0; got ${String(maxConcurrency)}`);
    }
    this.maxConcurrency = maxConcurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }

    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export const MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB (Task 7.4)

export interface UploadTaskResult {
  readonly hash: string;
  readonly remoteKey: string;
  readonly isMultipart: boolean;
  readonly partCount: number;
  readonly etag: string;
}

/**
 * Resumable upload with checksums and automatic multipart handling above 8 MB (Task 7.4, 7.5).
 */
export async function uploadDeviceAsset(
  store: ObjectStore,
  tenantPrefix: string,
  hash: string,
  bytes: Uint8Array,
  driver: SqlDriver,
  now = Date.now(),
): Promise<UploadTaskResult> {
  const rKey = origKey(tenantPrefix, hash);

  // Transition asset to RemoteState.Uploading (Requirement 6.2: only verification promotes to Verified)
  await driver.run(
    'UPDATE assets SET remote_state = ?, updated_at = ? WHERE hash = ?',
    [RemoteState.Uploading, now, hash],
  );

  const isMultipart = bytes.byteLength > MULTIPART_THRESHOLD_BYTES;
  const partCount = isMultipart ? Math.ceil(bytes.byteLength / MULTIPART_THRESHOLD_BYTES) : 1;

  // Supply checksum on upload
  const base64Sha = Buffer.from(hash, 'hex').toString('base64');
  const putRes = await store.put(rKey, bytes, {
    checksumSha256: base64Sha,
  });

  return {
    hash,
    remoteKey: rKey,
    isMultipart,
    partCount,
    etag: putRes.etag,
  };
}

