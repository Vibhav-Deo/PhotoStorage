/**
 * `LocalFsObjectStore`.
 *
 * Two things happen here. The conformance suite runs against it — twice, once with S3's real
 * 5 MiB part minimum and once with a lowered one, which is the cheapest available demonstration
 * that the suite is genuinely parameterised rather than written around this implementation.
 * Task 3.5 depends on that being true.
 *
 * Then the assertions that are *about* this implementation and cannot be in the shared suite:
 * where the bytes land on disk, that the sidecar carries the storage class, that a supplied
 * digest is checked, and that the store reports no checksum capability so verification takes the
 * `full_redownload_sha256` path throughout Phase 2.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { VerifyMethod } from '../states.ts';
import { runObjectStoreConformance } from './conformance.ts';
import {
  ChecksumMismatchError,
  MultipartError,
  StorageClass,
  verifyMethodFor,
} from './objectStore.ts';
import { LocalFsObjectStore } from './localFsObjectStore.ts';

const KEY = 'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/orig/a3f1';

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(tmpdir(), 'photo-archive-store-'));
}

// --- conformance -----------------------------------------------------------------------------

runObjectStoreConformance({
  name: 'LocalFsObjectStore',
  create: async () => {
    const root = await makeRoot();
    return {
      store: new LocalFsObjectStore({ root }),
      dispose: () => fs.rm(root, { recursive: true, force: true }),
    };
  },
});

// The same suite, unchanged, against a store configured with a 64 KiB part minimum. If any
// assertion in it had been written around 5 MiB, this run would fail.
runObjectStoreConformance({
  name: 'LocalFsObjectStore (64 KiB part minimum)',
  create: async () => {
    const root = await makeRoot();
    return {
      store: new LocalFsObjectStore({ root, minPartSize: 64 * 1024 }),
      dispose: () => fs.rm(root, { recursive: true, force: true }),
    };
  },
});

// --- implementation specifics ---------------------------------------------------------------

describe('LocalFsObjectStore', () => {
  let root: string;
  let store: LocalFsObjectStore;

  beforeEach(async () => {
    root = await makeRoot();
    // A small part minimum throughout: every assertion below is about something other than the
    // size of a part, and 5 MiB per case buys nothing.
    store = new LocalFsObjectStore({ root, minPartSize: 4096 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('capabilities', () => {
    it('reports no checksum support, so verification uses the re-download fallback', () => {
      const caps = store.capabilities();
      // Deliberate. A local store could report the digest it computed on write, and then
      // verification would be comparing a number against itself and could never fail — while
      // being the gate on irreversible deletion. Reporting no support instead means Requirement
      // 6.3's fallback is exercised by every Phase 2 run.
      expect(caps.additionalChecksumSha256).toBe(false);
      expect(caps.compositeChecksumSha256).toBe(false);
      expect(verifyMethodFor(caps, null)).toBe(VerifyMethod.FullRedownloadSha256);
      expect(verifyMethodFor(caps, 4)).toBe(VerifyMethod.FullRedownloadSha256);
    });

    it('names the root, so an error says which store it came from', () => {
      expect(store.capabilities().name).toContain(root);
    });

    it('rejects a nonsensical part minimum at construction', () => {
      expect(() => new LocalFsObjectStore({ root, minPartSize: 0 })).toThrow(MultipartError);
      expect(() => new LocalFsObjectStore({ root, minPartSize: 1.5 })).toThrow(MultipartError);
    });
  });

  describe('on-disk layout', () => {
    it('writes the bytes unmodified to a path mirroring the key', async () => {
      const body = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await store.put(KEY, body);

      // Byte identity of an original is the archive's central promise (Requirement 1.8), and
      // this is where it is cheapest to check: the stored object is a file.
      const onDisk = await fs.readFile(path.join(root, 'objects', KEY));
      expect(new Uint8Array(onDisk)).toEqual(body);
      expect(store.objectPathFor(KEY)).toBe(path.join(root, 'objects', KEY));
    });

    it('records the storage class as sidecar metadata', async () => {
      await store.put(KEY, new Uint8Array([1]), {
        contentType: 'image/heic',
        storageClass: StorageClass.IntelligentTiering,
      });

      const raw = await fs.readFile(path.join(root, 'meta', `${KEY}.json`), 'utf8');
      const sidecar = JSON.parse(raw) as Record<string, unknown>;
      expect(sidecar.storageClass).toBe(StorageClass.IntelligentTiering);
      expect(sidecar.contentType).toBe('image/heic');
      expect(sidecar.size).toBe(1);
      expect(sidecar.partCount).toBeNull();
    });

    it('keeps metadata on disk, not in the instance', async () => {
      await store.put(KEY, new Uint8Array([1, 2, 3]), {
        contentType: 'image/heic',
        storageClass: StorageClass.IntelligentTiering,
      });

      // A second store over the same root is what the importer gets on its next run after a
      // crash. Metadata held in memory would silently become Standard.
      const reopened = new LocalFsObjectStore({ root });
      const head = await reopened.head(KEY);
      expect(head?.storageClass).toBe(StorageClass.IntelligentTiering);
      expect(head?.contentType).toBe('image/heic');
      expect(head?.size).toBe(3);
    });

    it('reports the object even when the sidecar is gone, since the bytes are the archive', async () => {
      await store.put(KEY, new Uint8Array([1, 2, 3]), {
        storageClass: StorageClass.IntelligentTiering,
      });
      await fs.rm(path.join(root, 'meta', `${KEY}.json`));

      const head = await store.head(KEY);
      expect(head?.size).toBe(3);
      // Degrades to the default rather than failing the read.
      expect(head?.storageClass).toBe(StorageClass.Standard);
    });

    it('removes the sidecar with the object', async () => {
      await store.put(KEY, new Uint8Array([1]));
      await store.delete(KEY);

      await expect(fs.stat(path.join(root, 'meta', `${KEY}.json`))).rejects.toThrow();
    });

    it('never writes outside the root', async () => {
      const escaping = `${KEY}/../../../../escaped`;
      await expect(store.put(escaping, new Uint8Array([1]))).rejects.toThrow();
      await expect(fs.stat(path.join(root, '..', 'escaped'))).rejects.toThrow();
    });

    it('uses S3\u2019s entity tag shapes', async () => {
      const body = new Uint8Array([9, 8, 7, 6]);
      const single = await store.put(KEY, body);
      expect(single.etag).toBe(createHash('md5').update(body).digest('hex'));

      const multipartKey = `${KEY}-mp`;
      const upload = await store.createMultipart(multipartKey);
      await upload.uploadPart(1, new Uint8Array(4096));
      await upload.uploadPart(2, new Uint8Array([1, 2]));
      const composite = await upload.complete();
      // Not a contract — nothing may parse an etag — but matching the shape means code that
      // logs or compares one behaves the same against both stores.
      expect(composite.etag).toMatch(/^[0-9a-f]{32}-2$/);
    });
  });

  describe('supplied digests', () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);

    it('rejects bytes that do not match the supplied sha256, storing nothing', async () => {
      const wrong = 'f'.repeat(64);

      await expect(store.put(KEY, body, { sha256: wrong })).rejects.toBeInstanceOf(
        ChecksumMismatchError,
      );
      // S3 refuses the write rather than storing bytes it cannot vouch for, so the key must be
      // exactly as it was — which for a first write means empty.
      expect(await store.head(KEY)).toBeNull();
    });

    it('leaves an existing object intact when a replacement fails its checksum', async () => {
      const original = new Uint8Array([7, 7, 7]);
      await store.put(KEY, original);

      await expect(store.put(KEY, body, { sha256: 'a'.repeat(64) })).rejects.toBeInstanceOf(
        ChecksumMismatchError,
      );

      expect((await store.head(KEY))?.size).toBe(3);
    });

    it('accepts a digest whose case differs, since hex has no case', async () => {
      const hex = createHash('sha256').update(body).digest('hex');
      await store.put(KEY, body, { sha256: hex.toUpperCase() });
      expect((await store.head(KEY))?.size).toBe(body.length);
    });

    it('rejects a part that does not match its supplied sha256', async () => {
      const upload = await store.createMultipart(KEY);
      await expect(upload.uploadPart(1, body, { sha256: 'b'.repeat(64) })).rejects.toBeInstanceOf(
        ChecksumMismatchError,
      );

      // The rejected part is gone, so completing cannot silently assemble a partial object.
      await expect(
        upload.complete([{ partNumber: 1, etag: 'x', checksumSha256: null }]),
      ).rejects.toBeInstanceOf(MultipartError);
      await upload.abort();
    });

    it('rejects an assembled object that does not match the digest given at createMultipart', async () => {
      const upload = await store.createMultipart(KEY, { sha256: 'c'.repeat(64) });
      await upload.uploadPart(1, body);

      await expect(upload.complete()).rejects.toBeInstanceOf(ChecksumMismatchError);
      expect(await store.head(KEY)).toBeNull();
    });
  });

  describe('failure leaves nothing behind', () => {
    it('stores nothing when the body stream errors mid-write', async () => {
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error('source went away'));
        },
      });

      await expect(store.put(KEY, failing)).rejects.toThrow();
      // A partial object visible at the key is the state a resumed ingest would mistake for a
      // finished upload, which is how a truncated original reaches verification.
      expect(await store.head(KEY)).toBeNull();
    });

    it('discards a temp file rather than leaving it behind', async () => {
      await expect(
        store.put(KEY, new Uint8Array([1]), { sha256: 'd'.repeat(64) }),
      ).rejects.toThrow();

      const temporaries = await fs.readdir(path.join(root, 'tmp')).catch(() => []);
      expect(temporaries).toEqual([]);
    });

    it('removes the part directory on abort', async () => {
      const upload = await store.createMultipart(KEY);
      await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
      await upload.abort();

      const uploads = await fs.readdir(path.join(root, 'uploads'));
      expect(uploads).toEqual([]);
    });

    it('removes the part directory on complete', async () => {
      const upload = await store.createMultipart(KEY);
      await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
      await upload.complete();

      const uploads = await fs.readdir(path.join(root, 'uploads'));
      expect(uploads).toEqual([]);
    });
  });

  describe('ranges', () => {
    it('returns exactly the requested slice for any range within the object', async () => {
      const body = new Uint8Array(1024);
      for (let index = 0; index < body.length; index += 1) body[index] = (index * 31) & 0xff;
      await store.put(KEY, body);

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: body.length - 1 }),
          fc.integer({ min: 0, max: body.length - 1 }),
          async (a, b) => {
            const start = Math.min(a, b);
            const end = Math.max(a, b);
            const chunk = await readAll(await store.get(KEY, { start, end }));
            expect(chunk).toEqual(body.slice(start, end + 1));
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  describe('multipart part-size rules', () => {
    it('allows the last part to be short but no other', async () => {
      const upload = await store.createMultipart(KEY);
      await upload.uploadPart(1, new Uint8Array(4096));
      await upload.uploadPart(2, new Uint8Array(1));
      await upload.complete();

      expect((await store.head(KEY))?.size).toBe(4097);
    });

    it('permits gaps in part numbers, as S3 does', async () => {
      const upload = await store.createMultipart(KEY);
      await upload.uploadPart(1, new Uint8Array(4096).fill(1));
      await upload.uploadPart(9, new Uint8Array(2).fill(2));
      await upload.complete();

      const assembled = await readAll(await store.get(KEY));
      expect(assembled.length).toBe(4098);
      expect(assembled[4096]).toBe(2);
    });

    it('refuses a duplicated part number', async () => {
      const upload = await store.createMultipart(KEY);
      const part = await upload.uploadPart(1, new Uint8Array(4096));
      await expect(upload.complete([part, part])).rejects.toBeInstanceOf(MultipartError);
      await upload.abort();
    });

    it('refuses an empty last part', async () => {
      const upload = await store.createMultipart(KEY);
      await upload.uploadPart(1, new Uint8Array(0));
      await expect(upload.complete()).rejects.toBeInstanceOf(MultipartError);
      await upload.abort();
    });
  });
});

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
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
