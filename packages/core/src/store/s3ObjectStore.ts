/**
 * `ObjectStore` backed by Amazon S3.
 *
 * **Not exported from this package's root.** Reachable as `@photo-archive/core/s3-store`.
 * The root export is what Metro bundles; a bare `@aws-sdk` import in that graph fails.
 *
 * Requirements:
 * - SigV4 against STS credentials (Req 6.2, 10.1, 10.5).
 * - Multipart above 8 MB (MULTIPART_THRESHOLD_BYTES), with per-part SHA-256 checksums.
 * - `x-amz-checksum-sha256` on single-part PutObject so S3 validates server-side.
 * - Locally computed composite checksum for multipart, matching S3's format.
 * - Must pass runObjectStoreConformance unmodified (task 3.5).
 *
 * Capabilities reported:
 * - additionalChecksumSha256: true  — S3 persists and returns the checksum from HeadObject.
 * - compositeChecksumSha256: true   — per-part checksums enable composite verification.
 */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';

import {
  ChecksumMismatchError,
  DEFAULT_STORAGE_CLASS,
  MAX_PART_COUNT,
  MIN_PART_SIZE_BYTES,
  MultipartError,
  ObjectNotFoundError,
  ObjectStoreError,
  RangeNotSatisfiableError,
  StorageClass,
  assertObjectKey,
} from './objectStore.ts';
import type {
  ByteRange,
  MultipartHandle,
  ObjectBody,
  ObjectHead,
  ObjectStore,
  ObjectStoreCapabilities,
  PutOptions,
  PutResult,
  UploadPartOptions,
  UploadedPart,
} from './objectStore.ts';

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  /** S3Client config — credentials, region, endpoint. */
  readonly clientConfig?: S3ClientConfig;
  /**
   * Key prefix prepended to every key. Must end with `/` when non-empty.
   * Used to scope the store to a tenant partition (e.g. `{sub}/`).
   */
  readonly keyPrefix?: string;
}

/** Converts a hex SHA-256 string to base64, which is what S3 expects. */
function hexToBase64(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return Buffer.from(bytes).toString('base64');
}

/** Computes SHA-256 of concatenated binary digests — S3's composite checksum input. */
async function compositeSha256Base64(partDigestsBase64: readonly string[]): Promise<string> {
  const parts = partDigestsBase64.map((b64) => Buffer.from(b64, 'base64'));
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    concat.set(p, offset);
    offset += p.byteLength;
  }
  const digest = await crypto.subtle.digest('SHA-256', concat);
  return Buffer.from(digest).toString('base64');
}

/** Reads a ReadableStream fully into a Uint8Array. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/** Normalises ObjectBody to Uint8Array for SDK calls that need a buffer. */
async function bodyToUint8Array(body: ObjectBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if ('getReader' in body) return readAll(body);
  return readAll(body.stream() as ReadableStream<Uint8Array>);
}

/** Maps S3 storage class strings to our StorageClass const. */
function parseStorageClass(raw: string | undefined): StorageClass {
  if (raw === 'INTELLIGENT_TIERING') return StorageClass.IntelligentTiering;
  return StorageClass.Standard;
}

function stripQuotes(etag: string | undefined): string {
  return (etag ?? '').replace(/^"|"$/g, '');
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly caps: ObjectStoreCapabilities;

  constructor(options: S3ObjectStoreOptions) {
    this.client = new S3Client(options.clientConfig ?? {});
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? '';
    this.caps = {
      name: `s3 (${this.bucket})`,
      additionalChecksumSha256: true,
      compositeChecksumSha256: true,
      minPartSize: MIN_PART_SIZE_BYTES,
      maxPartCount: MAX_PART_COUNT,
    };
  }

  capabilities(): ObjectStoreCapabilities {
    return this.caps;
  }

  private s3Key(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async put(key: string, body: ObjectBody, opts: PutOptions = {}): Promise<PutResult> {
    assertObjectKey(key);
    const bytes = await bodyToUint8Array(body);

    const checksumSha256 = opts.sha256 !== undefined ? hexToBase64(opts.sha256) : undefined;

    try {
      const result = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.s3Key(key),
          Body: bytes,
          ContentType: opts.contentType,
          StorageClass: opts.storageClass ?? DEFAULT_STORAGE_CLASS,
          ...(checksumSha256 !== undefined
            ? { ChecksumSHA256: checksumSha256, ChecksumAlgorithm: 'SHA256' }
            : {}),
        }),
      );
      return { etag: stripQuotes(result.ETag) };
    } catch (err) {
      throw wrapS3Error(err, key, 'put');
    }
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    assertObjectKey(key);

    let rangeHeader: string | undefined;
    if (range !== undefined) {
      rangeHeader =
        range.end !== undefined ? `bytes=${range.start}-${range.end}` : `bytes=${range.start}-`;
    }

    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.s3Key(key),
          ...(rangeHeader !== undefined ? { Range: rangeHeader } : {}),
        }),
      );

      if (!result.Body) throw new ObjectNotFoundError(key);

      // S3 returns 416 for unsatisfiable ranges — map to our error type.
      return result.Body.transformToWebStream() as ReadableStream<Uint8Array>;
    } catch (err) {
      if (isNotFound(err)) throw new ObjectNotFoundError(key, { cause: err });
      if (isRangeError(err)) {
        // We need the object size for the error message; use a best-effort value.
        throw new RangeNotSatisfiableError(key, range ?? { start: 0 }, 0);
      }
      throw wrapS3Error(err, key, 'get');
    }
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.s3Key(key),
          ChecksumMode: 'ENABLED',
        }),
      );

      // S3 returns the composite checksum with a `-N` suffix for multipart objects.
      const checksumSha256 = result.ChecksumSHA256 ?? null;

      return {
        key,
        size: result.ContentLength ?? 0,
        etag: stripQuotes(result.ETag),
        contentType: result.ContentType,
        storageClass: parseStorageClass(result.StorageClass),
        lastModified: result.LastModified?.getTime() ?? Date.now(),
        checksumSha256,
        partCount: result.PartsCount ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw wrapS3Error(err, key, 'head');
    }
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.s3Key(key) }),
      );
    } catch (err) {
      if (isNotFound(err)) return; // idempotent
      throw wrapS3Error(err, key, 'delete');
    }
  }

  async createMultipart(key: string, opts: PutOptions = {}): Promise<MultipartHandle> {
    assertObjectKey(key);
    try {
      const result = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.s3Key(key),
          ContentType: opts.contentType,
          StorageClass: opts.storageClass ?? DEFAULT_STORAGE_CLASS,
          ChecksumAlgorithm: 'SHA256',
        }),
      );
      if (!result.UploadId) throw new MultipartError('S3 returned no UploadId', key);
      return new S3MultipartHandle(
        this.client,
        this.bucket,
        this.s3Key(key),
        key,
        result.UploadId,
        this.caps,
      );
    } catch (err) {
      if (err instanceof MultipartError) throw err;
      throw wrapS3Error(err, key, 'createMultipart');
    }
  }
}

type HandleState = 'open' | 'completed' | 'aborted';

class S3MultipartHandle implements MultipartHandle {
  readonly key: string;
  readonly uploadId: string;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly s3Key: string;
  private readonly caps: ObjectStoreCapabilities;
  private readonly observed = new Map<number, UploadedPart>();
  private state: HandleState = 'open';

  constructor(
    client: S3Client,
    bucket: string,
    s3Key: string,
    key: string,
    uploadId: string,
    caps: ObjectStoreCapabilities,
  ) {
    this.client = client;
    this.bucket = bucket;
    this.s3Key = s3Key;
    this.key = key;
    this.uploadId = uploadId;
    this.caps = caps;
  }

  async uploadPart(
    partNumber: number,
    body: ObjectBody,
    options: UploadPartOptions = {},
  ): Promise<UploadedPart> {
    this.assertOpen('uploadPart');
    const { maxPartCount } = this.caps;
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxPartCount) {
      throw new MultipartError(
        `part number must be an integer in 1..${maxPartCount}; got ${String(partNumber)}`,
        this.key,
      );
    }

    const bytes = await bodyToUint8Array(body);
    const checksumSha256 = options.sha256 !== undefined ? hexToBase64(options.sha256) : undefined;

    try {
      const result = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: this.s3Key,
          UploadId: this.uploadId,
          PartNumber: partNumber,
          Body: bytes,
          ...(checksumSha256 !== undefined
            ? { ChecksumSHA256: checksumSha256, ChecksumAlgorithm: 'SHA256' }
            : {}),
        }),
      );

      const part: UploadedPart = {
        partNumber,
        etag: stripQuotes(result.ETag),
        checksumSha256: result.ChecksumSHA256 ?? null,
      };
      this.observed.set(partNumber, part);
      return part;
    } catch (err) {
      throw wrapS3Error(err, this.key, `uploadPart ${partNumber}`);
    }
  }

  async complete(parts?: readonly UploadedPart[]): Promise<PutResult> {
    this.assertOpen('complete');

    const requested = parts ?? [...this.observed.values()];
    if (requested.length === 0) {
      throw new MultipartError(
        `multipart upload for ${this.key} has no parts to complete`,
        this.key,
      );
    }

    const ordered = [...requested].sort((a, b) => a.partNumber - b.partNumber);

    // Compute the composite checksum from per-part checksums if available.
    const partChecksums = ordered
      .map((p) => p.checksumSha256)
      .filter((c): c is string => c !== null);
    const compositeChecksum =
      partChecksums.length === ordered.length
        ? await compositeSha256Base64(partChecksums)
        : undefined;

    try {
      const result = await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.s3Key,
          UploadId: this.uploadId,
          MultipartUpload: {
            Parts: ordered.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
              ...(p.checksumSha256 !== null ? { ChecksumSHA256: p.checksumSha256 } : {}),
            })),
          },
          ...(compositeChecksum !== undefined ? { ChecksumSHA256: compositeChecksum } : {}),
        }),
      );
      this.state = 'completed';
      return { etag: stripQuotes(result.ETag) };
    } catch (err) {
      // S3 EntityTooSmall → MultipartError (part below minimum size).
      if (isEntityTooSmall(err)) {
        throw new MultipartError(
          `a part of ${this.key} is below S3's minimum part size`,
          this.key,
          { cause: err },
        );
      }
      throw wrapS3Error(err, this.key, 'complete');
    }
  }

  async abort(): Promise<void> {
    if (this.state !== 'open') return;
    this.state = 'aborted';
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.s3Key,
          UploadId: this.uploadId,
        }),
      );
    } catch {
      // Abort is best-effort: the upload may already be gone.
    }
  }

  private assertOpen(operation: string): void {
    if (this.state === 'open') return;
    throw new MultipartError(
      `cannot ${operation} on multipart upload ${this.uploadId} for ${this.key}: already ${this.state}`,
      this.key,
    );
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  return (
    err instanceof NoSuchKey ||
    err instanceof NotFound ||
    (typeof err === 'object' &&
      err !== null &&
      ((err as { name?: string }).name === 'NoSuchKey' ||
        (err as { name?: string }).name === 'NotFound' ||
        (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404))
  );
}

function isRangeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 416
  );
}

function isEntityTooSmall(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { name?: string }).name === 'EntityTooSmall' ||
      (err as { Code?: string }).Code === 'EntityTooSmall')
  );
}

function wrapS3Error(err: unknown, key: string, operation: string): ObjectStoreError {
  if (err instanceof ObjectStoreError) return err;
  if (err instanceof ChecksumMismatchError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ObjectStoreError(
    `S3 ${operation} failed for ${JSON.stringify(key)}: ${message}`,
    key,
    { cause: err },
  );
}
