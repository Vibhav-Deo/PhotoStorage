/**
 * Two-simulated-device sync integration test.
 *
 * Simulates two devices sharing a change log via an in-memory stub "server".
 * Covers:
 * - Conflicting edits: device A and device B both edit the same asset; the one
 *   with the higher `updated_at` wins (last-writer-wins).
 * - Propagated deletion: device A tombstones an asset; device B pulls and the
 *   tombstone wins even if device B's local record has a higher `updated_at`.
 *
 * Requirements: 8.1, 8.3, 8.4
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConnectionPragmas, migrate } from '../db/migrate.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import type { AssetRecord } from '../records.ts';
import { AssetKind, CapturedAtSource, LocalState, RemoteState, TierState } from '../states.ts';
import { applyAssetRecords, collectPendingAssets } from './syncMerge.ts';

// ── In-memory stub change log ─────────────────────────────────────────────

interface ChangeLogEntry {
  record: AssetRecord;
  version: number;
}

class StubChangeLog {
  private _entries: ChangeLogEntry[] = [];
  private _counter = 0;

  push(records: AssetRecord[]): number {
    const version = ++this._counter;
    for (const record of records) {
      this._entries.push({ record: { ...record, version }, version });
    }
    return version;
  }

  pull(cursor: number, limit = 500): { records: AssetRecord[]; cursor: number } {
    const page = this._entries.filter((e) => e.version > cursor).slice(0, limit);
    const nextCursor = page.length > 0 ? (page[page.length - 1]?.version ?? cursor) : cursor;
    return { records: page.map((e) => e.record), cursor: nextCursor };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeAsset(hash: string, overrides: Partial<AssetRecord> = {}): AssetRecord {
  return {
    hash,
    kind: AssetKind.Image,
    byteSize: 1000,
    mime: 'image/jpeg',
    width: 100,
    height: 100,
    durationMs: null,
    capturedAt: 1_700_000_000_000,
    capturedAtSource: CapturedAtSource.Exif,
    tzOffsetMin: null,
    lat: null,
    lon: null,
    cameraMake: null,
    cameraModel: null,
    orientation: null,
    thumbhash: new Uint8Array(25),
    livePairHash: null,
    variantOfHash: null,
    favorite: false,
    deletedAt: null,
    remoteState: RemoteState.Verified,
    localState: LocalState.Present,
    tierState: TierState.Instant,
    derivativeMask: 0,
    updatedAt: 1_700_000_000_000,
    version: 0,
    ...overrides,
  };
}

async function openDb(dir: string, name: string): Promise<NodeSqliteDriver> {
  const driver = new NodeSqliteDriver({ path: path.join(dir, `${name}.db`) });
  await applyConnectionPragmas(driver);
  await migrate(driver);
  return driver;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('two-device sync integration', () => {
  let tmpDir: string;
  let deviceA: NodeSqliteDriver;
  let deviceB: NodeSqliteDriver;
  let log: StubChangeLog;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-sync-test-'));
    deviceA = await openDb(tmpDir, 'device-a');
    deviceB = await openDb(tmpDir, 'device-b');
    log = new StubChangeLog();
  });

  afterEach(async () => {
    deviceA.close();
    deviceB.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('last-writer-wins on conflicting edits: higher updated_at survives', async () => {
    const hash = 'a'.repeat(64);

    // Device A inserts an asset and pushes it.
    const assetA = makeAsset(hash, { favorite: false, updatedAt: 1_000 });
    await deviceA.run(
      `INSERT INTO assets (hash,kind,byte_size,mime,width,height,duration_ms,
        captured_at,captured_at_src,tz_offset_min,lat,lon,camera_make,camera_model,
        orientation,thumbhash,live_pair_hash,variant_of_hash,favorite,deleted_at,
        remote_state,local_state,tier_state,derivative_mask,updated_at,version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        hash,
        assetA.kind,
        assetA.byteSize,
        assetA.mime,
        assetA.width,
        assetA.height,
        null,
        assetA.capturedAt,
        assetA.capturedAtSource,
        null,
        null,
        null,
        null,
        null,
        null,
        assetA.thumbhash,
        null,
        null,
        0,
        null,
        assetA.remoteState,
        assetA.localState,
        assetA.tierState,
        0,
        assetA.updatedAt,
      ],
    );
    const pendingA = await collectPendingAssets(deviceA);
    const versionAfterA = log.push(pendingA);
    await deviceA.run('UPDATE assets SET version = ? WHERE hash = ?', [versionAfterA, hash]);

    // Device B pulls and gets the asset.
    const { records: pullB1, cursor: cursorB1 } = log.pull(0);
    await applyAssetRecords(deviceB, pullB1);
    const rowB1 = await deviceB.get<{ favorite: number; updated_at: number }>(
      'SELECT favorite, updated_at FROM assets WHERE hash = ?',
      [hash],
    );
    expect(rowB1?.favorite).toBe(0);

    // Device B edits (marks favorite) with a LATER updated_at and pushes.
    await deviceB.run(
      'UPDATE assets SET favorite = 1, updated_at = 2000, version = 0 WHERE hash = ?',
      [hash],
    );
    const pendingB = await collectPendingAssets(deviceB);
    const versionAfterB = log.push(pendingB);
    await deviceB.run('UPDATE assets SET version = ? WHERE hash = ?', [versionAfterB, hash]);

    // Device A also edits (different field: cameraMake) with an EARLIER updated_at and pushes.
    await deviceA.run(
      "UPDATE assets SET camera_make = 'Apple', updated_at = 1500, version = 0 WHERE hash = ?",
      [hash],
    );
    const pendingA2 = await collectPendingAssets(deviceA);
    log.push(pendingA2);

    // Device A pulls device B's edit (updated_at=2000 > local 1500 → B wins).
    const { records: pullA2 } = log.pull(versionAfterA);
    await applyAssetRecords(deviceA, pullA2);

    const rowA2 = await deviceA.get<{ favorite: number; updated_at: number }>(
      'SELECT favorite, updated_at FROM assets WHERE hash = ?',
      [hash],
    );
    // Device B's edit (favorite=1, updated_at=2000) wins over A's (updated_at=1500).
    expect(rowA2?.favorite).toBe(1);
    expect(rowA2?.updated_at).toBe(2000);

    // Device B pulls device A's edit — A's updated_at=1500 < B's 2000, so B keeps its state.
    const { records: pullB2 } = log.pull(cursorB1);
    await applyAssetRecords(deviceB, pullB2);
    const rowB2 = await deviceB.get<{ favorite: number }>(
      'SELECT favorite FROM assets WHERE hash = ?',
      [hash],
    );
    expect(rowB2?.favorite).toBe(1); // B's own edit survives
  });

  it('tombstone propagation: deletion on device A reaches device B and wins', async () => {
    const hash = 'b'.repeat(64);

    // Both devices start with the same asset.
    const asset = makeAsset(hash, { updatedAt: 1_000 });
    await deviceA.run(
      `INSERT INTO assets (hash,kind,byte_size,mime,width,height,duration_ms,
        captured_at,captured_at_src,tz_offset_min,lat,lon,camera_make,camera_model,
        orientation,thumbhash,live_pair_hash,variant_of_hash,favorite,deleted_at,
        remote_state,local_state,tier_state,derivative_mask,updated_at,version)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [
        hash,
        asset.kind,
        asset.byteSize,
        asset.mime,
        asset.width,
        asset.height,
        null,
        asset.capturedAt,
        asset.capturedAtSource,
        null,
        null,
        null,
        null,
        null,
        null,
        asset.thumbhash,
        null,
        null,
        0,
        null,
        asset.remoteState,
        asset.localState,
        asset.tierState,
        0,
        asset.updatedAt,
      ],
    );
    const pending0 = await collectPendingAssets(deviceA);
    const v0 = log.push(pending0);
    await deviceA.run('UPDATE assets SET version = ? WHERE hash = ?', [v0, hash]);

    const { records: pullB0 } = log.pull(0);
    await applyAssetRecords(deviceB, pullB0);

    // Device B edits the asset with a HIGHER updated_at than the tombstone will have.
    await deviceB.run(
      'UPDATE assets SET favorite = 1, updated_at = 9999, version = 0 WHERE hash = ?',
      [hash],
    );

    // Device A tombstones the asset with a LOWER updated_at — tombstone must still win.
    const tombstoneTime = 5000;
    await deviceA.run(
      'UPDATE assets SET deleted_at = ?, updated_at = ?, version = 0 WHERE hash = ?',
      [tombstoneTime, tombstoneTime, hash],
    );
    const pendingTombstone = await collectPendingAssets(deviceA);
    const vTombstone = log.push(pendingTombstone);
    await deviceA.run('UPDATE assets SET version = ? WHERE hash = ?', [vTombstone, hash]);

    // Device B pulls the tombstone. Even though B's updated_at=9999 > tombstone's 5000,
    // the tombstone must win (Requirement 8.3).
    const { records: pullB1 } = log.pull(v0);
    await applyAssetRecords(deviceB, pullB1);

    const rowB = await deviceB.get<{ deleted_at: number | null; favorite: number }>(
      'SELECT deleted_at, favorite FROM assets WHERE hash = ?',
      [hash],
    );
    expect(rowB?.deleted_at).toBe(tombstoneTime);
  });
});
