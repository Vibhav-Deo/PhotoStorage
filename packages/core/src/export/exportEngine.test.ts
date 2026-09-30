import { describe, expect, it } from 'vitest';
import {
  fetchOriginalForExport,
  injectMetadataIntoExport,
  planBulkExport,
  executeBulkExport,
} from './exportEngine.ts';
import { LocalFsObjectStore } from '../store/localFsObjectStore.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import { TierState, RemoteState, LocalState } from '../states.ts';
import { origKey } from '../keys.ts';
import { hashBytes } from '../hash/contentHash.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('Export Engine (Phase 9)', () => {
  it('handles original fetch and tier_state transitions (Task 9.1)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-export-test-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const tenant = 'usr_export';
    const originalBytes = new TextEncoder().encode('pristine original photo content');
    const { hash } = await hashBytes(originalBytes);
    const key = origKey(tenant, hash);
    await store.put(key, originalBytes);

    // 1. Instant tier: immediately ready
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, tier_state, updated_at)
       VALUES (?, 0, ?, 'image/jpeg', 1000, 0, X'00', ?, ?, ?, ?)`,
      [hash, originalBytes.byteLength, RemoteState.Verified, LocalState.Present, TierState.Instant, 1000],
    );

    const resInstant = await fetchOriginalForExport(store, driver, tenant, hash);
    expect(resInstant.status).toBe('ready');
    if (resInstant.status === 'ready') {
      expect(new TextDecoder().decode(resInstant.bytes)).toBe('pristine original photo content');
    }

    // 2. Cold tier: initiates restore, transitions to Restoring
    const coldHash = 'c'.repeat(64);
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, tier_state, updated_at)
       VALUES (?, 0, 100, 'image/jpeg', 1000, 0, X'00', ?, ?, ?, ?)`,
      [coldHash, RemoteState.Verified, LocalState.Purged, TierState.Cold, 1000],
    );

    let restoreInitiated = false;
    const resCold = await fetchOriginalForExport(store, driver, tenant, coldHash, async () => {
      restoreInitiated = true;
    });

    expect(restoreInitiated).toBe(true);
    expect(resCold.status).toBe('restoring');

    // Confirm DB updated to Restoring
    const row = await driver.all<{ tier_state: number }>(
      'SELECT tier_state FROM assets WHERE hash = ?',
      [coldHash],
    );
    expect(row[0]?.tier_state).toBe(TierState.Restoring);

    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('injects corrected metadata while asserting stored original is untouched (Task 9.2)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-meta-test-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const tenant = 'usr_export';

    const pristineBytes = new TextEncoder().encode('original camera image bytes');
    const { hash: pristineHash } = await hashBytes(pristineBytes);
    const key = origKey(tenant, pristineHash);
    await store.put(key, pristineBytes);

    // Inject corrected metadata into an export copy
    const exportedCopy = await injectMetadataIntoExport(pristineBytes, {
      capturedAt: 1715000000000,
      cameraMake: 'Leica',
      cameraModel: 'M11',
      lat: 37.7749,
      lon: -122.4194,
    });

    // 1. Exported copy contains corrected metadata
    const exportedText = new TextDecoder().decode(exportedCopy);
    expect(exportedText).toContain('PhotoArchiveMetadata');
    expect(exportedText).toContain('Leica');
    expect(exportedText).toContain('M11');

    // 2. Critical Invariant: The stored original in the archive is UNTOUCHED
    const storedStream = await store.get(key);
    const reader = storedStream.getReader();
    const storedChunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) storedChunks.push(value);
    }
    const storedBytes = Buffer.concat(storedChunks);

    // Stored original still hashes to its exact content-addressed key
    const { hash: verifiedHash } = await hashBytes(storedBytes);
    expect(verifiedHash).toBe(pristineHash);
    expect(Buffer.compare(storedBytes, Buffer.from(pristineBytes))).toBe(0);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('discloses bulk transfer size beforehand from SQLite and exports batch (Task 9.3)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-bulk-test-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const tenant = 'usr_export';

    // Seed two assets with known sizes
    const b1 = new TextEncoder().encode('photo 1');
    const b2 = new TextEncoder().encode('photo 2 with longer bytes');
    const h1 = (await hashBytes(b1)).hash;
    const h2 = (await hashBytes(b2)).hash;

    await store.put(origKey(tenant, h1), b1);
    await store.put(origKey(tenant, h2), b2);

    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, tier_state, updated_at)
       VALUES (?, 0, ?, 'image/jpeg', 1000, 0, X'00', 2, 1, 0, 1000),
              (?, 0, ?, 'image/jpeg', 2000, 0, X'00', 2, 1, 0, 2000)`,
      [h1, b1.byteLength, h2, b2.byteLength],
    );

    // 1. Plan discloses transfer size beforehand from local SQLite byte_size
    const plan = await planBulkExport(driver);
    expect(plan.assetCount).toBe(2);
    expect(plan.totalBytes).toBe(b1.byteLength + b2.byteLength);

    // 2. Execute bulk export
    const writtenFiles = new Map<string, Uint8Array>();
    const progress = await executeBulkExport(store, driver, tenant, plan, async (hash, data) => {
      writtenFiles.set(hash, data);
    });

    expect(progress.completedCount).toBe(2);
    expect(progress.failedCount).toBe(0);
    expect(writtenFiles.has(h1)).toBe(true);
    expect(writtenFiles.has(h2)).toBe(true);

    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
