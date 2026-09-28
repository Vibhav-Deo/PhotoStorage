/**
 * The object storage seam.
 *
 * Every byte this product stores — originals, derivatives, packed vectors, manifests —
 * crosses this interface and nothing else (Requirement 10.1). The method set is fixed by the
 * key seams section of `design.md`; what is added here is {@link ObjectStore.capabilities},
 * because verification has to know what a provider can prove before it picks how to prove it
 * (Requirement 6.3).
 *
 * ## Why the surface is this small
 *
 * The point of the seam is Requirement 10.5: migrating to a different S3-compatible provider
 * must require no change to object keys and no client code change. That holds only while the
 * interface stays inside the intersection of what S3-compatible providers actually agree on.
 * Five methods and a capability report are inside it. Lifecycle rules, tagging, object lock,
 * inventory, and server-side copy are not, and every one of them would put a provider-specific
 * assumption into calling code. Storage class is the one exception, carried as a hint in
 * {@link PutOptions} that a provider without tiering may ignore, because Requirements 9.2 and
 * 9.3 turn on originals and derivatives landing in different classes.
 *
 * There is deliberately **no list operation**. Nothing in the design needs one: every key is a
 * pure function of a content hash (see `keys.ts`), so the client derives keys rather than
 * discovering them, and `head` answers existence. A list operation would also be the first
 * place a provider's pagination and consistency differences leak into callers.
 *
 * ## What each implementation is for
 *
 * - `LocalFsObjectStore` (`@photo-archive/core/local-fs-store`) backs the entire Takeout
 *   importer with no AWS involvement, which is what lets Phase 2 build and test the hardest
 *   logic in the product — the metadata repair rules — before any cloud exists.
 * - `S3ObjectStore` (task 3.5) is the real one, and it has to pass
 *   {@link runObjectStoreConformance} unmodified. That is the executable form of the
 *   provider-swap claim.
 *
 * ## Error contract
 *
 * Implementations reject rather than throwing synchronously, always with an
 * {@link ObjectStoreError} subclass, and always naming the key. The one place a missing object
 * is *not* an error is {@link ObjectStore.head}, which returns `null`: existence checks are a
 * normal part of resuming an interrupted ingest, and a store that threw would make the common
 * path go through a `catch`.
 */

import { VerifyMethod } from '../states.ts';

/**
 * S3 storage class, as the wire spells it.
 *
 * Strings rather than the numeric `const` objects in `states.ts` because these are not
 * persisted in the database — they go into a request header and come back out of
 * `HeadObject` — so matching the API exactly is worth more than compactness. Only the two
 * classes the design uses are named: originals get Intelligent-Tiering because it reaches the
 * same ~$0.004/GB floor as Glacier Instant Retrieval with no retrieval fee and no minimum
 * duration, and derivatives stay Standard because objects under 128 KB are never auto-tiered
 * anyway (Requirements 9.2, 9.3).
 */
export const StorageClass = {
  /** Originals. Never modified once written. */
  IntelligentTiering: 'INTELLIGENT_TIERING',
  /** Derivatives, vectors, manifests — regenerable, and small enough that tiering buys nothing. */
  Standard: 'STANDARD',
} as const;
export type StorageClass = (typeof StorageClass)[keyof typeof StorageClass];

/** What S3 applies when a request names no class, and therefore this interface's default. */
export const DEFAULT_STORAGE_CLASS: StorageClass = StorageClass.Standard;

/**
 * Bytes going into the store.
 *
 * `Blob` and `ReadableStream` are the two the design names. `Uint8Array` is here because
 * derivatives are produced in memory — a 20 KB thumbnail should not have to be wrapped in a
 * stream to be written — and because it is the one representation both Node and React Native
 * hand back without ceremony.
 *
 * A stream body may only be consumed once, so a caller that needs to retry a failed upload has
 * to be able to produce a fresh stream. Implementations must not assume they can re-read one.
 */
export type ObjectBody = Uint8Array | Blob | ReadableStream<Uint8Array>;

export interface PutOptions {
  readonly contentType?: string;
  /** `'INTELLIGENT_TIERING'` for originals, `'STANDARD'` for derivatives (Req 9.2, 9.3). */
  readonly storageClass?: StorageClass;
  /**
   * Lowercase SHA-256 hex of the body, supplied so the *provider* rejects corrupted bytes
   * rather than storing them (Requirement 6.2).
   *
   * This is not in the design's sketch of `PutOptions`, and it is the one addition here that
   * changes what the interface can promise. S3 recomputes a supplied `x-amz-checksum-sha256`
   * server-side and refuses the write on mismatch, which is why the checksum verification
   * methods are *stronger* than re-downloading: corruption is caught before storage instead of
   * detected after. There is no way to get that guarantee without the digest reaching `put`.
   *
   * Providers that do not support additional checksums ignore it, which is exactly the case
   * {@link ObjectStoreCapabilities.additionalChecksumSha256} exists to report.
   */
  readonly sha256?: string;
}

/** Design: `put(...): Promise<{ etag: string }>`. */
export interface PutResult {
  /**
   * Provider entity tag, unquoted. Opaque: S3 makes it an MD5 for single-part uploads and a
   * composite for multipart, other providers make no such promise, so nothing may parse it.
   * Verification uses SHA-256 (`VerifyMethod`), never this.
   */
  readonly etag: string;
}

/**
 * A half-open-free byte range: **both ends inclusive**, matching the HTTP `Range` header this
 * becomes (`bytes=start-end`). Inclusive because translating to and from an exclusive end at
 * the one point it hits the wire is exactly where an off-by-one hides — a preview truncated by
 * a single byte still decodes, so the bug surfaces as a rare corrupt image rather than a test
 * failure.
 *
 * Omitting `end` reads to the end of the object. An `end` past the last byte is clamped, as S3
 * clamps it; a `start` at or past the end is {@link RangeNotSatisfiableError}, as S3 makes it a
 * 416.
 */
export interface ByteRange {
  readonly start: number;
  readonly end?: number;
}

export interface ObjectHead {
  readonly key: string;
  readonly size: number;
  /** See {@link PutResult.etag} — opaque, and never a substitute for verification. */
  readonly etag: string;
  readonly contentType: string | undefined;
  /** {@link DEFAULT_STORAGE_CLASS} when the provider has no notion of storage classes. */
  readonly storageClass: StorageClass;
  /** Epoch milliseconds. */
  readonly lastModified: number;
  /**
   * Base64 SHA-256 as the provider holds it, or `null` when it holds none — either because the
   * object was written without one or because
   * {@link ObjectStoreCapabilities.additionalChecksumSha256} is false. For a multipart upload
   * this is the composite, carrying S3's `-N` suffix.
   *
   * `null` is what forces verification onto `full_redownload_sha256` (Requirement 6.3), so an
   * implementation must not invent a value here. Reporting a locally computed digest as though
   * the provider had confirmed it would turn verification into a self-check that cannot fail,
   * and verification is the gate on irreversible deletion.
   */
  readonly checksumSha256: string | null;
  /**
   * Number of parts the object was uploaded in, or `null` for a single-part upload. Decides
   * between `S3ChecksumSha256` and `S3CompositeSha256`, because a composite digest can only be
   * reproduced by hashing the same part boundaries.
   */
  readonly partCount: number | null;
}

/**
 * What a provider can actually do, reported by {@link ObjectStore.capabilities}.
 *
 * Synchronous and constant for the lifetime of the store. A provider that has to probe an
 * endpoint to answer does the probing when it is constructed, because the caller for this is
 * the verification service choosing a method per asset — thousands of times — and a decision
 * that awaits is a decision that gets cached badly somewhere else.
 */
export interface ObjectStoreCapabilities {
  /** Names the implementation in errors and conformance output. Nothing branches on it. */
  readonly name: string;
  /**
   * The provider persists a SHA-256 supplied to {@link ObjectStore.put} and returns it from
   * {@link ObjectStore.head}. When false, verification cannot avoid egress and must fall back
   * to `full_redownload_sha256` (Requirement 6.3).
   */
  readonly additionalChecksumSha256: boolean;
  /**
   * The provider validates per-part SHA-256 digests and reports the composite from
   * {@link ObjectStore.head}, so a multipart original can be verified without re-download.
   * Cannot be true unless {@link additionalChecksumSha256} is.
   */
  readonly compositeChecksumSha256: boolean;
  /** Smallest permitted size for any part but the last. See {@link MIN_PART_SIZE_BYTES}. */
  readonly minPartSize: number;
  /** Most parts one multipart upload may have. See {@link MAX_PART_COUNT}. */
  readonly maxPartCount: number;
}

export interface UploadedPart {
  /** 1-based, ascending, no gaps. See {@link MAX_PART_COUNT}. */
  readonly partNumber: number;
  readonly etag: string;
  /** Base64 SHA-256 of this part, or `null` if the provider reported none. */
  readonly checksumSha256: string | null;
}

export interface UploadPartOptions {
  /** Lowercase SHA-256 hex of this part's bytes. See {@link PutOptions.sha256}. */
  readonly sha256?: string;
}

/**
 * An in-flight multipart upload.
 *
 * The handle is a value, not a session: `uploadId` and the {@link UploadedPart} list are the
 * whole state, both serializable, so an upload interrupted by process death can be resumed by
 * reconstructing the handle and calling {@link complete} with the parts already recorded. That
 * is what Requirements 1.9 and 2.4 need from the upload stage.
 *
 * Nothing is visible at the key until {@link complete}. Abandoned uploads consume storage until
 * {@link abort}, so a failed upload must abort rather than be dropped.
 */
export interface MultipartHandle {
  readonly key: string;
  readonly uploadId: string;

  /**
   * Uploads one part. Every part but the one with the highest number must be at least
   * {@link ObjectStoreCapabilities.minPartSize}; a provider is entitled to accept a short part
   * here and reject it at {@link complete}, which is what S3 does, so a caller must not read
   * success as acceptance.
   */
  uploadPart(
    partNumber: number,
    body: ObjectBody,
    options?: UploadPartOptions,
  ): Promise<UploadedPart>;

  /**
   * Assembles the object and makes it visible at {@link key}.
   *
   * @param parts The parts to assemble, in any order. Omit to use the parts uploaded through
   *   this handle; pass them explicitly when resuming an upload this handle did not start.
   */
  complete(parts?: readonly UploadedPart[]): Promise<PutResult>;

  /** Discards the upload and its parts. Idempotent, so it is safe in a `finally`. */
  abort(): Promise<void>;
}

/** Provider-agnostic S3. Swapping providers must not require client changes (Req 10.1, 10.5). */
export interface ObjectStore {
  /** Constant for the store's lifetime. See {@link ObjectStoreCapabilities}. */
  capabilities(): ObjectStoreCapabilities;

  put(key: string, body: ObjectBody, opts?: PutOptions): Promise<PutResult>;

  /** Rejects with {@link ObjectNotFoundError} if the key holds nothing. */
  get(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>;

  /** `null` rather than an error when the key holds nothing — see the error contract above. */
  head(key: string): Promise<ObjectHead | null>;

  /** Idempotent: deleting a key that holds nothing succeeds, as `DeleteObject` does. */
  delete(key: string): Promise<void>;

  createMultipart(key: string, opts?: PutOptions): Promise<MultipartHandle>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ObjectStoreError extends Error {
  override readonly name: string = 'ObjectStoreError';
  readonly key: string;

  constructor(message: string, key: string, options?: { cause?: unknown }) {
    super(message, options);
    this.key = key;
  }
}

/** From `get` or a read of a key that holds nothing. Never from `head`, which returns `null`. */
export class ObjectNotFoundError extends ObjectStoreError {
  override readonly name = 'ObjectNotFoundError';

  constructor(key: string, options?: { cause?: unknown }) {
    super(`no object at key ${JSON.stringify(key)}`, key, options);
  }
}

/**
 * The bytes written did not match the SHA-256 supplied to `put` or `uploadPart`, so nothing was
 * stored. This is the intended outcome of a corrupted read on the ingest side: it fails at the
 * boundary instead of storing bytes that will later fail verification and block reclamation.
 */
export class ChecksumMismatchError extends ObjectStoreError {
  override readonly name = 'ChecksumMismatchError';
  readonly expected: string;
  readonly actual: string;

  constructor(key: string, expected: string, actual: string) {
    super(
      `content did not match the supplied sha256 for key ${JSON.stringify(key)}: expected ` +
        `${expected}, computed ${actual} — nothing was stored`,
      key,
    );
    this.expected = expected;
    this.actual = actual;
  }
}

/** A range whose `start` is at or past the end of the object. HTTP 416. */
export class RangeNotSatisfiableError extends ObjectStoreError {
  override readonly name = 'RangeNotSatisfiableError';

  constructor(key: string, range: ByteRange, size: number) {
    super(
      `range start ${range.start} is past the end of ${JSON.stringify(key)} (${size} bytes)`,
      key,
    );
  }
}

/** A multipart upload was used in a way no provider accepts. Always a programming error. */
export class MultipartError extends ObjectStoreError {
  override readonly name = 'MultipartError';
}

/** A key that cannot be stored or that would not read back from where it was written. */
export class InvalidObjectKeyError extends ObjectStoreError {
  override readonly name = 'InvalidObjectKeyError';
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

/**
 * Characters permitted in a key segment. Intentionally narrower than S3, which allows almost
 * anything: every key this product stores comes from `keys.ts`, so the permissive shapes are
 * unreachable, and a store that maps keys onto a filesystem has to reject `..` and control
 * characters or a key becomes a path traversal. Validating in the contract rather than in one
 * implementation means the local store and the S3 store agree on what a key is, which is a
 * precondition for the conformance suite meaning anything.
 */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** Whether `key` is a well-formed object key. See {@link assertObjectKey}. */
export function isValidObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  for (const segment of key.split('/')) {
    if (segment === '.' || segment === '..') return false;
    if (!KEY_SEGMENT_PATTERN.test(segment)) return false;
  }
  return true;
}

/** Throws {@link InvalidObjectKeyError} unless {@link isValidObjectKey}. */
export function assertObjectKey(key: string): void {
  if (isValidObjectKey(key)) return;
  throw new InvalidObjectKeyError(
    `not a usable object key: ${JSON.stringify(key)} — keys must be 1..1024 characters of ` +
      "[A-Za-z0-9._:-] in '/'-separated non-empty segments, with no '.' or '..' segment",
    key,
  );
}

// ---------------------------------------------------------------------------
// Multipart sizing
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

/**
 * Above this, upload in parts. 8 MiB rather than S3's 5 MiB floor so that the smallest
 * multipart upload is comfortably two parts, and because it is the number tasks 3.5 and 7.4
 * name. Originals cross it routinely — a 48 MP HEIC does, every video does — while derivatives
 * never do, so in practice this is the originals path.
 */
export const MULTIPART_THRESHOLD_BYTES = 8 * MIB;

/** S3's minimum size for every part but the last. Below it, `CompleteMultipartUpload` fails. */
export const MIN_PART_SIZE_BYTES = 5 * MIB;

/** S3's part-number ceiling. Part numbers are 1-based, so the range is 1..10000. */
export const MAX_PART_COUNT = 10_000;

/**
 * Part sizes are rounded up to this so a plan is a round number of mebibytes.
 *
 * Not cosmetic. A multipart composite checksum is `sha256` of the concatenated part digests,
 * so it is reproducible only by an implementation that split the object at exactly the same
 * boundaries. Both the uploader and, later, the verifier have to derive the same plan from
 * nothing but the byte size, and keeping part sizes on a 1 MiB grid removes any chance that two
 * pieces of code disagree in the last few bytes of a division.
 */
const PART_SIZE_GRANULARITY_BYTES = MIB;

export interface MultipartPlan {
  /** Size of every part but the last. */
  readonly partSize: number;
  readonly partCount: number;
  /** Size of the highest-numbered part. Equal to {@link partSize} when the size divides evenly. */
  readonly lastPartSize: number;
}

export interface MultipartPlanOptions {
  readonly minPartSize?: number;
  readonly maxPartCount?: number;
}

/** Whether an object of `byteSize` should be uploaded in parts. */
export function shouldUseMultipart(
  byteSize: number,
  threshold = MULTIPART_THRESHOLD_BYTES,
): boolean {
  return byteSize > threshold;
}

/**
 * The one way to split an object into parts.
 *
 * A pure function of the byte size and the provider's limits, so the uploader and the verifier
 * reach the same answer without communicating — see {@link PART_SIZE_GRANULARITY_BYTES}. Takes
 * the smallest part size that keeps the part count within `maxPartCount`, which keeps parts
 * small enough that a failure retries little work.
 *
 * @throws {MultipartError} if `byteSize` is not a positive integer, or if no part size within
 *   the limits can cover it.
 */
export function planMultipart(byteSize: number, options: MultipartPlanOptions = {}): MultipartPlan {
  const minPartSize = options.minPartSize ?? MIN_PART_SIZE_BYTES;
  const maxPartCount = options.maxPartCount ?? MAX_PART_COUNT;

  if (!Number.isInteger(byteSize) || byteSize <= 0) {
    // Zero-byte objects go through `put`. S3 has no valid zero-byte part, so there is no plan
    // to return and pretending otherwise would fail at `complete` instead of here.
    throw new MultipartError(
      `multipart needs a positive integer byte size; got ${String(byteSize)} — use put() for ` +
        'an empty object',
      '',
    );
  }
  if (!Number.isInteger(minPartSize) || minPartSize <= 0) {
    throw new MultipartError(
      `minPartSize must be a positive integer; got ${String(minPartSize)}`,
      '',
    );
  }
  if (!Number.isInteger(maxPartCount) || maxPartCount <= 0) {
    throw new MultipartError(
      `maxPartCount must be a positive integer; got ${String(maxPartCount)}`,
      '',
    );
  }

  const needed = Math.ceil(byteSize / maxPartCount);
  const granularity = Math.min(PART_SIZE_GRANULARITY_BYTES, minPartSize);
  const partSize = Math.max(minPartSize, Math.ceil(needed / granularity) * granularity);
  const partCount = Math.ceil(byteSize / partSize);

  if (partCount > maxPartCount) {
    // Unreachable by construction: `partSize` is at least `ceil(byteSize / maxPartCount)`, so
    // the count cannot exceed the ceiling. Kept as an assertion rather than removed, because
    // this is the invariant a provider rejects an upload over, and the arithmetic above is the
    // kind that gets adjusted later.
    throw new MultipartError(
      `${byteSize} bytes cannot be split into at most ${maxPartCount} parts of ${partSize} bytes`,
      '',
    );
  }

  return {
    partSize,
    partCount,
    lastPartSize: byteSize - partSize * (partCount - 1),
  };
}

/**
 * Byte range of one 1-based part of a plan. Inclusive of both ends, like {@link ByteRange}, so
 * it can be handed straight to {@link ObjectStore.get}.
 */
export function partByteRange(plan: MultipartPlan, partNumber: number): Required<ByteRange> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new MultipartError(
      `part number must be an integer in 1..${plan.partCount}; got ${String(partNumber)}`,
      '',
    );
  }
  const start = (partNumber - 1) * plan.partSize;
  const size = partNumber === plan.partCount ? plan.lastPartSize : plan.partSize;
  return { start, end: start + size - 1 };
}

// ---------------------------------------------------------------------------
// Verification method selection
// ---------------------------------------------------------------------------

/**
 * Picks how the stored bytes will be proved to match the content hash, given what the provider
 * can do. This is the automatic fallback Requirement 6.3 asks for, in the one place both the
 * importer and the app can reach it.
 *
 * The checksum methods are preferred because they are both free and stronger: S3 refuses to
 * persist bytes that do not match a supplied SHA-256, so they catch corruption before storage
 * rather than after. `full_redownload_sha256` costs full egress per object, which is why it is
 * the fallback and not the default — but it works against every provider, so a store that
 * reports no checksum support degrades in cost rather than in safety. Nothing is ever verified
 * by trusting an upload's HTTP status.
 *
 * @param partCount Parts the object was uploaded in, as {@link ObjectHead.partCount} reports
 *   it: `null` for a single-part upload.
 */
export function verifyMethodFor(
  capabilities: ObjectStoreCapabilities,
  partCount: number | null = null,
): VerifyMethod {
  if (partCount !== null && partCount > 1) {
    return capabilities.compositeChecksumSha256
      ? VerifyMethod.S3CompositeSha256
      : VerifyMethod.FullRedownloadSha256;
  }
  return capabilities.additionalChecksumSha256
    ? VerifyMethod.S3ChecksumSha256
    : VerifyMethod.FullRedownloadSha256;
}
