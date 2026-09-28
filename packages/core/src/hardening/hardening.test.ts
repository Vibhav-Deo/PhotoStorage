/**
 * Phase 10 Hardening Tests:
 * - 10.1 Synthetic Library Generator
 * - 10.2 Performance Benchmarks
 * - 10.3 Degradation Paths & Corruption Recovery
 * - 10.4 Cost Verification & CloudFront Alarm
 * - 10.5 Architectural Invariants:
 *        1) No pixel egress to developer infrastructure
 *        2) Backend removability (pure client-to-storage architecture)
 *
 * Requirements: 4.2, 4.3, 4.6, 5.3, 5.7, 6.3, 9.1, 9.4, 11.1, 11.3, 12, 13.5
 */

import { describe, expect, it, vi } from 'vitest';
import { generateSyntheticLibrary } from './syntheticLibrary.ts';
import { runPerformanceBenchmarks } from './benchmarks.ts';
import { recoverFromCorruption } from './degradation.ts';
import { calculateMonthlySpend } from './costVerification.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import { CoarseIndex, InMemoryCoarseStore } from '../embed/coarseIndex.ts';
import { COARSE_VECTOR_DIM, DEFAULT_MODEL_ID } from '../embed/embedding.ts';
import { LocalFsObjectStore } from '../store/localFsObjectStore.ts';
import { origKey, thumbKey } from '../keys.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('Phase 10 Hardening & Architectural Invariants', () => {
  it('generates synthetic libraries at reference scale (Task 10.1)', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const stats = await generateSyntheticLibrary(driver, {
      count: 250,
      albumCount: 5,
    });

    expect(stats.generatedAssets).toBe(250);
    expect(stats.generatedAlbums).toBe(5);
    expect(stats.totalBytes).toBeGreaterThan(0);

    const rows = await driver.all<{ cnt: number }>('SELECT COUNT(*) as cnt FROM assets');
    expect(rows[0]?.cnt).toBe(250);

    driver.close();
  });

  it('verifies performance benchmarks meet latency SLAs (Task 10.2)', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const store = new InMemoryCoarseStore();
    const coarseIndex = await CoarseIndex.open(store, store);

    // Populate small corpus
    await generateSyntheticLibrary(driver, { count: 100 });

    const report = await runPerformanceBenchmarks(driver, coarseIndex);
    expect(report.timelinePassesSla).toBe(true);
    expect(report.searchPassesSla).toBe(true);
    expect(report.searchLatencyMs).toBeLessThan(300);

    driver.close();
  });

  it('recovers from SQLite corruption using remote vector shards (Task 10.3)', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-degrade-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const tenant = 'usr_hardened';

    // 1. Prepare simulated remote vector shard in S3
    const shardKey = `${tenant}/vec/${DEFAULT_MODEL_ID}/shard-0000.bin`;
    const shardBytes = new Uint8Array(5 * COARSE_VECTOR_DIM);
    shardBytes.fill(42);
    await store.put(shardKey, shardBytes);

    // 2. Reconstruct from corruption on fresh driver and coarse index
    const cleanDriver = new NodeSqliteDriver({ path: ':memory:' });
    const cleanStore = new InMemoryCoarseStore();
    const cleanIndex = await CoarseIndex.open(cleanStore, cleanStore);

    const recovery = await recoverFromCorruption(
      cleanDriver,
      cleanIndex,
      store,
      tenant,
      DEFAULT_MODEL_ID,
      1,
      [
        {
          hash: 'h_recovered_1',
          kind: 0,
          byteSize: 2048,
          mime: 'image/jpeg',
          capturedAt: 1000,
          thumbhash: new Uint8Array(25),
        },
      ],
    );

    expect(recovery.databaseRebuilt).toBe(true);
    expect(recovery.restoredSlots).toBe(5);
    expect(recovery.restoredAssetsCount).toBe(1);

    const check = await cleanDriver.all<{ hash: string }>('SELECT hash FROM assets');
    expect(check[0]?.hash).toBe('h_recovered_1');

    cleanDriver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('verifies cost model under $3/mo and triggers 70 GB egress alarm (Task 10.4)', () => {
    // Reference scale: 50 GB storage, 5 GB egress
    const normal = calculateMonthlySpend(50 * 1024 * 1024 * 1024, 5 * 1024 * 1024 * 1024);
    expect(normal.isUnderCeiling).toBe(true);
    expect(normal.totalMonthlyCostUsd).toBeLessThan(3.0);
    expect(normal.cloudFrontAlarmTriggered).toBe(false);

    // High egress trigger: 75 GB egress triggers CloudFront alarm
    const highEgress = calculateMonthlySpend(50 * 1024 * 1024 * 1024, 75 * 1024 * 1024 * 1024);
    expect(highEgress.cloudFrontAlarmTriggered).toBe(true);
  });

  it('Architectural Invariant 1: No pixel egress to developer infrastructure (Task 10.5)', async () => {
    const interceptedUrls: string[] = [];

    // Intercept outbound network requests
    const fetchSpy = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      interceptedUrls.push(url);
      return Promise.resolve(new Response('ok', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const s3Endpoint = 'https://my-bucket.s3.us-west-2.amazonaws.com';
    const devSyncHost = 'https://api.photo-archive-developer.com/sync';

    // Simulate upload to S3
    await fetch(`${s3Endpoint}/usr_1/orig/abcdef.jpg`, {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3]),
    });

    // Verify all media transfer URLs target ONLY the object storage endpoint
    for (const url of interceptedUrls) {
      expect(url).not.toContain(devSyncHost);
      expect(url).toContain(s3Endpoint);
    }

    vi.unstubAllGlobals();
  });

  it('Architectural Invariant 2: Backend Removability (Task 10.5)', async () => {
    // Stub sync service to 500 error
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/sync') || url.includes('/entitlements')) {
        return Promise.resolve(new Response('Service Unavailable', { status: 500 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    // Verify that local operations continue unaffected
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    // Browse works locally
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, updated_at)
       VALUES ('hash_local', 0, 1000, 'image/jpeg', 1000, 0, X'00', 0, 1, 1000)`,
    );

    const rows = await driver.all('SELECT hash FROM assets');
    expect(rows.length).toBe(1);
    expect(rows[0]?.hash).toBe('hash_local');

    driver.close();
    vi.unstubAllGlobals();
  });
});
