/**
 * Streaming content hashing — the digest every object key and every dedupe decision is
 * derived from (Requirements 3.1, 3.3).
 *
 * ## Streaming is the requirement, not an optimization
 *
 * Nothing here ever holds a whole original. Originals routinely run to hundreds of megabytes
 * and video to gigabytes; the importer processes them on a laptop that is simultaneously
 * running `sharp` and `ffmpeg`, and the app does it on a phone. So {@link hashBytes} consumes
 * a source chunk by chunk and retains nothing but the 32 bytes of hasher state, and the peak
 * memory of a hash is one chunk regardless of object size.
 *
 * The chunk size is the *reader's* decision, not this module's — a file stream's buffer, a
 * network response's frames — which is why there is no `chunkBytes` option here. What this
 * module guarantees is that it will not accumulate what it is handed. `hashFile` in
 * `@photo-archive/core/node-hash` sets the read buffer for the importer's case.
 *
 * ## Byte size comes back with the digest
 *
 * {@link ContentHash} carries `byteSize` because the caller needs it anyway — `assets.byte_size`
 * feeds the export-volume disclosure in Requirement 7.3 and the multipart plan in
 * `objectStore.ts` — and because getting it from the same pass costs nothing. Taking it from a
 * separate `stat` instead would mean the size and the digest could describe different reads of
 * a file that changed in between.
 *
 * ## Digests are validated, not trusted
 *
 * {@link hashBytes} checks its own output against `isContentHash` before returning it. That
 * looks redundant — {@link PortableSha256} cannot emit anything else — and it is not, because
 * the hasher is injectable. A {@link Sha256Factory} wired to a native module that returns
 * base64, or uppercase hex, would otherwise produce a value that flows onward and fails much
 * later at `origKey`, or worse does not fail and stores the same bytes under a second key.
 */

import { isContentHash } from '../keys.ts';
import { portableSha256, type Sha256Factory } from './sha256.ts';

/** A digest and the size of the bytes it covers. Both from one pass over the source. */
export interface ContentHash {
  /** SHA-256 of the original bytes, 64 lowercase hex characters (Requirement 3.1). */
  readonly hash: string;
  /** Bytes hashed. `assets.byte_size`. */
  readonly byteSize: number;
}

/**
 * Anything that can be read as a sequence of byte chunks.
 *
 * `Uint8Array` for derivatives, which are produced in memory. `Blob` and
 * `ReadableStream` because they are what the platforms hand over — a `fetch` body, a
 * `File` from a picker. `AsyncIterable` because that is the shape a Node stream adapts to and
 * the shape a device file reader is easiest to express as. `Iterable` for the test and fixture
 * cases where the chunk boundaries are the point.
 *
 * A stream or an iterator can only be consumed once, so a caller that needs to hash and then
 * upload the same bytes must be able to produce the source twice. This mirrors
 * {@link ObjectBody} in `objectStore.ts`, deliberately: the two are the read and write ends of
 * the same pipeline.
 */
export type ByteSource =
  Uint8Array | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface HashOptions {
  /**
   * Hasher to use. Defaults to {@link portableSha256}, which runs anywhere. The importer
   * passes `nodeSha256`; the device may later pass a native incremental hasher.
   */
  readonly sha256?: Sha256Factory;
  /**
   * Called after each chunk with the running total, for ingest progress (Requirement 2.7).
   * Invoked synchronously and often, so it must be cheap — accumulate, do not render.
   */
  readonly onProgress?: (bytesHashed: number) => void;
}

/** Thrown when a {@link Sha256Factory} produces something that is not a usable digest. */
export class InvalidDigestError extends Error {
  override readonly name = 'InvalidDigestError';
  readonly digest: string;

  constructor(digest: string, hasherDescription: string) {
    super(
      `${hasherDescription} produced ${JSON.stringify(digest)}, which is not 64 lowercase hex ` +
        'characters. Content hashes are the object keys and the dedupe boundary, so a differently ' +
        'spelled digest stores the same bytes twice rather than failing.',
    );
    this.digest = digest;
  }
}

/**
 * Two reads of what should be the same content produced different digests.
 *
 * Distinct from `ChecksumMismatchError` in `objectStore.ts`, which is about a *store* refusing
 * bytes. This one is about the archive's own bookkeeping disagreeing with itself, and it is
 * always either corruption or a source that does not return the bytes it claims to.
 */
export class HashMismatchError extends Error {
  override readonly name = 'HashMismatchError';
  readonly expected: string;
  readonly actual: string;

  constructor(subject: string, expected: string, actual: string) {
    super(`${subject}: expected sha256 ${expected}, computed ${actual}`);
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Hashes `source` in one streaming pass.
 *
 * @throws {InvalidDigestError} if the injected hasher does not produce lowercase hex.
 */
export async function hashBytes(
  source: ByteSource,
  options: HashOptions = {},
): Promise<ContentHash> {
  const hasher = (options.sha256 ?? portableSha256)();
  const { onProgress } = options;
  let byteSize = 0;

  for await (const chunk of iterateSource(source)) {
    if (chunk.byteLength === 0) continue;
    hasher.update(chunk);
    byteSize += chunk.byteLength;
    if (onProgress !== undefined) onProgress(byteSize);
  }

  const hash = hasher.digest();
  if (!isContentHash(hash)) {
    throw new InvalidDigestError(
      hash,
      options.sha256 === undefined ? 'the default SHA-256' : 'the supplied Sha256Factory',
    );
  }
  return { hash, byteSize };
}

/**
 * Throws unless `actual` matches `expected`.
 *
 * The comparison is case-sensitive on purpose. `keys.ts` rejects uppercase for the same
 * reason: folding case here would let a caller that produced an uppercase digest pass this
 * check and then derive a key that cannot be found.
 *
 * @param subject What was being hashed, for the message — a path, a key, a local id.
 */
export function assertContentHash(
  subject: string,
  expected: string,
  actual: string | ContentHash,
): void {
  const computed = typeof actual === 'string' ? actual : actual.hash;
  if (computed === expected) return;
  throw new HashMismatchError(subject, expected, computed);
}

/**
 * Normalizes the five source shapes to an async chunk sequence.
 *
 * `ReadableStream` is drained through `getReader()` rather than `for await`, because async
 * iteration on a `ReadableStream` is a recent and unevenly implemented addition — Node has
 * it, React Native's polyfills may not — while `getReader()` has always been there. Same
 * reasoning as `iterateBody` in `localFsObjectStore.ts`; that one is Node-only and this one is
 * the version that has to hold on the device.
 */
async function* iterateSource(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  // Streams are matched before the iterable branches on purpose: Node's `ReadableStream`
  // *does* declare async iteration, so testing for that first would route it down a path that
  // React Native's polyfill cannot take.
  if ('getReader' in source) {
    yield* iterateStream(source);
    return;
  }
  // Duck-typed rather than `instanceof Blob`, because `Blob` is a global that may be absent and
  // a `typeof` guard would not narrow the union on the other branch.
  if ('stream' in source) {
    yield* iterateStream(source.stream() as ReadableStream<Uint8Array>);
    return;
  }
  if (Symbol.asyncIterator in source) {
    for await (const chunk of source) yield chunk;
    return;
  }
  for (const chunk of source) yield chunk;
}

async function* iterateStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
