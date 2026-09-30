import {
  AssetKind,
  CapturedAtSource,
  LocalState,
  manifestKey,
  migrate,
  origKey,
  previewKey,
  PURGE_REQUIRED_DERIVATIVES,
  RemoteState,
  thumbKey,
  TierState,
} from '@photo-archive/core';
import type { ObjectStore, SqlDriver } from '@photo-archive/core';
import { hashFile } from '@photo-archive/core/node-hash';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { reconstructExportAlbums } from './albums.ts';
import { generateImageDerivatives } from './derivatives.ts';
import type { ManifestEntry } from './manifest.ts';
import { formatManifestLine } from './manifest.ts';
import { pairExport } from './pairing.ts';
import type { ItemSkipDetail, ReconciliationReport } from './reconciliation.ts';
import { buildReconciliationReport } from './reconciliation.ts';
import { resolveExportTimestamps } from './timestamps.ts';
import { discoverParts, traverseExport } from './traversal.ts';
import { linkExport } from './variants.ts';

export interface TakeoutImporterOptions {
  /** Directory containing Takeout archive parts or single root. */
  readonly exportDir: string;
  /** SQLite database driver. */
  readonly db: SqlDriver;
  /** Storage destination. */
  readonly store: ObjectStore;
  /** User tenant prefix (e.g. Cognito sub). Defaults to 'local-user'. */
  readonly tenantPrefix?: string;
  /** Opt-in to import items from Trash. Defaults to false. */
  readonly importTrash?: boolean;
}

export class TakeoutPipelineError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TakeoutPipelineError';
    this.cause = cause;
  }
}

/**
 * Runs the end-to-end Takeout import pipeline over a set of archive parts.
 */
export async function runTakeoutPipeline(
  options: TakeoutImporterOptions,
): Promise<ReconciliationReport> {
  const { exportDir, db, store, importTrash = false } = options;
  const tenantPrefix = options.tenantPrefix ?? 'local-user';

  // Ensure schema is up to date
  await migrate(db);

  const skippedItems: ItemSkipDetail[] = [];
  const failedItems: ItemSkipDetail[] = [];

  // Stage 1: Discover parts and traverse export
  let partRoots: readonly string[];
  try {
    partRoots = await discoverParts(exportDir);
  } catch {
    // If discoverParts fails, treat the exportDir itself as a single part
    partRoots = [exportDir];
  }

  const exportData = await traverseExport(partRoots);

  const totalFilesFound = exportData.files.length;

  // Stage 2: Pair sidecars
  const paired = pairExport(exportData);

  // Record unpaired media as skipped
  for (const un of paired.unpaired) {
    skippedItems.push({
      path: un.media.absolutePath,
      reason: un.reason,
      detail: un.detail,
    });
  }

  // Stage 3: Resolve timestamps
  const timestamps = await resolveExportTimestamps(paired);

  // Stage 4: Link variants & Live Photos
  const linked = linkExport(exportData, { pairing: paired });

  // Stage 5: Reconstruct albums
  const albums = await reconstructExportAlbums(exportData, {
    includeTrash: importTrash,
    pairing: paired,
  });

  const totalMediaFound = exportData.media.length;
  let importedCount = 0;
  let deduplicatedCount = 0;

  const nowMs = Date.now();

  // Process all media files through pipeline
  for (const mediaFile of exportData.media) {
    const mediaPath = mediaFile.absolutePath;
    const disposition = albums.dispositionBySourcePath.get(mediaFile.sourcePath);

    if (!importTrash && disposition?.inTrash === true) {
      skippedItems.push({ path: mediaPath, reason: 'trash_opt_out' });
      continue;
    }

    try {
      // 1. Content hashing
      const hashResult = await hashFile(mediaPath);
      const contentHash = hashResult.hash;
      const byteSize = hashResult.byteSize;

      // Check if hash already exists (deduplication)
      const existing = await db.get<{ hash: string }>('SELECT hash FROM assets WHERE hash = ?', [
        contentHash,
      ]);

      if (existing) {
        deduplicatedCount++;
        const platform = process.platform === 'darwin' ? 0 : 1;
        await db.run(
          `INSERT OR IGNORE INTO local_assets (local_id, hash, platform, hash_state, first_seen, last_seen)
           VALUES (?, ?, ?, 1, ?, ?)`,
          [mediaPath, contentHash, platform, nowMs, nowMs],
        );
        continue;
      }

      // 2. Metadata resolution
      const timeResolution = timestamps.get(mediaFile.sourcePath);
      const capturedAt = timeResolution?.capturedAt ?? nowMs;
      const capturedAtSrc =
        timeResolution?.capturedAtSource === CapturedAtSource.TakeoutJson
          ? CapturedAtSource.TakeoutJson
          : timeResolution?.capturedAtSource === CapturedAtSource.Exif
            ? CapturedAtSource.Exif
            : CapturedAtSource.FileMtime;

      const assetKind = linked.kindBySourcePath.get(mediaFile.sourcePath) ?? AssetKind.Image;
      const variantOfSourcePath = linked.variantBaseBySourcePath.get(mediaFile.sourcePath);
      const livePairSourcePath = linked.livePairBySourcePath.get(mediaFile.sourcePath);

      // 3. Derivative Generation
      let thumbhash = new Uint8Array(25);
      let thumbBuf: Buffer | undefined;
      let previewBuf: Buffer | undefined;
      let width: number | undefined;
      let height: number | undefined;

      const ext = path.extname(mediaPath).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext);

      if (isImage) {
        try {
          const rawBuffer = await fs.readFile(mediaPath);
          const derivRes = await generateImageDerivatives(rawBuffer);
          thumbhash = Buffer.from(derivRes.thumbhash);
          thumbBuf = derivRes.thumb;
          previewBuf = derivRes.preview;
          width = derivRes.width;
          height = derivRes.height;
        } catch {
          // Degrade gracefully if image decode fails
        }
      }

      // 4. Store original in ObjectStore
      const originalObjectKey = origKey(tenantPrefix, contentHash);
      const originalStream = await fs.readFile(mediaPath);
      await store.put(originalObjectKey, originalStream);

      // 5. Store derivatives if generated
      let derivativeMask = 0;
      if (thumbBuf && previewBuf) {
        const tKey = thumbKey(tenantPrefix, contentHash);
        const pKey = previewKey(tenantPrefix, contentHash);
        await store.put(tKey, thumbBuf);
        await store.put(pKey, previewBuf);
        derivativeMask = PURGE_REQUIRED_DERIVATIVES;
      }

      // 6. Write asset row into SQLite
      const mime = isImage ? 'image/jpeg' : 'video/mp4';
      await db.run(
        `INSERT INTO assets (
          hash, kind, byte_size, mime, width, height, captured_at, captured_at_src,
          thumbhash, live_pair_hash, variant_of_hash, remote_state, local_state,
          tier_state, derivative_mask, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          contentHash,
          assetKind,
          byteSize,
          mime,
          width ?? null,
          height ?? null,
          capturedAt,
          capturedAtSrc,
          thumbhash,
          livePairSourcePath ?? null,
          variantOfSourcePath ?? null,
          RemoteState.Verified,
          LocalState.Present,
          TierState.Instant,
          derivativeMask,
          nowMs,
        ],
      );

      // 7. Write local_assets row
      const platform = process.platform === 'darwin' ? 0 : 1;
      await db.run(
        `INSERT INTO local_assets (local_id, hash, platform, hash_state, first_seen, last_seen)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [mediaPath, contentHash, platform, nowMs, nowMs],
      );

      // 8. Write Manifest line
      const isoCapturedAt = new Date(capturedAt).toISOString();
      const monthStr = isoCapturedAt.slice(0, 7);
      const mKey = manifestKey(tenantPrefix, monthStr);

      // Resolve album membership for this asset
      const disposition = albums.dispositionBySourcePath.get(mediaFile.sourcePath);
      const assetAlbums = disposition?.albumTitles ?? [];

      const manifestEntry: ManifestEntry = {
        hash: contentHash,
        file: path.basename(mediaPath),
        kind:
          assetKind === AssetKind.Image
            ? 'image'
            : assetKind === AssetKind.Video
              ? 'video'
              : 'motion_component',
        bytes: byteSize,
        capturedAt: isoCapturedAt,
        capturedAtSource:
          capturedAtSrc === CapturedAtSource.TakeoutJson
            ? 'takeout_json'
            : capturedAtSrc === CapturedAtSource.Exif
              ? 'exif'
              : 'file_mtime',
        ...(assetAlbums.length > 0 ? { albums: assetAlbums } : {}),
        ...(livePairSourcePath !== undefined ? { livePairHash: livePairSourcePath } : {}),
        ...(variantOfSourcePath !== undefined ? { variantOfHash: variantOfSourcePath } : {}),
      };

      const line = formatManifestLine(manifestEntry);
      const existingManifest = await store
        .get(mKey)
        .then(async (stream) => {
          const chunks: Uint8Array[] = [];
          const reader = stream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
          }
          return Buffer.concat(chunks).toString('utf8');
        })
        .catch(() => '');
      await store.put(mKey, Buffer.from(existingManifest + line, 'utf8'));

      importedCount++;
    } catch (err) {
      failedItems.push({
        path: mediaPath,
        reason: 'import_failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return buildReconciliationReport({
    totalFilesFound,
    totalMediaFound,
    importedCount,
    deduplicatedCount,
    skippedItems,
    failedItems,
  });
}
