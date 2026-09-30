/**
 * `ObjectStore` over the local filesystem.
 *
 * **Not exported from this package's root.** It is reachable only as
 * `@photo-archive/core/local-fs-store`, because `index.ts` is what Metro bundles for the app and
 * a bare `node:fs` import in that graph fails the bundle — the same rule
 * `db/nodeSqliteDriver.ts` follows.
 *
 * ## This is not a stub
 *
 * The whole Takeout importer runs on it. That is the point of the sequencing in `tasks.md`:
 * the metadata repair rules are the hardest logic in the product and the actual
 * differentiator, so they get built and tested with no AWS account, no credentials, and no
 * network — and S3 is swapped in afterwards once the pipeline is proven (task 3.7 changes
 * configuration only). A fake would make Phase 2 prove nothing about Phase 3, so this
 * implementation streams, supports byte ranges, and simulates multipart with S3's part-size
 * rules rather than approximating any of it.
 *
 * ## On-disk layout
 *
 * Three parallel trees under `root`:
 *
 * ```
 * {root}/objects/{key}          the bytes, unmodified, at a path mirroring the key
 * {root}/meta/{key}.json        sidecar: storage class, content type, digests, timestamps
 * {root}/uploads/{uploadId}/    parts of an in-flight multipart upload
 * ```
 *
 * Parallel trees rather than a sidecar beside each object, because `{key}.json` next to `{key}`
 * makes a key ending in `.json` collide with another key's metadata. Objects keep their real
 * key as their path — no encoding, no hashing — so the tree is inspectable with `ls` and an
 * original is a file you can open, which is what makes the byte-identity assertions in task 2.7
 * meaningful and what lets the Phase 2 fixture corpus be debugged by looking at it.
 *
 * Storage class lives in the sidecar because the filesystem has nowhere else to put it, and it
 * has to be recorded rather than dropped: Requirements 9.2 and 9.3 are about originals and
 * derivatives landing in different classes, and the only way that is testable before S3 exists
 * is for the local store to report back what it was told.
 *
 * ## Why it reports no checksum support
 *
 * {@link LocalFsObjectStore.capabilities} returns `additionalChecksumSha256: false`, and
 * {@link LocalFsObjectStore.head} returns `checksumSha256: null`, **deliberately**. A local
 * store could trivially report the digest it computed on write, and doing so would be a lie of
 * the most dangerous kind available here: verification would be comparing a number against
 * itself, so it could not fail, and verification is the gate on irreversible deletion
 * (Requirement 6.2). Reporting no support instead means every Phase 2 run drives the
 * `full_redownload_sha256` path (Requirement 6.3), so the fallback is exercised continuously
 * rather than first tried against a provider that turned out to lack checksums.
 *
 * A digest supplied to {@link LocalFsObjectStore.put} is still *checked*, and a mismatch stores
 * nothing. That is not the same capability: it mirrors S3 refusing to persist bytes that do not
 * match `x-amz-checksum-sha256`, which is what the ingest error path has to handle, and it is
 * independent of whether the provider will report a digest back later.
 *
 * ## Durability
 *
 * Writes go to a temp file and are renamed into place, so an interrupted write leaves no
 * partial object visible at the key — the state a resumed ingest would otherwise mistake for a
 * complete upload. `rename` within one filesystem is atomic; `fsync` is not called, because
 * this store backs an importer whose work is resumable from the job queue, not a database.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import {
  ChecksumMismatchError,
  DEFAULT_STORAGE_CLASS,
  MAX_PART_COUNT,
  MIN_PART_SIZE_BYTES,
  MultipartError,
  ObjectNotFoundError,
  ObjectStoreError,
  RangeNotSatisfiableError,
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
  StorageClass,
  UploadPartOptions,
  UploadedPart,
} from './objectStore.ts';

const OBJECTS_DIR = 'objects';
const META_DIR = 'meta';
const UPLOADS_DIR = 'uploads';
const TMP_DIR = 'tmp';

/** Part filenames are zero-padded so a directory listing is in part order. */
const PART_NUMBER_DIGITS = 5;

export interface LocalFsObjectStoreOptions {
  /** Directory to hold the three trees. Created on first write; need not exist yet. */
  readonly root: string;
  /**
   * Minimum size for every part but the last, reported through `capabilities()` and enforced
   * at `complete()`. Defaults to S3's {@link MIN_PART_SIZE_BYTES}, which is what makes local
   * multipart behaviour transfer to S3. Lower it only in a test that is specifically about
   * part-size rules and does not want to move 5 MiB to check them.
   */
  readonly minPartSize?: number;
  readonly maxPartCount?: number;
}

/** The sidecar. Written whole; read whole. Schema changes are not migrated — this is a cache. */
interface ObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string;
  readonly storageClass: StorageClass;
  readonly lastModified: number;
  /**
   * Lowercase SHA-256 hex of the stored bytes. Recorded for debugging and so a test can corrupt
   * an object and still know what it should have been — never reported through `head()`, for the
   * reason in this module's header.
   */
  readonly sha256: string;
  readonly partCount: number | null;
}

/** Records the `createMultipart` arguments so `complete()` can honour them after a restart. */
interface UploadMetadata {
  readonly key: string;
  readonly contentType?: string;
  readonly storageClass: StorageClass;
  readonly sha256?: string;
}

export class LocalFsObjectStore implements ObjectStore {
  readonly root: string;

  private readonly caps: ObjectStoreCapabilities;

  constructor(options: LocalFsObjectStoreOptions) {
    this.root = path.resolve(options.root);
    this.caps = {
      name: `local-fs (${this.root})`,
      // Both false on purpose. See this module's header.
      additionalChecksumSha256: false,
      compositeChecksumSha256: false,
      minPartSize: options.minPartSize ?? MIN_PART_SIZE_BYTES,
      maxPartCount: options.maxPartCount ?? MAX_PART_COUNT,
    };
    if (!Number.isInteger(this.caps.minPartSize) || this.caps.minPartSize <= 0) {
      throw new MultipartError(
        `minPartSize must be a positive integer; got ${String(this.caps.minPartSize)}`,
        '',
      );
    }
  }

  capabilities(): ObjectStoreCapabilities {
    return this.caps;
  }

  /**
   * Absolute path of the file holding `key`'s bytes.
   *
   * Exposed so tests can do what no interface method allows: corrupt a stored object in place.
   * Task 8.1 needs exactly that — verification is only trustworthy if there is a test where it
   * fails — and there is no way to stage that failure through the contract.
   */
  objectPathFor(key: string): string {
    assertObjectKey(key);
    return this.resolveWithin(OBJECTS_DIR, key);
  }

  async put(key: string, body: ObjectBody, opts: PutOptions = {}): Promise<PutResult> {
    assertObjectKey(key);
    const destination = this.resolveWithin(OBJECTS_DIR, key);
    const temporary = await this.temporaryPath();

    let written: WrittenBytes;
    try {
      written = await writeBodyToFile(body, temporary);
    } catch (error) {
      await removeQuietly(temporary);
      throw wrap(error, key, 'writing object bytes');
    }

    if (opts.sha256 !== undefined && opts.sha256.toLowerCase() !== written.sha256) {
      // Nothing is renamed into place, so the mismatch leaves the key exactly as it was —
      // which is what S3 does when it rejects a checksum, and what a resumable ingest needs.
      await removeQuietly(temporary);
      throw new ChecksumMismatchError(key, opts.sha256.toLowerCase(), written.sha256);
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(temporary, destination);

    const etag = written.md5;
    await this.writeMetadata({
      key,
      size: written.size,
      etag,
      ...(opts.contentType === undefined ? {} : { contentType: opts.contentType }),
      storageClass: opts.storageClass ?? DEFAULT_STORAGE_CLASS,
      lastModified: Date.now(),
      sha256: written.sha256,
      partCount: null,
    });

    return { etag };
  }

  async get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
    assertObjectKey(key);
    const objectPath = this.resolveWithin(OBJECTS_DIR, key);

    let size: number;
    try {
      size = (await fs.stat(objectPath)).size;
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key, { cause: error });
      throw wrap(error, key, 'reading object');
    }

    if (range === undefined) {
      return toWebStream(createReadStream(objectPath));
    }

    const { start } = range;
    if (!Number.isInteger(start) || start < 0) {
      throw new ObjectStoreError(
        `range start must be a non-negative integer; got ${String(start)}`,
        key,
      );
    }
    if (range.end !== undefined && (!Number.isInteger(range.end) || range.end < 0)) {
      throw new ObjectStoreError(
        `range end must be a non-negative integer; got ${String(range.end)}`,
        key,
      );
    }
    // Also covers the zero-byte object, where every range is unsatisfiable, as S3 has it.
    if (start >= size) {
      throw new RangeNotSatisfiableError(key, range, size);
    }
    // An `end` past the last byte is clamped rather than refused, matching S3, so a caller that
    // reads a fixed window past the tail of an object gets the tail instead of an error.
    const end = Math.min(range.end ?? size - 1, size - 1);
    if (end < start) {
      throw new RangeNotSatisfiableError(key, range, size);
    }

    return toWebStream(createReadStream(objectPath, { start, end }));
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    const objectPath = this.resolveWithin(OBJECTS_DIR, key);

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(objectPath);
    } catch (error) {
      // Absence is an answer, not a failure: resuming an ingest asks this about every asset.
      if (isNotFound(error)) return null;
      throw wrap(error, key, 'heading object');
    }

    const metadata = await this.readMetadata(key);

    return {
      key,
      size: stat.size,
      etag: metadata?.etag ?? '',
      contentType: metadata?.contentType,
      storageClass: metadata?.storageClass ?? DEFAULT_STORAGE_CLASS,
      lastModified: metadata?.lastModified ?? stat.mtimeMs,
      // Always null. See this module's header: reporting the digest computed on write would
      // make verification unable to fail.
      checksumSha256: null,
      partCount: metadata?.partCount ?? null,
    };
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    await removeQuietly(this.resolveWithin(OBJECTS_DIR, key));
    await removeQuietly(this.metadataPathFor(key));
  }

  async createMultipart(key: string, opts: PutOptions = {}): Promise<MultipartHandle> {
    assertObjectKey(key);
    // A random id, not derived from the key, so two concurrent uploads to the same key do not
    // share a part directory — the importer retries, and a retry can overlap its predecessor.
    const uploadId = `${Date.now().toString(36)}-${randomToken()}`;
    const uploadDir = this.resolveWithin(UPLOADS_DIR, uploadId);
    await fs.mkdir(uploadDir, { recursive: true });

    const metadata: UploadMetadata = {
      key,
      ...(opts.contentType === undefined ? {} : { contentType: opts.contentType }),
      storageClass: opts.storageClass ?? DEFAULT_STORAGE_CLASS,
      ...(opts.sha256 === undefined ? {} : { sha256: opts.sha256 }),
    };
    await fs.writeFile(path.join(uploadDir, 'upload.json'), JSON.stringify(metadata, null, 2));

    return new LocalFsMultipartHandle(this, uploadId, uploadDir, metadata);
  }

  // --- internals shared with the multipart handle -------------------------------------------

  /** @internal */
  async finalizeAssembled(
    key: string,
    temporary: string,
    written: WrittenBytes,
    metadata: UploadMetadata,
    partCount: number,
    etag: string,
  ): Promise<void> {
    const destination = this.resolveWithin(OBJECTS_DIR, key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(temporary, destination);
    await this.writeMetadata({
      key,
      size: written.size,
      etag,
      ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
      storageClass: metadata.storageClass,
      lastModified: Date.now(),
      sha256: written.sha256,
      partCount,
    });
  }

  /** @internal */
  async temporaryPath(): Promise<string> {
    const directory = path.join(this.root, TMP_DIR);
    await fs.mkdir(directory, { recursive: true });
    return path.join(directory, `${Date.now().toString(36)}-${randomToken()}.tmp`);
  }

  private async writeMetadata(metadata: ObjectMetadata): Promise<void> {
    const metadataPath = this.metadataPathFor(metadata.key);
    await fs.mkdir(path.dirname(metadataPath), { recursive: true });
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }

  private async readMetadata(key: string): Promise<ObjectMetadata | null> {
    try {
      const raw = await fs.readFile(this.metadataPathFor(key), 'utf8');
      return JSON.parse(raw) as ObjectMetadata;
    } catch (error) {
      // A missing or unparseable sidecar degrades to filesystem facts rather than failing the
      // read: the object bytes are the archive, and the sidecar is metadata about them.
      if (isNotFound(error) || error instanceof SyntaxError) return null;
      throw wrap(error, key, 'reading object metadata');
    }
  }

  private metadataPathFor(key: string): string {
    return `${this.resolveWithin(META_DIR, key)}.json`;
  }

  /**
   * Joins a key onto one of the trees and refuses anything that escapes it.
   *
   * {@link assertObjectKey} already rejects `..`, so this is the second of two independent
   * checks. It stays because it is the one that holds if the key rules are ever loosened, and
   * because the consequence of being wrong is writing outside the store's directory.
   */
  private resolveWithin(tree: string, key: string): string {
    const base = path.join(this.root, tree);
    const resolved = path.resolve(base, key);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new ObjectStoreError(`key ${JSON.stringify(key)} resolves outside the store root`, key);
    }
    return resolved;
  }
}

type HandleState = 'open' | 'completed' | 'aborted';

class LocalFsMultipartHandle implements MultipartHandle {
  readonly key: string;
  readonly uploadId: string;

  private readonly store: LocalFsObjectStore;
  private readonly uploadDir: string;
  private readonly metadata: UploadMetadata;
  private readonly observed = new Map<number, UploadedPart>();
  private state: HandleState = 'open';

  constructor(
    store: LocalFsObjectStore,
    uploadId: string,
    uploadDir: string,
    metadata: UploadMetadata,
  ) {
    this.store = store;
    this.uploadId = uploadId;
    this.uploadDir = uploadDir;
    this.metadata = metadata;
    this.key = metadata.key;
  }

  async uploadPart(
    partNumber: number,
    body: ObjectBody,
    options: UploadPartOptions = {},
  ): Promise<UploadedPart> {
    this.assertOpen('uploadPart');
    const { maxPartCount } = this.store.capabilities();
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxPartCount) {
      throw new MultipartError(
        `part number must be an integer in 1..${maxPartCount}; got ${String(partNumber)}`,
        this.key,
      );
    }

    const partPath = this.partPath(partNumber);
    const written = await writeBodyToFile(body, partPath);

    if (options.sha256 !== undefined && options.sha256.toLowerCase() !== written.sha256) {
      await removeQuietly(partPath);
      this.observed.delete(partNumber);
      throw new ChecksumMismatchError(this.key, options.sha256.toLowerCase(), written.sha256);
    }

    // Short parts are accepted here and rejected at `complete()`, which is where S3 raises
    // EntityTooSmall. Matching the timing matters: an uploader that only learns at the end is
    // an uploader that has to handle learning at the end.
    const part: UploadedPart = {
      partNumber,
      etag: written.md5,
      // Null for the same reason `head()` reports null — the store proves nothing about
      // checksums, so it claims nothing.
      checksumSha256: null,
    };
    this.observed.set(partNumber, part);
    return part;
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

    const numbers = requested.map((part) => part.partNumber);
    if (new Set(numbers).size !== numbers.length) {
      throw new MultipartError(`multipart upload for ${this.key} lists a part twice`, this.key);
    }
    // S3 permits gaps in part numbers but requires them ascending, so the list is sorted rather
    // than required to arrive in order: parts are uploaded concurrently and complete out of it.
    const ordered = [...numbers].sort((a, b) => a - b);

    const sizes: number[] = [];
    for (const partNumber of ordered) {
      let size: number;
      try {
        size = (await fs.stat(this.partPath(partNumber))).size;
      } catch (error) {
        if (isNotFound(error)) {
          throw new MultipartError(
            `part ${partNumber} of ${this.key} was never uploaded`,
            this.key,
          );
        }
        throw wrap(error, this.key, `reading part ${partNumber}`);
      }
      sizes.push(size);
    }

    const { minPartSize } = this.store.capabilities();
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const size = sizes[index] ?? 0;
      if (size < minPartSize) {
        throw new MultipartError(
          `part ${String(ordered[index])} of ${this.key} is ${size} bytes, below the ` +
            `${minPartSize}-byte minimum for every part but the last`,
          this.key,
        );
      }
    }
    if ((sizes[sizes.length - 1] ?? 0) === 0) {
      throw new MultipartError(`the last part of ${this.key} is empty`, this.key);
    }

    const temporary = await this.store.temporaryPath();
    let written: WrittenBytes;
    let etag: string;
    try {
      const assembled = await assembleParts(
        ordered.map((partNumber) => this.partPath(partNumber)),
        temporary,
      );
      written = assembled.written;
      // S3's composite entity tag: md5 of the concatenated per-part md5 digests, then `-N`.
      // Reproduced rather than invented so that code reading an etag's shape behaves the same
      // against both stores — even though nothing may depend on it for correctness.
      etag = `${createHash('md5').update(assembled.partDigests).digest('hex')}-${String(ordered.length)}`;
    } catch (error) {
      await removeQuietly(temporary);
      throw wrap(error, this.key, 'assembling multipart upload');
    }

    if (
      this.metadata.sha256 !== undefined &&
      this.metadata.sha256.toLowerCase() !== written.sha256
    ) {
      await removeQuietly(temporary);
      throw new ChecksumMismatchError(this.key, this.metadata.sha256.toLowerCase(), written.sha256);
    }

    await this.store.finalizeAssembled(
      this.key,
      temporary,
      written,
      this.metadata,
      ordered.length,
      etag,
    );

    this.state = 'completed';
    await fs.rm(this.uploadDir, { recursive: true, force: true });
    return { etag };
  }

  async abort(): Promise<void> {
    // Idempotent, and a no-op after completion, so `abort()` in a `finally` is always safe.
    if (this.state === 'open') this.state = 'aborted';
    await fs.rm(this.uploadDir, { recursive: true, force: true });
  }

  private assertOpen(operation: string): void {
    if (this.state === 'open') return;
    throw new MultipartError(
      `cannot ${operation} on multipart upload ${this.uploadId} for ${this.key}: it is already ` +
        this.state,
      this.key,
    );
  }

  private partPath(partNumber: number): string {
    return path.join(
      this.uploadDir,
      `${String(partNumber).padStart(PART_NUMBER_DIGITS, '0')}.part`,
    );
  }
}

// ---------------------------------------------------------------------------
// Byte plumbing
// ---------------------------------------------------------------------------

interface WrittenBytes {
  readonly size: number;
  /** Lowercase hex. */
  readonly sha256: string;
  /** Lowercase hex, used as the entity tag exactly as S3 does for a single-part upload. */
  readonly md5: string;
}

/**
 * Streams a body to a file, hashing as it goes.
 *
 * One pass, never buffering the whole body: originals routinely run to hundreds of megabytes
 * and video to gigabytes, and the importer processes them on a laptop alongside `sharp` and
 * `ffmpeg`. Both digests come from the same pass because a second pass over a 4 GB video to
 * compute the other one is a minute of disk for nothing.
 */
async function writeBodyToFile(body: ObjectBody, destination: string): Promise<WrittenBytes> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  let size = 0;

  const handle = await fs.open(destination, 'w');
  try {
    for await (const chunk of iterateBody(body)) {
      sha256.update(chunk);
      md5.update(chunk);
      size += chunk.byteLength;
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }

  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}

interface AssembledParts {
  readonly written: WrittenBytes;
  /** Concatenated raw per-part MD5 digests, the input to S3's composite entity tag. */
  readonly partDigests: Uint8Array;
}

/** Concatenates part files into one object, hashing the whole and each part as it goes. */
async function assembleParts(
  partPaths: readonly string[],
  destination: string,
): Promise<AssembledParts> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  const digests: Uint8Array[] = [];
  let size = 0;

  const handle = await fs.open(destination, 'w');
  try {
    for (const partPath of partPaths) {
      const partMd5 = createHash('md5');
      for await (const chunk of createReadStream(partPath)) {
        const bytes = chunk as Uint8Array;
        sha256.update(bytes);
        md5.update(bytes);
        partMd5.update(bytes);
        size += bytes.byteLength;
        await handle.write(bytes);
      }
      digests.push(partMd5.digest());
    }
  } finally {
    await handle.close();
  }

  return {
    written: { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') },
    partDigests: concat(digests),
  };
}

/**
 * Normalizes the three body shapes to chunks.
 *
 * Streams are read through a reader rather than `for await`, because async iteration on a
 * `ReadableStream` is a recent and unevenly implemented addition — Node has it, React Native's
 * polyfills may not — and `getReader()` is the part of the Streams API that has always been
 * there. This store is Node-only, but the same normalization will be needed on the device.
 */
async function* iterateBody(body: ObjectBody): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > 0) yield body;
    return;
  }

  // Duck-typed rather than `instanceof Blob`, because `Blob` is a global that may not exist and
  // a `typeof Blob !== 'undefined'` guard does not narrow the union on the other branch.
  const stream: ReadableStream<Uint8Array> =
    'getReader' in body ? body : (body.stream() as ReadableStream<Uint8Array>);

  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function toWebStream(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as ReadableStream<Uint8Array>;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function randomToken(): string {
  return createHash('sha256')
    .update(`${String(process.pid)}:${String(Math.random())}:${String(process.hrtime.bigint())}`)
    .digest('hex')
    .slice(0, 16);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function removeQuietly(target: string): Promise<void> {
  await fs.rm(target, { force: true });
}

/** Keeps filesystem errors inside the interface's error contract, cause intact. */
function wrap(error: unknown, key: string, doing: string): ObjectStoreError {
  if (error instanceof ObjectStoreError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ObjectStoreError(`${doing} for ${JSON.stringify(key)} failed: ${message}`, key, {
    cause: error,
  });
}
