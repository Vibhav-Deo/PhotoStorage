import { describe, expect, it } from 'vitest';
import {
  backupVectorShards,
  restoreVectorShards,
  checkAndEnqueueModelMigration,
} from './migration.ts';
import { CoarseIndex, InMemoryCoarseStore } from '../embed/coarseIndex.ts';
import { COARSE_VECTOR_DIM, DEFAULT_MODEL_ID } from '../embed/embedding.ts';
import { LocalFsObjectStore } from '../store/localFsObjectStore.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('Vector Backup & Restore (Task 6.7)', () => {
  it('shards coarse vectors to object store and restores them onto an empty index', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vec-backup-test-'));
    const store = new LocalFsObjectStore({ root: tmpDir });

    const localCoarseStore = new InMemoryCoarseStore();
    const coarseIndex = await CoarseIndex.open(localCoarseStore, localCoarseStore);

    // Populate 10 slots
    for (let i = 0; i < 10; i++) {
      const slot = await coarseIndex.allocate();
      const vec = new Int8Array(COARSE_VECTOR_DIM);
      vec.fill(i + 1);
      await coarseIndex.writeVector(slot, vec);
    }

    const tenantPrefix = 'usr_test123';
    const backupResult = await backupVectorShards(coarseIndex, store, tenantPrefix);
    expect(backupResult.uploadedShards).toBe(1);
    expect(backupResult.totalBytes).toBe(10 * COARSE_VECTOR_DIM);

    // Now restore onto a fresh CoarseIndex
    const restoreCoarseStore = new InMemoryCoarseStore();
    const restoredIndex = await CoarseIndex.open(restoreCoarseStore, restoreCoarseStore);

    const restoredSlots = await restoreVectorShards(
      restoredIndex,
      store,
      tenantPrefix,
      coarseIndex.modelId,
      1,
    );

    expect(restoredSlots).toBe(10);
    const sampleVec = await restoredIndex.readVector(3);
    expect(sampleVec[0]).toBe(4);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

describe('Model Version Migration (Task 6.8)', () => {
  it('detects model ID mismatch and enqueues embed jobs without dropping old vectors', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    // Insert dummy asset rows
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, updated_at)
       VALUES ('h_old1', 0, 100, 'image/jpeg', 1000, 0, X'00', 2, 1, 1000),
              ('h_old2', 0, 100, 'image/jpeg', 2000, 0, X'00', 2, 1, 2000)`,
    );

    // Insert slots with old model_id
    await driver.run(
      `INSERT INTO vector_slots (slot, hash, model_id)
       VALUES (0, 'h_old1', 'legacy-clip-v0'),
              (1, 'h_old2', 'legacy-clip-v0')`,
    );

    const result = await checkAndEnqueueModelMigration(driver, DEFAULT_MODEL_ID);
    expect(result.staleCount).toBe(2);
    expect(result.enqueuedCount).toBe(2);

    // Check jobs table
    const jobs = await driver.all<{ kind: number; hash: string }>(
      'SELECT kind, hash FROM jobs ORDER BY hash',
    );
    expect(jobs).toEqual([
      { kind: 4, hash: 'h_old1' },
      { kind: 4, hash: 'h_old2' },
    ]);

    driver.close();
  });
});
