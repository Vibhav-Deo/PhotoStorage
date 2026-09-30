/**
 * Content hashing on Node.
 *
 * **Not exported from this package's root.** It is reachable only as
 * `@photo-archive/core/node-hash`, because `index.ts` is what Metro bundles for the app and a
 * bare `node:crypto` import in that graph fails the bundle — the same rule
 * `db/nodeSqliteDriver.ts` and `store/localFsObjectStore.ts` follow.
 *
 * Two things live here, and only two:
 *
 * - {@link nodeSha256}, which is {@link PortableSha256}'s job done by OpenSSL. The portable
 *   hasher exists because the device has no incremental digest available (see `sha256.ts`); the
 *   importer has one, and the difference is an order of magnitude of throughput on a workload
 *   that is measured in terabytes. Both produce the same lowercase hex for the same bytes,
 *   which `sha256.test.ts` asserts over random inputs — that equality is what makes dedupe
 *   between a desktop Takeout import and a device ingest work at all (Requirement 3.2).
 * - {@link hashFile}, the importer's entry point: a path in, a digest and a byte size out,
 *   nothing larger than one read buffer resident at any moment.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

import { hashBytes, type ContentHash, type HashOptions } from './contentHash.ts';
import { Sha256FinalizedError, type Sha256Factory } from './sha256.ts';

/**
 * OpenSSL's SHA-256, wrapped to the {@link Sha256} contract.
 *
 * The wrapper is not ceremony: `node:crypto` throws its own error shape on reuse after
 * `digest()`, and a caller that handles {@link Sha256FinalizedError} has to see the same
 * failure regardless of which hasher it was handed. A seam whose implementations fail
 * differently is a seam that leaks.
 */
export const nodeSha256: Sha256Factory = () => {
  const hash = createHash('sha256');
  let finalized = false;
  return {
    update(chunk: Uint8Array): void {
      if (finalized) throw new Sha256FinalizedError('update');
      hash.update(chunk);
    },
    digest(): string {
      if (finalized) throw new Sha256FinalizedError('finalize');
      finalized = true;
      return hash.digest('hex');
    },
  };
};

/**
 * Bytes read per `read()` while hashing a file.
 *
 * 1 MiB rather than Node's 64 KiB default, because the importer hashes tens of thousands of
 * multi-megabyte files and the syscall count matters more than the resident buffer at this
 * size. It is also the ceiling on how much of any original is in memory during a hash, which
 * is the property that makes hashing a 4 GB video on a laptop unremarkable.
 */
export const DEFAULT_FILE_CHUNK_BYTES = 1024 * 1024;

export interface HashFileOptions extends HashOptions {
  /** Read buffer size. Defaults to {@link DEFAULT_FILE_CHUNK_BYTES}. */
  readonly chunkBytes?: number;
}

/**
 * Streams a file and returns its content hash and byte size.
 *
 * Never buffers the file: peak memory is one `chunkBytes` read regardless of file size
 * (Requirement 3.1 over originals that reach gigabytes).
 *
 * The file is not opened twice and its size is not taken from `stat`. Both digest and size
 * come from the same read, so a file that is being written while it is hashed cannot produce a
 * size that describes one read and a digest that describes another — which for an archive that
 * later verifies stored bytes against this digest would surface as an unexplainable
 * verification failure long after the fact.
 *
 * Filesystem failures propagate as-is, `ENOENT` included. They are not wrapped, because the
 * caller is the ingest pipeline and `local_assets.hash_state = unreadable` is the handling the
 * design specifies for an original that cannot be read — see `markSourceUnreadable` in
 * `ingest/dedupe.ts`.
 */
export async function hashFile(
  filePath: string,
  options: HashFileOptions = {},
): Promise<ContentHash> {
  const readable = createReadStream(filePath, {
    highWaterMark: options.chunkBytes ?? DEFAULT_FILE_CHUNK_BYTES,
  });
  try {
    return await hashBytes(Readable.toWeb(readable) as ReadableStream<Uint8Array>, {
      sha256: options.sha256 ?? nodeSha256,
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    });
  } finally {
    // `Readable.toWeb` closes the stream on normal completion; this covers the abandoned case,
    // where an error partway through would otherwise leave the descriptor open. An importer
    // that hits a failing directory would run out of descriptors before it ran out of files.
    readable.destroy();
  }
}
