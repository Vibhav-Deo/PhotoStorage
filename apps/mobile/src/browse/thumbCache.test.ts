/**
 * ThumbCache unit tests — LRU eviction, cap enforcement, thumbhash safety.
 *
 * Uses NodeSqliteDriver + real schema so the `thumb_cache` table matches production.
 *
 * Requirements: 4.4, 12.2
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyConnectionPragmas, migrate } from '@photo-archive/core';
import { NodeSqliteDriver } from '@photo-archive/core/node-sqlite';
import { ThumbCache } from './thumbCache.ts';

describe('ThumbCache (task 5.4)', () => {
  let tmpDir: string;
  let driver: NodeSqliteDriver;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-thumbcache-'));
    driver = new NodeSqliteDriver({ path: path.join(tmpDir, 'test.db') });
    await applyConnectionPragmas(driver);
    await migrate(driver);
  });

  afterEach(async () => {
    driver.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns no candidates when total is under the cap', async () => {
    const cache = new ThumbCache(driver, { maxBytes: 1000 });
    await cache.add('key/small', 100);
    const candidates = await cache.evictionCandidates();
    expect(candidates).toHaveLength(0);
  });

  it('evictionCandidates identifies LRU entries needed to bring total under cap', async () => {
    // Insert three entries manually with known bytes.
    const now = Date.now();
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/old',
      500,
      now - 2000,
    ]);
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/mid',
      500,
      now - 1000,
    ]);
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/new',
      500,
      now,
    ]);

    // Inspect with a tight cap that requires evicting at least one entry.
    const tightCache = new ThumbCache(driver, { maxBytes: 1000 });
    const candidates = await tightCache.evictionCandidates();

    // Total = 1500 bytes; cap = 1000. Need to evict 500 bytes (one entry).
    expect(candidates).toHaveLength(1);
    // The LRU entry ('key/old' — lowest last_accessed) is evicted first.
    expect(candidates[0]).toBe('key/old');
  });

  it('touch() updates last_accessed so the touched key is no longer the LRU', async () => {
    const now = Date.now();
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/old',
      500,
      now - 2000,
    ]);
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/new',
      500,
      now - 1000,
    ]);

    const cache = new ThumbCache(driver, { maxBytes: 600 });

    // Touch the old key — it should no longer be the LRU.
    await cache.touch('key/old');

    const candidates = await cache.evictionCandidates();
    // 'key/new' is now the least recently accessed.
    expect(candidates[0]).toBe('key/new');
    expect(candidates).not.toContain('key/old');
  });

  it('remove() deletes the accounting row so the key is excluded from totals', async () => {
    const cache = new ThumbCache(driver, { maxBytes: 1000 });
    await cache.add('key/target', 800);

    // Confirm it's recorded.
    const before = await driver.all<{ key: string }>('SELECT key FROM thumb_cache WHERE key = ?', [
      'key/target',
    ]);
    expect(before).toHaveLength(1);

    await cache.remove('key/target');

    const after = await driver.all<{ key: string }>('SELECT key FROM thumb_cache WHERE key = ?', [
      'key/target',
    ]);
    expect(after).toHaveLength(0);
  });

  it('add() auto-evicts LRU entries when the cap is exceeded', async () => {
    const cache = new ThumbCache(driver, { maxBytes: 900 });

    // Add two entries totalling 1000 bytes — over the 900-byte cap.
    // First add stays; second triggers eviction of the first.
    const now = Date.now();
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/lru',
      500,
      now - 1000,
    ]);
    // add() inserts 'key/new' and then evicts to get under 900 bytes.
    await cache.add('key/new', 500);

    const rows = await driver.all<{ key: string }>(
      'SELECT key FROM thumb_cache ORDER BY last_accessed ASC',
    );
    const keys = rows.map((r) => r.key);

    // 'key/lru' (oldest) should have been evicted; 'key/new' should remain.
    expect(keys).not.toContain('key/lru');
    expect(keys).toContain('key/new');
  });

  it('browse timeline query still completes after cache eviction', async () => {
    const cache = new ThumbCache(driver, { maxBytes: 900 });
    // Pre-insert an LRU entry then trigger eviction via add().
    const now = Date.now();
    await driver.run('INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)', [
      'key/evicted',
      500,
      now - 1000,
    ]);
    await cache.add('key/kept', 500);

    // Browse query must not be affected by the thumb_cache state.
    const rows = await driver.all(
      'SELECT hash, thumbhash, captured_at FROM assets WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 150 OFFSET 0',
    );
    // No assets were inserted — just confirm the query runs without error.
    expect(Array.isArray(rows)).toBe(true);
  });
});
