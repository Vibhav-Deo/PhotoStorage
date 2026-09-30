/**
 * New-device bootstrap — reconstructs the full timeline and vector index from the
 * change log and the vector backup in object storage, without touching the photo library.
 *
 * Two operations:
 * 1. Pull the full change log (cursor = 0) via the sync Lambda.
 * 2. Restore the coarse vector buffer from `{prefix}/vec/{modelId}/*.bin` shards in S3.
 *
 * After bootstrap, browse and search are fully functional. Device ingest (Phase 7) then
 * runs in the background to re-establish local originals.
 *
 * Requirements: 8.2, 5.8
 */

import { vecKey, MAX_VECTOR_SHARD } from '@photo-archive/core';
import type { ObjectStore, SqlDriver } from '@photo-archive/core';
import * as FileSystem from 'expo-file-system';
import type { CredentialProvider } from '../credentials/credentialProvider.ts';
import type { SyncClientConfig } from '../sync/syncClient.ts';
import { pullSync } from '../sync/syncClient.ts';

export interface BootstrapOptions {
  readonly driver: SqlDriver;
  readonly store: ObjectStore;
  readonly credentialProvider: CredentialProvider;
  readonly syncConfig: SyncClientConfig;
  /** Model ID to restore vectors for, e.g. 'clip-vit-b32/pca256-v1'. */
  readonly modelId: string;
  /** Local file path for the coarse vector buffer, e.g. `${FileSystem.documentDirectory}coarse.bin`. */
  readonly coarseBinPath: string;
  /** Called with progress [0..1] as each phase completes. */
  readonly onProgress?: (progress: number) => void;
}

export interface BootstrapResult {
  readonly assetCount: number;
  readonly shardsRestored: number;
}

export class BootstrapError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'BootstrapError';
    this.cause = cause;
  }
}

/**
 * Reads a `ReadableStream` fully into a `Uint8Array`.
 */
async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Restores the coarse vector buffer by downloading all shards for `modelId` from S3
 * and concatenating them into `coarseBinPath`.
 *
 * Shards are numbered 00000.bin, 00001.bin, … and are stored contiguously. We probe
 * sequentially until a shard is absent (HeadObject returns null), which marks the end.
 */
async function restoreVectorShards(
  store: ObjectStore,
  prefix: string,
  modelId: string,
  coarseBinPath: string,
): Promise<number> {
  // Delete any existing file so we start fresh.
  await FileSystem.deleteAsync(coarseBinPath, { idempotent: true });

  let shard = 0;
  let shardsRestored = 0;

  for (; shard <= MAX_VECTOR_SHARD; shard++) {
    const key = vecKey(prefix, modelId, shard);
    const head = await store.head(key);
    if (!head) break; // No more shards.

    const stream = await store.get(key);
    const bytes = await readStream(stream);

    // Append to the local file. expo-file-system's appendAsync works with base64.
    const base64 = uint8ArrayToBase64(bytes);
    if (shard === 0) {
      await FileSystem.writeAsStringAsync(coarseBinPath, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
    } else {
      // expo-file-system has no native append for binary; read-modify-write for now.
      // For large libraries this should be replaced with a native module or chunked writes.
      const existing = await FileSystem.readAsStringAsync(coarseBinPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const existingBytes = base64ToUint8Array(existing);
      const combined = new Uint8Array(existingBytes.byteLength + bytes.byteLength);
      combined.set(existingBytes, 0);
      combined.set(bytes, existingBytes.byteLength);
      await FileSystem.writeAsStringAsync(coarseBinPath, uint8ArrayToBase64(combined), {
        encoding: FileSystem.EncodingType.Base64,
      });
    }

    shardsRestored++;
  }

  return shardsRestored;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Bootstraps a new device: pulls the full change log then restores the vector backup.
 * Safe to call on an existing device — `pullSync` is cursor-based and idempotent.
 */
export async function bootstrapDevice(options: BootstrapOptions): Promise<BootstrapResult> {
  const { driver, store, credentialProvider, syncConfig, modelId, coarseBinPath, onProgress } =
    options;

  // Phase 1: pull the full change log (40% of progress).
  let assetCount: number;
  try {
    await pullSync(driver, syncConfig, credentialProvider);
    const row = await driver.get<{ count: number }>('SELECT COUNT(*) as count FROM assets');
    assetCount = row?.count ?? 0;
  } catch (err) {
    throw new BootstrapError('Change log pull failed during bootstrap', err);
  }
  onProgress?.(0.4);

  // Phase 2: restore vector shards (remaining 60%).
  const prefix = await credentialProvider.prefix();
  let shardsRestored = 0;
  try {
    shardsRestored = await restoreVectorShards(store, prefix, modelId, coarseBinPath);
  } catch (err) {
    // Vector restore failure is non-fatal: browse works without vectors, and search
    // degrades to metadata-only until re-embedding runs (Requirement 5.9).
    console.warn('Vector shard restore failed; search will re-embed on next launch:', err);
  }
  onProgress?.(1.0);

  return { assetCount, shardsRestored };
}
