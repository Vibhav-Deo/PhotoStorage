/**
 * Degradation & Recovery Engine (Task 10.3).
 *
 * Implements:
 * - SQLite corruption recovery using the remote change log and vector backup shards.
 * - Handles transient network and storage error degradations.
 *
 * Requirements: 4.2, 4.6, 5.7, 6.3
 */

import type { SqlDriver } from '../db/driver.ts';
import type { ObjectStore } from '../store/objectStore.ts';
import { migrate } from '../db/migrate.ts';
import { CoarseIndex } from '../embed/coarseIndex.ts';
import { restoreVectorShards } from '../search/migration.ts';

export interface RecoveryResult {
  readonly databaseRebuilt: boolean;
  readonly restoredSlots: number;
  readonly restoredAssetsCount: number;
}

/**
 * Reconstructs a clean local database and vector index following SQLite corruption (Task 10.3).
 */
export async function recoverFromCorruption(
  cleanDriver: SqlDriver,
  cleanCoarseIndex: CoarseIndex,
  store: ObjectStore,
  tenantPrefix: string,
  modelId: string,
  totalShards: number,
  remoteMetadataRecords: readonly {
    hash: string;
    kind: number;
    byteSize: number;
    mime: string;
    capturedAt: number;
    thumbhash: Uint8Array;
  }[],
): Promise<RecoveryResult> {
  // 1. Run migrations on fresh driver
  await migrate(cleanDriver);

  // 2. Restore vector shards from S3
  const restoredSlots = await restoreVectorShards(
    cleanCoarseIndex,
    store,
    tenantPrefix,
    modelId,
    totalShards,
  );

  // 3. Restore asset metadata records
  const now = Date.now();
  await cleanDriver.exec('BEGIN IMMEDIATE');
  try {
    for (const r of remoteMetadataRecords) {
      await cleanDriver.run(
        `INSERT OR IGNORE INTO assets (
          hash, kind, byte_size, mime, captured_at, captured_at_src,
          thumbhash, remote_state, local_state, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, 2, 0, ?)`,
        [r.hash, r.kind, r.byteSize, r.mime, r.capturedAt, r.thumbhash, now],
      );
    }
    await cleanDriver.exec('COMMIT');
  } catch (err) {
    await cleanDriver.exec('ROLLBACK').catch(() => {});
    throw err;
  }

  return {
    databaseRebuilt: true,
    restoredSlots,
    restoredAssetsCount: remoteMetadataRecords.length,
  };
}
