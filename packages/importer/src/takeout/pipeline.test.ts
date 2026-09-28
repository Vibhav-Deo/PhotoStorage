import { LocalFsObjectStore } from '@photo-archive/core/local-fs-store';
import { NodeSqliteDriver } from '@photo-archive/core/node-sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCorpus } from './fixtures/buildCorpus.ts';
import { runTakeoutPipeline } from './pipeline.ts';

describe('runTakeoutPipeline Integration Test', () => {
  let tempDir: string;
  let exportDir: string;
  let storeDir: string;
  let dbFile: string;
  let driver: NodeSqliteDriver;
  let store: LocalFsObjectStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-pipeline-test-'));
    exportDir = path.join(tempDir, 'takeout');
    storeDir = path.join(tempDir, 'store');
    dbFile = path.join(tempDir, 'test.db');

    await fs.mkdir(storeDir, { recursive: true });
    await buildCorpus(exportDir);

    driver = new NodeSqliteDriver({ path: dbFile });
    store = new LocalFsObjectStore({ root: storeDir });
  });

  afterEach(async () => {
    driver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs Takeout importer end-to-end over the fixture corpus', async () => {
    const report = await runTakeoutPipeline({
      exportDir,
      db: driver,
      store,
      tenantPrefix: 'test-user',
    });

    expect(report.totalFilesFound).toBeGreaterThan(0);
    expect(report.totalMediaFound).toBeGreaterThan(0);
    expect(report.importedCount).toBeGreaterThan(0);

    // Verify SQLite asset rows
    const assetCount = await driver.get<{ count: number }>('SELECT COUNT(*) as count FROM assets');
    expect(assetCount?.count).toBe(report.importedCount);

    // Verify local_assets references
    const localCount = await driver.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM local_assets',
    );
    expect(localCount?.count).toBe(report.importedCount);

    // Verify ObjectStore manifests exist by listing the store directory
    // LocalFsObjectStore stores objects at {root}/objects/{key}
    const manifestDir = path.join(storeDir, 'objects', 'test-user', 'manifest');
    const manifestFiles = await fs.readdir(manifestDir).catch(() => [] as string[]);
    expect(manifestFiles.length).toBeGreaterThan(0);
  });
});
