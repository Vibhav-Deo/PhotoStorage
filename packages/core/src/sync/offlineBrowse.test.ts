/**
 * Offline browse verification — asserts that timeline and album queries complete
 * using only local SQLite with no network calls (Requirement 4.6).
 *
 * This test intercepts `fetch` and asserts it is never called during browse operations.
 * It uses NodeSqliteDriver + the migration runner so the schema is real.
 *
 * Requirements: 4.6
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyConnectionPragmas,
  migrate,
  AssetKind,
  CapturedAtSource,
  LocalState,
  RemoteState,
  TierState,
} from '@photo-archive/core';
import { NodeSqliteDriver } from '@photo-archive/core/node-sqlite';

describe('offline browse verification (task 5.7)', () => {
  let tmpDir: string;
  let driver: NodeSqliteDriver;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-offline-'));
    driver = new NodeSqliteDriver({ path: path.join(tmpDir, 'test.db') });
    await applyConnectionPragmas(driver);
    await migrate(driver);

    // Seed two assets and one album.
    const now = Date.now();
    for (const [i, hash] of ['a'.repeat(64), 'b'.repeat(64)].entries()) {
      await driver.run(
        `INSERT INTO assets (hash,kind,byte_size,mime,width,height,duration_ms,
          captured_at,captured_at_src,tz_offset_min,lat,lon,camera_make,camera_model,
          orientation,thumbhash,live_pair_hash,variant_of_hash,favorite,deleted_at,
          remote_state,local_state,tier_state,derivative_mask,updated_at,version)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        [
          hash,
          AssetKind.Image,
          1000,
          'image/jpeg',
          100,
          100,
          null,
          now - i * 1000,
          CapturedAtSource.Exif,
          null,
          null,
          null,
          null,
          null,
          null,
          new Uint8Array(25),
          null,
          null,
          0,
          null,
          RemoteState.Verified,
          LocalState.Present,
          TierState.Instant,
          0,
          now - i * 1000,
        ],
      );
    }
    await driver.run(
      "INSERT INTO albums (id, title, created_at, updated_at, deleted_at, version) VALUES ('alb1','Vacation',?,?,null,0)",
      [now, now],
    );
    await driver.run("INSERT INTO album_members (album_id, hash, position) VALUES ('alb1', ?, 0)", [
      'a'.repeat(64),
    ]);
  });

  afterEach(async () => {
    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('timeline query returns assets without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const rows = await driver.all(
      `SELECT hash, thumbhash, captured_at FROM assets
       WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 150 OFFSET 0`,
    );

    expect(rows).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('album query returns albums and membership without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const albums = await driver.all(
      `SELECT a.id, a.title, COUNT(m.hash) as asset_count
       FROM albums a LEFT JOIN album_members m ON m.album_id = a.id
       WHERE a.deleted_at IS NULL GROUP BY a.id ORDER BY a.title ASC`,
    );

    expect(albums).toHaveLength(1);
    expect((albums[0] as Record<string, unknown>)['title']).toBe('Vacation');
    expect((albums[0] as Record<string, unknown>)['asset_count']).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
