/**
 * Synthetic Library Generator (Task 10.1).
 *
 * Generates synthetic photo/video libraries at reference scale (5,000+ items)
 * and 10× scale for performance benchmarking and stress testing.
 *
 * Requirements: 12 (all)
 */

import type { SqlDriver } from '../db/driver.ts';
import { AssetKind, CapturedAtSource, RemoteState, LocalState } from '../states.ts';

export interface SyntheticLibraryOptions {
  readonly count: number;
  readonly albumCount?: number;
  readonly startDateMs?: number;
  readonly dateSpanDays?: number;
  readonly batchSize?: number;
}

export interface SyntheticLibraryStats {
  readonly generatedAssets: number;
  readonly generatedAlbums: number;
  readonly totalBytes: number;
  readonly durationMs: number;
}

/**
 * Seeds SQLite with a realistic synthetic photo and video corpus.
 */
export async function generateSyntheticLibrary(
  driver: SqlDriver,
  options: SyntheticLibraryOptions,
): Promise<SyntheticLibraryStats> {
  const startTimer = Date.now();
  const count = options.count;
  const albumCount = options.albumCount ?? Math.max(1, Math.floor(count / 100));
  const baseDate = options.startDateMs ?? Date.now() - 365 * 24 * 60 * 60 * 1000;
  const spanMs = (options.dateSpanDays ?? 365) * 24 * 60 * 60 * 1000;
  const batchSize = options.batchSize ?? 500;

  let totalBytes = 0;

  // 1. Create synthetic albums
  await driver.exec('BEGIN IMMEDIATE');
  try {
    for (let a = 0; a < albumCount; a++) {
      const albumId = `synth_album_${String(a).padStart(3, '0')}`;
      const title = `Synthetic Album ${String(a + 1)}`;
      await driver.run(
        'INSERT INTO albums (id, title, created_at, updated_at, version) VALUES (?, ?, ?, ?, 0)',
        [albumId, title, baseDate + a * 86400000, baseDate + a * 86400000],
      );
    }
    await driver.exec('COMMIT');
  } catch (err) {
    await driver.exec('ROLLBACK').catch(() => {});
    throw err;
  }

  // 2. Insert assets in batches
  for (let b = 0; b < count; b += batchSize) {
    const end = Math.min(b + batchSize, count);
    await driver.exec('BEGIN IMMEDIATE');
    try {
      for (let i = b; i < end; i++) {
        // Unique deterministic 64-char sha256 mock
        const hash = `synth_${String(i).padStart(8, '0')}`.padEnd(64, '0');
        const isVideo = i % 15 === 0;
        const kind = isVideo ? AssetKind.Video : AssetKind.Image;
        const byteSize = isVideo ? 15_000_000 + (i % 10) * 1_000_000 : 2_500_000 + (i % 20) * 100_000;
        totalBytes += byteSize;

        const capturedAt = Math.floor(baseDate + (i / count) * spanMs);
        const cameraMake = i % 2 === 0 ? 'Apple' : 'Sony';
        const cameraModel = i % 2 === 0 ? 'iPhone 15 Pro' : 'A7 IV';

        // Fake 25-byte thumbhash
        const fakeThumbhash = new Uint8Array(25);
        fakeThumbhash[0] = i & 0xff;

        await driver.run(
          `INSERT INTO assets (
            hash, kind, byte_size, mime, width, height, duration_ms,
            captured_at, captured_at_src, camera_make, camera_model,
            thumbhash, remote_state, local_state, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            hash,
            kind,
            byteSize,
            isVideo ? 'video/mp4' : 'image/jpeg',
            4032,
            3024,
            isVideo ? 15000 : null,
            capturedAt,
            CapturedAtSource.Exif,
            cameraMake,
            cameraModel,
            fakeThumbhash,
            RemoteState.Verified,
            LocalState.Present,
            capturedAt,
          ],
        );

        // Assign some assets to albums
        if (i % 10 === 0) {
          const albumIndex = (i / 10) % albumCount;
          const albumId = `synth_album_${String(albumIndex).padStart(3, '0')}`;
          await driver.run(
            'INSERT OR IGNORE INTO album_members (album_id, hash, position) VALUES (?, ?, ?)',
            [albumId, hash, i],
          );
        }
      }
      await driver.exec('COMMIT');
    } catch (err) {
      await driver.exec('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  const durationMs = Date.now() - startTimer;
  return {
    generatedAssets: count,
    generatedAlbums: albumCount,
    totalBytes,
    durationMs,
  };
}
