/**
 * Real device-to-S3 asset uploader and SQLite ledger recorder.
 *
 * Implements:
 * 1. Resolution of device asset localUri via MediaLibrary.
 * 2. Binary reading of original bytes.
 * 3. Real cryptographic SHA-256 content hash calculation.
 * 4. Key derivation: `{prefix}/orig/{hash}` via @photo-archive/core origKey.
 * 5. Pre-signed SigV4 PUT URL generation using STS credentials.
 * 6. Direct HTTP binary PUT into Amazon S3 bucket.
 * 7. Verification of HTTP 200 response from S3.
 * 8. Insertion into local SQLite database (assets and local_assets tables).
 */

import * as MediaLibrary from 'expo-media-library/legacy';
import * as FileSystem from 'expo-file-system';
import type { SqlDriver } from '@photo-archive/core';
import { origKey } from '@photo-archive/core';
import type { DevicePhoto } from '../browse/DevicePhotoGrid.tsx';
import type { CredentialProvider } from '../credentials/credentialProvider.ts';
import { presignS3PutUrl } from '../browse/mediaUrlProvider.ts';
import { sha256Hex } from '../crypto/pureCrypto.ts';
import { PHOTO_ARCHIVE_AWS } from '../config/aws.ts';

export interface UploadResult {
  readonly id: string;
  readonly hash: string;
  readonly key: string;
  readonly byteSize: number;
  readonly s3Url: string;
}

export interface UploadProgressCallback {
  (step: {
    status: 'reading' | 'hashing' | 'signing' | 'uploading' | 'recording' | 'complete';
    progressPercent: number;
    bytesUploaded?: number;
    totalBytes?: number;
    hash?: string;
  }): void;
}

/**
 * Converts a base64 string to a Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Reads binary bytes from a device asset URI.
 */
async function readAssetBytes(asset: DevicePhoto): Promise<{ bytes: Uint8Array; localUri: string }> {
  let localUri = asset.uri;

  try {
    const assetInfo = await MediaLibrary.getAssetInfoAsync(asset.id);
    if (assetInfo?.localUri) {
      localUri = assetInfo.localUri;
    }
  } catch (err) {
    console.warn('Could not get asset info, falling back to uri:', err);
  }

  // Attempt 1: fetch(localUri)
  try {
    const response = await fetch(localUri);
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 0) {
        return { bytes: new Uint8Array(buffer), localUri };
      }
    }
  } catch (fetchErr) {
    console.warn('Direct fetch of localUri failed, falling back to FileSystem:', fetchErr);
  }

  // Attempt 2: FileSystem.readAsStringAsync base64
  try {
    const base64Data = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return { bytes: base64ToUint8Array(base64Data), localUri };
  } catch (fsErr) {
    throw new Error(
      `Unable to read bytes from device photo ${asset.filename ?? asset.id}: ${
        fsErr instanceof Error ? fsErr.message : String(fsErr)
      }`,
    );
  }
}

/**
 * Uploads a single device asset directly to AWS S3 and records it in SQLite.
 */
export async function uploadAssetToS3(
  asset: DevicePhoto,
  credentialProvider: CredentialProvider,
  driver: SqlDriver,
  onProgress?: UploadProgressCallback,
): Promise<UploadResult> {
  onProgress?.({ status: 'reading', progressPercent: 10 });

  // 1. Read binary bytes
  const { bytes } = await readAssetBytes(asset);
  const byteSize = bytes.byteLength;

  onProgress?.({ status: 'hashing', progressPercent: 30, totalBytes: byteSize });

  // 2. Compute authentic SHA-256 using pure JavaScript FIPS 180-4 (Hermes safe)
  const hash = sha256Hex(bytes);

  onProgress?.({ status: 'signing', progressPercent: 45, hash, totalBytes: byteSize });

  // 3. Obtain STS credentials and prefix
  const credentials = await credentialProvider.credentials();
  const prefix = await credentialProvider.prefix();

  // 4. Calculate key: {prefix}/orig/{hash}
  const s3Key = origKey(prefix, hash);
  const mime = asset.mediaType === 'video' ? 'video/mp4' : 'image/jpeg';

  // 5. Generate SigV4 pre-signed PUT URL
  const putUrl = await presignS3PutUrl(
    s3Key,
    credentials,
    {
      bucket: PHOTO_ARCHIVE_AWS.bucket,
      region: PHOTO_ARCHIVE_AWS.region,
      expiresIn: 3600,
    },
  );

  onProgress?.({
    status: 'uploading',
    progressPercent: 60,
    hash,
    bytesUploaded: 0,
    totalBytes: byteSize,
  });

  // 6. Direct HTTP binary PUT into Amazon S3 bucket
  const response = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': mime,
    },
    body: bytes,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `S3 PutObject failed with HTTP ${response.status}: ${errorBody || response.statusText}`,
    );
  }

  onProgress?.({
    status: 'recording',
    progressPercent: 90,
    hash,
    bytesUploaded: byteSize,
    totalBytes: byteSize,
  });

  // 7. Record into SQLite database according to packages/core schema
  const capturedAtMs = asset.creationTime ?? Date.now();
  const nowMs = Date.now();

  // Insert into assets table
  await driver.run(
    `INSERT INTO assets (
      hash, kind, byte_size, mime, width, height, duration_ms,
      captured_at, captured_at_src, tz_offset_min, lat, lon,
      camera_make, camera_model, orientation, thumbhash,
      live_pair_hash, variant_of_hash, favorite, deleted_at,
      remote_state, local_state, tier_state, derivative_mask,
      updated_at, version
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(hash) DO UPDATE SET
      remote_state = 2,
      local_state = 2,
      updated_at = excluded.updated_at`,
    [
      hash,
      asset.mediaType === 'video' ? 1 : 0, // kind: 0=image, 1=video
      byteSize,
      mime,
      asset.width ?? null,
      asset.height ?? null,
      null, // duration_ms
      capturedAtMs,
      0, // captured_at_src: 0=exif
      null, // tz_offset_min
      null, // lat
      null, // lon
      null, // camera_make
      null, // camera_model
      null, // orientation
      new Uint8Array([0]), // thumbhash placeholder
      null, // live_pair_hash
      null, // variant_of_hash
      0, // favorite
      null, // deleted_at
      2, // remote_state: 2=verified
      2, // local_state: 2=purge_eligible
      0, // tier_state: 0=instant
      1, // derivative_mask
      nowMs,
      0, // version
    ],
  );

  // Insert or update local_assets table
  await driver.run(
    `INSERT INTO local_assets (
      local_id, hash, platform, hash_state, first_seen, last_seen
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_id) DO UPDATE SET
      hash = excluded.hash,
      hash_state = 1,
      last_seen = excluded.last_seen`,
    [
      asset.id,
      hash,
      0, // platform: 0=ios, 1=android
      1, // hash_state: 1=done
      nowMs,
      nowMs,
    ],
  );

  onProgress?.({
    status: 'complete',
    progressPercent: 100,
    hash,
    bytesUploaded: byteSize,
    totalBytes: byteSize,
  });

  return {
    id: asset.id,
    hash,
    key: s3Key,
    byteSize,
    s3Url: `https://${PHOTO_ARCHIVE_AWS.bucket}.s3.${PHOTO_ARCHIVE_AWS.region}.amazonaws.com/${s3Key}`,
  };
}
