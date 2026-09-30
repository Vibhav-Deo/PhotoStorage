/**
 * The `ObjectStore` conformance suite.
 *
 * A function, not a test file. `runObjectStoreConformance` is parameterised over a factory and
 * calls `describe`, so the same assertions run against `LocalFsObjectStore` in CI and against
 * `S3ObjectStore` pointed at a real bucket in task 3.5 — which is the requirement that shapes
 * this file: *"must pass the Phase 1.4 conformance suite unmodified."* A suite written against
 * the local store and later adapted would not be evidence of anything, because the adaptation
 * is where the differences would go.
 *
 * **Not exported from this package's root**, both because it imports `vitest` and because
 * `index.ts` is what Metro bundles. It is reachable as
 * `@photo-archive/core/store-conformance`.
 *
 * ## What it does and does not assert
 *
 * It asserts the semantics callers actually depend on, and each of these is a real difference
 * between plausible implementations rather than a restatement of the types:
 *
 * - Bytes come back byte-identical, whether written from memory or from a stream. This is the
 *   archive's whole promise, and originals must survive the round trip untouched.
 * - `head` returns `null` for a missing object instead of throwing, because resuming an
 *   interrupted ingest asks about every asset and absence is the normal answer.
 * - `delete` is idempotent, because a retried purge must not fail on the second attempt.
 * - Ranges are inclusive at both ends, an `end` past the object is clamped, and a `start` at or
 *   past it is an error. Video playback and part-wise verification both depend on this exactly.
 * - Nothing is visible at a key until `complete`, and short parts are refused there rather than
 *   at `uploadPart`.
 * - Storage class survives the round trip, which is how Requirements 9.2 and 9.3 are testable
 *   before any real bucket exists.
 * - `checksumSha256` is `null` unless the store claims the capability, and non-null when it
 *   does. A store that reported a locally computed digest would make verification incapable of
 *   failing.
 *
 * It deliberately asserts nothing about entity tag *format*. S3 makes it an MD5, or a composite
 * with a `-N` suffix, and another provider need not; verification uses SHA-256. Pinning the
 * shape here would fail a conforming provider for a reason that cannot affect correctness.
 *
 * ## Keys and cleanup
 *
 * Every test generates its own keys under `keyPrefix` and deletes them afterwards, because
 * against a real bucket the store is shared, IAM confines the caller to its own prefix
 * (Requirement 13.3), and objects left behind cost money. `keyPrefix` therefore has to be
 * settable to something inside the caller's partition.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MultipartError,
  ObjectNotFoundError,
  RangeNotSatisfiableError,
  StorageClass,
} from './objectStore.ts';
import type { ObjectStore } from './objectStore.ts';

export interface ObjectStoreFixture {
  readonly store: ObjectStore;
  /** Called after each test. Use it to remove a temp directory or close a client. */
  dispose?: () => Promise<void> | void;
}

export interface ObjectStoreConformanceOptions {
  /** Names the implementation in test output, e.g. `'LocalFsObjectStore'`. */
  readonly name: string;
  /**
   * Produces a store to test. Called before every test. May return the same underlying store
   * each time — the suite never assumes an empty namespace, only unique keys.
   */
  readonly create: () => Promise<ObjectStoreFixture> | ObjectStoreFixture;
  /**
   * Prefix for every key the suite writes. Must be inside the caller's own partition when
   * running against a real bucket. Defaults to `'conformance'`.
   */
  readonly keyPrefix?: string;
  /**
   * Whether to run the group that uploads parts of `capabilities().minPartSize`. Against S3
   * that is 5 MiB of real traffic per test, so an integration run that only wants the cheap
   * assertions can turn it off. Defaults to true, and turning it off leaves the multipart
   * rules only partly covered.
   */
  readonly includeMinimumPartSize?: boolean;
}

export function runObjectStoreConformance(options: ObjectStoreConformanceOptions): void {
  const keyPrefix = options.keyPrefix ?? 'conformance';
  const includeMinimumPartSize = options.includeMinimumPartSize ?? true;

  describe(`ObjectStore conformance: ${options.name}`, () => {
    let store: ObjectStore;
    let dispose: (() => Promise<void> | void) | undefined;
    let written: string[] = [];
    let counter = 0;

    beforeEach(async () => {
      const fixture = await options.create();
      store = fixture.store;
      dispose = fixture.dispose?.bind(fixture);
      written = [];
    });

    afterEach(async () => {
      for (const key of written) {
        try {
          await store.delete(key);
        } catch {
          // Cleanup is best effort. A test that already failed must not be reported twice.
        }
      }
      if (dispose !== undefined) await dispose();
    });

    /** A key unique to this test, registered for cleanup. */
    function key(label: string): string {
      counter += 1;
      return register(`${keyPrefix}/${label}-${String(counter)}-${token()}`);
    }

    function register(value: string): string {
      written.push(value);
      return value;
    }

    describe('capabilities', () => {
      it('reports a coherent set of limits', () => {
        const caps = store.capabilities();
        expect(caps.name.length).toBeGreaterThan(0);
        expect(Number.isInteger(caps.minPartSize)).toBe(true);
        expect(caps.minPartSize).toBeGreaterThan(0);
        expect(Number.isInteger(caps.maxPartCount)).toBe(true);
        expect(caps.maxPartCount).toBeGreaterThan(0);
      });

      it('cannot claim composite checksums without additional checksums', () => {
        const caps = store.capabilities();
        if (caps.compositeChecksumSha256) {
          expect(caps.additionalChecksumSha256).toBe(true);
        }
      });

      it('is constant, so a caller may cache the answer', () => {
        expect(store.capabilities()).toEqual(store.capabilities());
      });
    });

    describe('put, get, head', () => {
      it('round-trips bytes written from memory', async () => {
        const target = key('memory');
        const body = bytes(4096, 11);

        const result = await store.put(target, body, { contentType: 'image/webp' });
        expect(result.etag.length).toBeGreaterThan(0);

        expectSameBytes(await readAll(await store.get(target)), body);
      });

      it('round-trips bytes written from a stream, without needing a length', async () => {
        const target = key('stream');
        // Several chunks of uneven size: the importer writes originals in whatever pieces the
        // filesystem hands it, and a store that assumed one chunk would pass a single-chunk test.
        const chunks = [bytes(700, 1), bytes(1, 2), bytes(65_536, 3), bytes(9, 4)];

        await store.put(target, streamOf(chunks));

        expectSameBytes(await readAll(await store.get(target)), concat(chunks));
      });

      it('round-trips a Blob body', async () => {
        const target = key('blob');
        const body = bytes(2048, 5);

        await store.put(target, new Blob([body]));

        expectSameBytes(await readAll(await store.get(target)), body);
      });

      it('stores an empty object', async () => {
        const target = key('empty');

        await store.put(target, new Uint8Array(0));

        const head = await store.head(target);
        expect(head?.size).toBe(0);
        expectSameBytes(await readAll(await store.get(target)), new Uint8Array(0));
      });

      it('reports size, content type, and etag through head', async () => {
        const target = key('head');
        const body = bytes(1234, 7);

        const put = await store.put(target, body, { contentType: 'image/webp' });
        const head = await store.head(target);

        expect(head).not.toBeNull();
        expect(head?.key).toBe(target);
        expect(head?.size).toBe(1234);
        expect(head?.etag).toBe(put.etag);
        expect(head?.contentType).toBe('image/webp');
        expect(head?.partCount).toBeNull();
        expect(typeof head?.lastModified).toBe('number');
      });

      it('preserves the storage class, which is what Req 9.2/9.3 turn on', async () => {
        const original = key('orig');
        const derivative = key('derivative');
        const unspecified = key('unspecified');

        await store.put(original, bytes(64, 1), {
          storageClass: StorageClass.IntelligentTiering,
        });
        await store.put(derivative, bytes(64, 2), { storageClass: StorageClass.Standard });
        await store.put(unspecified, bytes(64, 3));

        expect((await store.head(original))?.storageClass).toBe(StorageClass.IntelligentTiering);
        expect((await store.head(derivative))?.storageClass).toBe(StorageClass.Standard);
        // No class named means Standard, as S3 has it.
        expect((await store.head(unspecified))?.storageClass).toBe(StorageClass.Standard);
      });

      it('reports a checksum only if it claims to support one', async () => {
        const target = key('checksum');
        const body = bytes(512, 9);

        await store.put(target, body, { sha256: await sha256Hex(body) });
        const head = await store.head(target);

        if (store.capabilities().additionalChecksumSha256) {
          expect(head?.checksumSha256).not.toBeNull();
        } else {
          // Anything else here would let verification compare a digest against itself.
          expect(head?.checksumSha256).toBeNull();
        }
      });

      it('accepts a matching sha256', async () => {
        const target = key('matching-sha');
        const body = bytes(3000, 13);

        await store.put(target, body, { sha256: await sha256Hex(body) });

        expectSameBytes(await readAll(await store.get(target)), body);
      });

      it('returns null from head for a key that holds nothing', async () => {
        expect(await store.head(key('absent'))).toBeNull();
      });

      it('rejects get for a key that holds nothing', async () => {
        await expect(store.get(key('absent-get'))).rejects.toBeInstanceOf(ObjectNotFoundError);
      });

      it('overwrites in place, leaving no trace of the previous bytes', async () => {
        const target = key('overwrite');
        await store.put(target, bytes(8192, 21));

        const replacement = bytes(100, 22);
        await store.put(target, replacement);

        expect((await store.head(target))?.size).toBe(100);
        expectSameBytes(await readAll(await store.get(target)), replacement);
      });
    });

    describe('byte ranges', () => {
      const body = bytes(10_000, 31);
      let target: string;

      beforeEach(async () => {
        target = key('range');
        await store.put(target, body);
      });

      it('reads an inclusive range', async () => {
        expectSameBytes(
          await readAll(await store.get(target, { start: 0, end: 9 })),
          body.slice(0, 10),
        );
        expectSameBytes(
          await readAll(await store.get(target, { start: 100, end: 199 })),
          body.slice(100, 200),
        );
      });

      it('reads a single byte', async () => {
        expectSameBytes(
          await readAll(await store.get(target, { start: 4567, end: 4567 })),
          body.slice(4567, 4568),
        );
      });

      it('reads to the end when no end is given', async () => {
        expectSameBytes(await readAll(await store.get(target, { start: 9990 })), body.slice(9990));
        expectSameBytes(await readAll(await store.get(target, { start: 0 })), body);
      });

      it('clamps an end past the last byte rather than failing', async () => {
        expectSameBytes(
          await readAll(await store.get(target, { start: 9995, end: 999_999 })),
          body.slice(9995),
        );
      });

      it('refuses a start at or past the end of the object', async () => {
        await expect(store.get(target, { start: 10_000 })).rejects.toBeInstanceOf(
          RangeNotSatisfiableError,
        );
        await expect(store.get(target, { start: 10_001, end: 10_050 })).rejects.toBeInstanceOf(
          RangeNotSatisfiableError,
        );
      });

      it('refuses any range on an empty object', async () => {
        const empty = key('empty-range');
        await store.put(empty, new Uint8Array(0));

        await expect(store.get(empty, { start: 0 })).rejects.toBeInstanceOf(
          RangeNotSatisfiableError,
        );
      });

      it('reassembles an object read as adjacent ranges', async () => {
        // The verification and export paths both read objects piecewise, so the ranges have to
        // tile the object exactly — an off-by-one here is a corrupt export.
        const window = 3333;
        const parts: Uint8Array[] = [];
        for (let start = 0; start < body.length; start += window) {
          parts.push(
            await readAll(
              await store.get(target, { start, end: Math.min(start + window, body.length) - 1 }),
            ),
          );
        }
        expectSameBytes(concat(parts), body);
      });
    });

    describe('delete', () => {
      it('removes the object', async () => {
        const target = key('delete');
        await store.put(target, bytes(256, 41));

        await store.delete(target);

        expect(await store.head(target)).toBeNull();
        await expect(store.get(target)).rejects.toBeInstanceOf(ObjectNotFoundError);
      });

      it('is idempotent, so a retried purge does not fail', async () => {
        const target = key('delete-idempotent');
        await store.put(target, bytes(256, 42));

        await store.delete(target);
        await store.delete(target);
        await store.delete(key('never-written'));
      });
    });

    describe('multipart', () => {
      it('makes nothing visible at the key until complete', async () => {
        const target = key('multipart-invisible');
        const upload = await store.createMultipart(target);
        try {
          await upload.uploadPart(1, bytes(1024, 51));
          expect(await store.head(target)).toBeNull();
        } finally {
          await upload.abort();
        }
      });

      it('abort leaves the key untouched', async () => {
        const target = key('multipart-abort');
        const upload = await store.createMultipart(target);
        await upload.uploadPart(1, bytes(1024, 52));

        await upload.abort();

        expect(await store.head(target)).toBeNull();
      });

      it('abort is idempotent', async () => {
        const upload = await store.createMultipart(key('multipart-abort-twice'));
        await upload.abort();
        await upload.abort();
      });

      it('refuses to complete with no parts', async () => {
        const upload = await store.createMultipart(key('multipart-no-parts'));
        try {
          await expect(upload.complete()).rejects.toBeInstanceOf(MultipartError);
        } finally {
          await upload.abort();
        }
      });

      it('refuses a part number outside 1..maxPartCount', async () => {
        const { maxPartCount } = store.capabilities();
        const upload = await store.createMultipart(key('multipart-part-number'));
        try {
          await expect(upload.uploadPart(0, bytes(16, 53))).rejects.toBeInstanceOf(MultipartError);
          await expect(upload.uploadPart(maxPartCount + 1, bytes(16, 54))).rejects.toBeInstanceOf(
            MultipartError,
          );
        } finally {
          await upload.abort();
        }
      });

      it('refuses a part below the minimum at complete, not at upload', async () => {
        const target = key('multipart-too-small');
        const { minPartSize } = store.capabilities();
        const upload = await store.createMultipart(target);
        try {
          // Accepted here — S3 accepts it too, and only refuses at CompleteMultipartUpload.
          await upload.uploadPart(1, bytes(Math.min(1024, minPartSize - 1), 55));
          await upload.uploadPart(2, bytes(64, 56));

          await expect(upload.complete()).rejects.toBeInstanceOf(MultipartError);
          expect(await store.head(target)).toBeNull();
        } finally {
          await upload.abort();
        }
      });

      it('rejects use after complete', async () => {
        const target = key('multipart-after-complete');
        const upload = await store.createMultipart(target);
        await upload.uploadPart(1, bytes(128, 57));
        await upload.complete();

        await expect(upload.uploadPart(2, bytes(128, 58))).rejects.toBeInstanceOf(MultipartError);
        await expect(upload.complete()).rejects.toBeInstanceOf(MultipartError);
      });

      it('completes a single-part upload', async () => {
        const target = key('multipart-single');
        const body = bytes(4096, 59);

        const upload = await store.createMultipart(target, {
          contentType: 'video/mp4',
          storageClass: StorageClass.IntelligentTiering,
        });
        await upload.uploadPart(1, body);
        const result = await upload.complete();

        expect(result.etag.length).toBeGreaterThan(0);
        const head = await store.head(target);
        expect(head?.size).toBe(4096);
        expect(head?.contentType).toBe('video/mp4');
        expect(head?.storageClass).toBe(StorageClass.IntelligentTiering);
        expectSameBytes(await readAll(await store.get(target)), body);
      });

      const partSizeSuite = includeMinimumPartSize ? describe : describe.skip;

      partSizeSuite('with parts at the provider minimum', () => {
        it('assembles parts in order regardless of upload order', async () => {
          const target = key('multipart-order');
          const { minPartSize } = store.capabilities();
          const first = bytes(minPartSize, 61);
          const second = bytes(minPartSize, 62);
          const tail = bytes(1000, 63);

          const upload = await store.createMultipart(target);
          // Uploaded out of order on purpose: parts go up concurrently and finish in whatever
          // order the network decides, so assembly must depend on the part number alone.
          const parts = await Promise.all([
            upload.uploadPart(3, tail),
            upload.uploadPart(1, first),
            upload.uploadPart(2, second),
          ]);
          expect(parts.map((part) => part.partNumber).sort((a, b) => a - b)).toEqual([1, 2, 3]);
          await upload.complete();

          const head = await store.head(target);
          expect(head?.size).toBe(minPartSize * 2 + 1000);
          expect(head?.partCount).toBe(3);
          expectSameBytes(await readAll(await store.get(target)), concat([first, second, tail]));
        });

        it('completes from an explicitly supplied part list, which is how a resume works', async () => {
          const target = key('multipart-resume');
          const { minPartSize } = store.capabilities();
          const first = bytes(minPartSize, 64);
          const tail = bytes(2048, 65);

          const upload = await store.createMultipart(target);
          const partOne = await upload.uploadPart(1, first);
          const partTwo = await upload.uploadPart(2, tail);

          // The handle already knows these; passing them is the shape a process that died and
          // restarted has to use, so it has to be the same call.
          await upload.complete([partTwo, partOne]);

          expectSameBytes(await readAll(await store.get(target)), concat([first, tail]));
          expect((await store.head(target))?.partCount).toBe(2);
        });

        it('serves ranges across a part boundary', async () => {
          const target = key('multipart-range');
          const { minPartSize } = store.capabilities();
          const first = bytes(minPartSize, 66);
          const tail = bytes(4096, 67);
          const whole = concat([first, tail]);

          const upload = await store.createMultipart(target);
          await upload.uploadPart(1, first);
          await upload.uploadPart(2, tail);
          await upload.complete();

          // Straddling the seam is the read that finds an assembly bug; a whole-object read
          // would not distinguish a store that concatenated the parts wrongly at the join.
          const start = minPartSize - 10;
          expectSameBytes(
            await readAll(await store.get(target, { start, end: start + 19 })),
            whole.slice(start, start + 20),
          );
        });
      });
    });

    describe('keys', () => {
      const rejected = ['', '/leading', 'trailing/', 'double//slash', '..', 'a/../b', 'a/./b'];

      it('refuses a key that would resolve outside where it was written', async () => {
        for (const bad of rejected) {
          await expect(store.put(bad, bytes(8, 71))).rejects.toThrow();
          await expect(store.get(bad)).rejects.toThrow();
          await expect(store.head(bad)).rejects.toThrow();
          await expect(store.delete(bad)).rejects.toThrow();
          await expect(store.createMultipart(bad)).rejects.toThrow();
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers. No Node built-ins: this file has to run wherever the tests do.
// ---------------------------------------------------------------------------

/**
 * Deterministic pseudo-random bytes.
 *
 * Deterministic so a failure is reproducible, and pseudo-random rather than a repeating pattern
 * because a store that dropped or duplicated a chunk would still produce a matching result if
 * every byte were the same value.
 */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = (seed * 2_654_435_761) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    out[index] = (state >>> 24) & 0xff;
  }
  return out;
}

/**
 * Compares byte arrays without handing them to a deep-equality matcher.
 *
 * `expect(a).toEqual(b)` on a multi-megabyte `Uint8Array` walks it through the generic
 * structural comparator, which turned a 10 MiB multipart assertion into a test that ran past a
 * five-second timeout. Length first, then a plain loop, then one assertion carrying the index
 * that differed — which is also a better failure message than a truncated dump of ten million
 * numbers.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  let firstDifference = -1;
  for (let index = 0; index < expected.byteLength; index += 1) {
    if (actual[index] !== expected[index]) {
      firstDifference = index;
      break;
    }
  }
  expect(firstDifference, `bytes differ at offset ${String(firstDifference)}`).toBe(-1);
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

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return concat(chunks);
}

/** WebCrypto rather than `node:crypto`, so this module stays free of Node built-ins. */
async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function token(): string {
  return Math.floor(Math.random() * 0xffff_ffff)
    .toString(36)
    .padStart(7, '0');
}
