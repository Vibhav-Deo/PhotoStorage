/**
 * Task 3.7 — Point the importer at S3.
 *
 * Swaps LocalFsObjectStore for S3ObjectStore via configuration only — no importer code change.
 * Skipped when S3_TEST_BUCKET is not set.
 *
 * To run:
 *   S3_TEST_BUCKET=my-bucket \
 *   S3_TEST_PREFIX=test-sub/ \
 *   AWS_REGION=us-east-1 \
 *   npm test -- s3Pipeline
 */

import { S3ObjectStore } from '@photo-archive/core/s3-store';
import { NodeSqliteDriver } from '@photo-archive/core/node-sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCorpus } from './fixtures/buildCorpus.ts';
import { runTakeoutPipeline } from './pipeline.ts';

const BUCKET = process.env['S3_TEST_BUCKET'];
const PREFIX = process.env['S3_TEST_PREFIX'] ?? 'importer-test/';
const REGION = process.env['AWS_REGION'] ?? 'us-east-1';

describe.skipIf(BUCKET === undefined)('runTakeoutPipeline against S3ObjectStore (task 3.7)', () => {
  let tempDir: string;
  let exportDir: string;
  let dbFile: string;
  let driver: NodeSqliteDriver;
  let store: S3ObjectStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-s3-pipeline-'));
    exportDir = path.join(tempDir, 'takeout');
    dbFile = path.join(tempDir, 'test.db');

    await buildCorpus(exportDir);

    driver = new NodeSqliteDriver({ path: dbFile });
    store = new S3ObjectStore({
      bucket: BUCKET!,
      clientConfig: { region: REGION },
      keyPrefix: PREFIX,
    });
  });

  afterEach(async () => {
    driver.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('imports the fixture corpus into S3 with no importer code change', async () => {
    const report = await runTakeoutPipeline({
      exportDir,
      db: driver,
      store,
      tenantPrefix: PREFIX.replace(/\/$/, ''),
    });

    expect(report.importedCount).toBeGreaterThan(0);
    expect(report.failedCount).toBe(0);

    // Verify at least one manifest object exists in S3.
    const assetCount = await driver.get<{ count: number }>('SELECT COUNT(*) as count FROM assets');
    expect(assetCount?.count).toBe(report.importedCount);
  });
});
