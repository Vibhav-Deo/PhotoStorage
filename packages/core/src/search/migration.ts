/**
 * Vector backup and restore (Task 6.7) and Model ID Migration (Task 6.8).
 *
 * Requirements:
 * - 5.8: Vector backup to `{sub}/vec/{modelId}/{shard}.bin` and restore on new device.
 * - 5.9: Detect `model_id` mismatch at startup and enqueue incremental re-embedding.
 */

import type { SqlDriver } from '../db/driver.ts';
import type { ObjectStore } from '../store/objectStore.ts';
import type { CoarseIndex } from '../embed/coarseIndex.ts';
import { COARSE_VECTOR_DIM, DEFAULT_MODEL_ID } from '../embed/embedding.ts';

export const SHARD_SLOT_COUNT = 4096; // 1 MB per shard (4096 * 256 bytes)

export interface VectorBackupManifest {
  readonly modelId: string;
  readonly totalSlots: number;
  readonly shardCount: number;
  readonly createdAt: number;
}

/**
 * Returns remote key for a vector backup shard.
 */
export function vectorShardKey(tenantPrefix: string, modelId: string, shardIndex: number): string {
  const padded = String(shardIndex).padStart(4, '0');
  return `${tenantPrefix}/vec/${modelId}/shard-${padded}.bin`;
}

/**
 * Backs up `coarse.bin` slots in 4096-slot shards to the object store.
 */
export async function backupVectorShards(
  coarseIndex: CoarseIndex,
  store: ObjectStore,
  tenantPrefix: string,
): Promise<{ uploadedShards: number; totalBytes: number }> {
  let uploadedShards = 0;
  let totalBytes = 0;
  let currentShardIndex = 0;

  let currentShardBytes = new Uint8Array(SHARD_SLOT_COUNT * COARSE_VECTOR_DIM);
  let slotsInCurrentShard = 0;

  for await (const slotVec of coarseIndex.scanSlots()) {
    const shardSlot = slotVec.slot % SHARD_SLOT_COUNT;
    const targetShardIndex = Math.floor(slotVec.slot / SHARD_SLOT_COUNT);

    if (targetShardIndex !== currentShardIndex && slotsInCurrentShard > 0) {
      // Flush previous shard
      const key = vectorShardKey(tenantPrefix, coarseIndex.modelId, currentShardIndex);
      const payload = currentShardBytes.slice(0, slotsInCurrentShard * COARSE_VECTOR_DIM);
      await store.put(key, payload, { storageClass: 'INTELLIGENT_TIERING' });
      uploadedShards++;
      totalBytes += payload.byteLength;

      // Reset
      currentShardBytes = new Uint8Array(SHARD_SLOT_COUNT * COARSE_VECTOR_DIM);
      slotsInCurrentShard = 0;
      currentShardIndex = targetShardIndex;
    }

    currentShardBytes.set(slotVec.vector, shardSlot * COARSE_VECTOR_DIM);
    slotsInCurrentShard = Math.max(slotsInCurrentShard, shardSlot + 1);
  }

  // Flush remaining
  if (slotsInCurrentShard > 0) {
    const key = vectorShardKey(tenantPrefix, coarseIndex.modelId, currentShardIndex);
    const payload = currentShardBytes.slice(0, slotsInCurrentShard * COARSE_VECTOR_DIM);
    await store.put(key, payload, { storageClass: 'INTELLIGENT_TIERING' });
    uploadedShards++;
    totalBytes += payload.byteLength;
  }

  return { uploadedShards, totalBytes };
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLen += value.byteLength;
    }
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.byteLength;
  }
  return result;
}

/**
 * Restores coarse vector buffer from shards downloaded from the object store.
 */
export async function restoreVectorShards(
  coarseIndex: CoarseIndex,
  store: ObjectStore,
  tenantPrefix: string,
  modelId: string,
  shardCount: number,
): Promise<number> {
  let restoredSlots = 0;

  for (let i = 0; i < shardCount; i++) {
    const key = vectorShardKey(tenantPrefix, modelId, i);
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await store.get(key);
    } catch {
      continue;
    }

    const shardBytes = await readAllBytes(stream);
    const count = Math.floor(shardBytes.byteLength / COARSE_VECTOR_DIM);

    for (let s = 0; s < count; s++) {
      const slotNum = i * SHARD_SLOT_COUNT + s;
      const slice = shardBytes.slice(s * COARSE_VECTOR_DIM, (s + 1) * COARSE_VECTOR_DIM);
      const vec = new Int8Array(slice.buffer, slice.byteOffset, slice.byteLength);

      // Ensure slot is allocated up to slotNum
      while (coarseIndex.slotCount <= slotNum) {
        await coarseIndex.allocate();
      }
      await coarseIndex.writeVector(slotNum, vec);
      restoredSlots++;
    }
  }

  return restoredSlots;
}

/**
 * Model ID migration check (Task 6.8).
 *
 * Checks if stored vectors belong to an older model than expectedModelId.
 * If there is a mismatch, finds hashes requiring re-embedding and enqueues
 * them into the jobs table with IngestStage.Embed (stage 4).
 * Existing stale vectors stay searchable until replaced.
 */
export async function checkAndEnqueueModelMigration(
  driver: SqlDriver,
  currentModelId = DEFAULT_MODEL_ID,
): Promise<{ staleCount: number; enqueuedCount: number }> {
  // Find distinct model IDs in vector_slots
  const rows = await driver.all<{ model_id: string; cnt: number }>(
    'SELECT model_id, COUNT(*) as cnt FROM vector_slots WHERE model_id <> ? GROUP BY model_id',
    [currentModelId],
  );

  let staleCount = 0;
  for (const r of rows) {
    staleCount += r.cnt;
  }

  if (staleCount === 0) {
    return { staleCount: 0, enqueuedCount: 0 };
  }

  // Find all hashes that have a stale vector and no fresh vector
  const staleHashes = await driver.all<{ hash: string }>(
    `SELECT hash FROM vector_slots WHERE model_id <> ?
     EXCEPT
     SELECT hash FROM vector_slots WHERE model_id = ?`,
    [currentModelId, currentModelId],
  );

  // Enqueue Embed jobs for each stale hash
  let enqueued = 0;
  const now = Date.now();
  for (const item of staleHashes) {
    // IngestStage.Embed = 4
    await driver.run(
      `INSERT INTO jobs (kind, hash, priority, state, attempts, next_attempt_at, created_at)
       VALUES (4, ?, 10, 0, 0, ?, ?)`,
      [item.hash, now, now],
    );
    enqueued++;
  }

  return { staleCount, enqueuedCount: enqueued };
}
