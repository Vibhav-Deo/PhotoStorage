/**
 * Bounded LRU thumbnail cache.
 *
 * Tracks cached thumbnail keys in the `thumb_cache` SQLite table with byte accounting.
 * When the total exceeds `maxBytes`, evicts the least-recently-used entries until under
 * the cap. Thumbhashes are never evicted — they live in `assets.thumbhash` and are
 * managed separately (Requirement 4.5).
 *
 * Requirements: 4.4, 12.2
 */

import type { SqlDriver } from '@photo-archive/core';

/** Default cap: 200 MB. */
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export interface ThumbCacheOptions {
  readonly maxBytes?: number;
}

export class ThumbCache {
  private readonly _driver: SqlDriver;
  private readonly _maxBytes: number;

  constructor(driver: SqlDriver, options: ThumbCacheOptions = {}) {
    this._driver = driver;
    this._maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Records a cache hit — updates `last_accessed` for the key.
   * Call when a thumbnail is served from the on-disk cache.
   */
  async touch(key: string): Promise<void> {
    await this._driver.run('UPDATE thumb_cache SET last_accessed = ? WHERE key = ?', [
      Date.now(),
      key,
    ]);
  }

  /**
   * Records a newly cached thumbnail. Triggers eviction if the cap is exceeded.
   */
  async add(key: string, bytes: number): Promise<void> {
    const now = Date.now();
    await this._driver.run(
      `INSERT INTO thumb_cache(key, bytes, last_accessed) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes, last_accessed=excluded.last_accessed`,
      [key, bytes, now],
    );
    await this._evictIfNeeded();
  }

  /**
   * Removes a key from the cache accounting table (e.g. when the object is deleted).
   */
  async remove(key: string): Promise<void> {
    await this._driver.run('DELETE FROM thumb_cache WHERE key = ?', [key]);
  }

  /**
   * Returns the keys to evict to bring total bytes under `maxBytes`, in LRU order.
   * Exposed for testing.
   */
  async evictionCandidates(): Promise<string[]> {
    const total = await this._totalBytes();
    if (total <= this._maxBytes) return [];

    const rows = await this._driver.all<{ key: string; bytes: number }>(
      'SELECT key, bytes FROM thumb_cache ORDER BY last_accessed ASC',
    );

    const toEvict: string[] = [];
    let running = total;
    for (const row of rows) {
      if (running <= this._maxBytes) break;
      toEvict.push(row.key);
      running -= row.bytes;
    }
    return toEvict;
  }

  private async _totalBytes(): Promise<number> {
    const row = await this._driver.get<{ total: number | null }>(
      'SELECT SUM(bytes) as total FROM thumb_cache',
    );
    return row?.total ?? 0;
  }

  private async _evictIfNeeded(): Promise<void> {
    const candidates = await this.evictionCandidates();
    if (candidates.length === 0) return;
    // Remove from accounting. The actual file deletion is the caller's responsibility
    // (expo-image manages its own disk cache; we only track accounting here).
    for (const key of candidates) {
      await this.remove(key);
    }
  }
}
