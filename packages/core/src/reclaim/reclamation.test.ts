import { describe, expect, it } from 'vitest';
import {
  verifyRemoteAsset,
  updatePurgeEligibility,
  executePurgeBatch,
} from './reclamation.ts';
import { LocalFsObjectStore } from '../store/localFsObjectStore.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import {
  RemoteState,
  LocalState,
  DerivativeKind,
  addDerivatives,
} from '../states.ts';
import { origKey } from '../keys.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

describe('Verified Space Reclamation (Phase 8)', () => {
  it('detects corrupted remote objects and verifies authentic ones', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reclaim-test-'));
    const store = new LocalFsObjectStore({ root: tmpDir });
    const tenant = 'usr_rec';

    const testPayload = new TextEncoder().encode('authentic original photo bytes 12345');
    const digest = await crypto.subtle.digest('SHA-256', testPayload);
    const validHash = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    const key = origKey(tenant, validHash);
    await store.put(key, testPayload);

    // 1. Verify authentic
    const resAuth = await verifyRemoteAsset(store, tenant, validHash, testPayload.byteLength);
    expect(resAuth.success).toBe(true);

    // 2. Corrupted object test: verify against wrong hash
    const fakeHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const resCorrupt = await verifyRemoteAsset(store, tenant, fakeHash, testPayload.byteLength);
    expect(resCorrupt.success).toBe(false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('enforces eligibility state machine (gated on verified + thumbnails)', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    // Asset with remote_state = Uploading (1), should NOT become eligible
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, derivative_mask, updated_at)
       VALUES ('h_uploading', 0, 1000, 'image/jpeg', 100, 0, X'00', ?, ?, ?, ?)`,
      [RemoteState.Uploading, LocalState.Present, 0, 100],
    );

    const check1 = await updatePurgeEligibility(driver, 'h_uploading');
    expect(check1.eligible).toBe(false);

    // Asset with remote_state = Verified (2) but missing Thumb/Preview derivatives
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, derivative_mask, updated_at)
       VALUES ('h_no_deriv', 0, 1000, 'image/jpeg', 100, 0, X'00', ?, ?, ?, ?)`,
      [RemoteState.Verified, LocalState.Present, 0, 100],
    );

    const check2 = await updatePurgeEligibility(driver, 'h_no_deriv');
    expect(check2.eligible).toBe(false);

    // Asset with remote_state = Verified (2) AND Thumb + Preview present
    const validMask = addDerivatives(0, DerivativeKind.Thumb | DerivativeKind.Preview);
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, derivative_mask, updated_at)
       VALUES ('h_eligible', 0, 1000, 'image/jpeg', 100, 0, X'00', ?, ?, ?, ?)`,
      [RemoteState.Verified, LocalState.Present, validMask, 100],
    );

    const check3 = await updatePurgeEligibility(driver, 'h_eligible');
    expect(check3.eligible).toBe(true);

    const row = await driver.all<{ local_state: number }>(
      'SELECT local_state FROM assets WHERE hash = ?',
      ['h_eligible'],
    );
    expect(row[0]?.local_state).toBe(LocalState.PurgeEligible);

    driver.close();
  });

  it('writes immutable purge_audit row before deletion and transitions state', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const testHash = 'a'.repeat(64);
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, updated_at)
       VALUES (?, 0, 5000, 'image/jpeg', 100, 0, X'00', ?, ?, ?)`,
      [testHash, RemoteState.Verified, LocalState.PurgeEligible, 100],
    );

    let platformDeletedCalled = false;
    const mockDeleter = (hashes: readonly string[]) => {
      platformDeletedCalled = true;
      return Promise.resolve({ deleted: [...hashes] });
    };

    const result = await executePurgeBatch(driver, 'usr_rec', [testHash], mockDeleter);
    expect(result.purgedCount).toBe(1);
    expect(result.freedBytes).toBe(5000);
    expect(platformDeletedCalled).toBe(true);

    // Check audit trail
    const auditRows = await driver.all<{ hash: string; byte_size: number; outcome: number }>(
      'SELECT hash, byte_size, outcome FROM purge_audit WHERE hash = ?',
      [testHash],
    );
    expect(auditRows.length).toBe(1);
    expect(auditRows[0]?.outcome).toBe(0);
    expect(auditRows[0]?.byte_size).toBe(5000);

    // Check final local state
    const assetRow = await driver.all<{ local_state: number }>(
      'SELECT local_state FROM assets WHERE hash = ?',
      [testHash],
    );
    expect(assetRow[0]?.local_state).toBe(LocalState.Purged);

    driver.close();
  });
});
