/**
 * Streaming content hashing, and `hashFile`.
 *
 * The assertions worth naming:
 *
 * - **Byte-identical fixtures arriving by different paths converge on one digest**, which is
 *   the whole basis of Requirement 3.2. Tested with real files at unrelated paths, with
 *   different names and different mtimes, because that is the shape the actual case takes: the
 *   same photo as `Takeout/Google Photos/Photos from 2019/IMG_1234.HEIC` and as
 *   `DCIM/100APPLE/IMG_1234.HEIC`.
 * - **Nothing buffers.** Asserted by instrumenting the hasher: a 32 MiB file is hashed and the
 *   largest single `update` is required to stay at the read buffer size. A `hashFile` that
 *   accumulated would be indistinguishable by digest and obvious here.
 * - **Every source shape gives the same answer**, since the importer hands over a file stream
 *   and the app will hand over whatever `expo-file-system` yields.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { origKey } from '../keys.ts';
import {
  HashMismatchError,
  InvalidDigestError,
  assertContentHash,
  hashBytes,
} from './contentHash.ts';
import { DEFAULT_FILE_CHUNK_BYTES, hashFile, nodeSha256 } from './nodeHash.ts';
import { portableSha256, type Sha256, type Sha256Factory } from './sha256.ts';

const PREFIX = 'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10';

function reference(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic pseudo-image bytes; nothing here decodes them. */
function fixtureBytes(length: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = (state >>> 16) & 0xff;
  }
  return bytes;
}

describe('hashBytes', () => {
  const bytes = fixtureBytes(5000);

  it('returns the digest and the byte size from one pass', async () => {
    const result = await hashBytes(bytes);
    expect(result.hash).toBe(reference(bytes));
    expect(result.byteSize).toBe(bytes.length);
  });

  it('produces a digest keys.ts accepts', async () => {
    const { hash } = await hashBytes(bytes);
    // The two modules have to agree on spelling or the digest cannot become an object key.
    expect(() => origKey(PREFIX, hash)).not.toThrow();
    expect(origKey(PREFIX, hash)).toBe(`${PREFIX}/orig/${hash}`);
  });

  it('hashes the empty source to the empty digest, with a zero byte size', async () => {
    const result = await hashBytes(new Uint8Array(0));
    expect(result).toEqual({
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteSize: 0,
    });
  });

  it('gives the same answer for every source shape', async () => {
    const chunks = [bytes.subarray(0, 1), bytes.subarray(1, 4097), bytes.subarray(4097)];
    const expected = { hash: reference(bytes), byteSize: bytes.length };

    expect(await hashBytes(bytes)).toEqual(expected);
    expect(await hashBytes(new Blob([bytes]))).toEqual(expected);
    expect(await hashBytes(new Blob([bytes]).stream())).toEqual(expected);
    expect(await hashBytes(chunks)).toEqual(expected);
    expect(
      await hashBytes(
        (async function* () {
          for (const chunk of chunks) {
            // A device file reader is naturally async, so the async-iterable branch has to work
            // with real suspension between chunks and not only with an immediately ready one.
            await Promise.resolve();
            yield chunk;
          }
        })(),
      ),
    ).toEqual(expected);
  });

  it('gives the same answer under either hasher, for any chunking', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 400 }), { maxLength: 10 }),
        async (chunks) => {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const portable = await hashBytes(chunks, { sha256: portableSha256 });
          const node = await hashBytes(chunks, { sha256: nodeSha256 });
          expect(portable).toEqual(node);
          expect(portable.byteSize).toBe(total);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('reports progress monotonically, ending at the byte size', async () => {
    const seen: number[] = [];
    const result = await hashBytes([bytes.subarray(0, 100), bytes.subarray(100)], {
      onProgress: (hashed) => seen.push(hashed),
    });
    expect(seen).toEqual([100, bytes.length]);
    expect(result.byteSize).toBe(bytes.length);
  });

  it('rejects a hasher that does not produce lowercase hex', async () => {
    // The hasher is injectable, so this is reachable: a native module returning base64, or
    // uppercase hex, would otherwise flow onward and either fail at key derivation or — worse —
    // store the same bytes under a second key.
    const uppercase: Sha256Factory = () => {
      const inner: Sha256 = portableSha256();
      return {
        update: (chunk) => inner.update(chunk),
        digest: () => inner.digest().toUpperCase(),
      };
    };
    await expect(hashBytes(bytes, { sha256: uppercase })).rejects.toBeInstanceOf(
      InvalidDigestError,
    );
  });

  it('propagates a source failure rather than returning a digest of a partial read', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 100));
        controller.error(new Error('source went away'));
      },
    });
    await expect(hashBytes(failing)).rejects.toThrow('source went away');
  });
});

describe('assertContentHash', () => {
  it('accepts a match and rejects anything else', async () => {
    const { hash } = await hashBytes(fixtureBytes(64));
    expect(() => assertContentHash('fixture', hash, hash)).not.toThrow();
    expect(() => assertContentHash('fixture', hash, { hash, byteSize: 64 })).not.toThrow();
    expect(() => assertContentHash('fixture', hash, 'f'.repeat(64))).toThrow(HashMismatchError);
    // Case-sensitive on purpose: folding here would let an uppercase digest pass and then
    // derive a key that cannot be found.
    expect(() => assertContentHash('fixture', hash, hash.toUpperCase())).toThrow(HashMismatchError);
  });
});

describe('hashFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'photo-archive-hash-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function write(relative: string, bytes: Uint8Array): Promise<string> {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    return target;
  }

  it('hashes a file to the same digest as its bytes', async () => {
    const bytes = fixtureBytes(200_000);
    const file = await write('IMG_1234.HEIC', bytes);
    expect(await hashFile(file)).toEqual({ hash: reference(bytes), byteSize: bytes.length });
  });

  it('converges on one digest for byte-identical files arriving by different paths', async () => {
    // The actual case Requirement 3.2 exists for: the same photo in a Takeout export and in the
    // device's camera roll. Different directory, different filename, different mtime, same bytes.
    const bytes = fixtureBytes(64_321, 7);
    const fromTakeout = await write('Takeout/Google Photos/Photos from 2019/IMG_1234.HEIC', bytes);
    const fromDevice = await write('DCIM/100APPLE/IMG_1234(1).heic', bytes);
    await fs.utimes(fromDevice, new Date(0), new Date(0));

    const takeout = await hashFile(fromTakeout);
    const device = await hashFile(fromDevice);

    expect(device).toEqual(takeout);
    // And therefore one object key, which is what makes it one stored object.
    expect(origKey(PREFIX, device.hash)).toBe(origKey(PREFIX, takeout.hash));
  });

  it('still converges when one side is hashed by the portable hasher', async () => {
    // The desktop importer uses OpenSSL and the device uses the TypeScript hasher. If these
    // diverged, a Takeout import would not deduplicate against the phone's own library.
    const bytes = fixtureBytes(300_000, 11);
    const file = await write('shared.jpg', bytes);
    expect(await hashFile(file, { sha256: portableSha256 })).toEqual(await hashFile(file));
  });

  it('differs for a single flipped byte', async () => {
    const bytes = fixtureBytes(10_000);
    const altered = Uint8Array.from(bytes);
    altered[5000] = (altered[5000] ?? 0) ^ 0x01;

    const a = await hashFile(await write('a.jpg', bytes));
    const b = await hashFile(await write('b.jpg', altered));
    expect(b.hash).not.toBe(a.hash);
    expect(b.byteSize).toBe(a.byteSize);
  });

  it('never holds more than one read buffer, whatever the file size', async () => {
    // Originals reach hundreds of megabytes and video reaches gigabytes, on a laptop already
    // running sharp and ffmpeg. 32 MiB is small enough for CI and 32× the read buffer, so an
    // implementation that accumulated would show up immediately.
    const bytes = fixtureBytes(32 * 1024 * 1024, 3);
    const file = await write('big.mov', bytes);

    let largestUpdate = 0;
    let updates = 0;
    const instrumented: Sha256Factory = () => {
      const inner = nodeSha256();
      return {
        update(chunk) {
          largestUpdate = Math.max(largestUpdate, chunk.byteLength);
          updates += 1;
          inner.update(chunk);
        },
        digest: () => inner.digest(),
      };
    };

    const result = await hashFile(file, { sha256: instrumented });
    expect(result).toEqual({ hash: reference(bytes), byteSize: bytes.length });
    expect(largestUpdate).toBeLessThanOrEqual(DEFAULT_FILE_CHUNK_BYTES);
    expect(updates).toBeGreaterThan(16);
  });

  it('honours a smaller read buffer', async () => {
    const bytes = fixtureBytes(100_000);
    const file = await write('small-buffer.jpg', bytes);

    let largestUpdate = 0;
    const instrumented: Sha256Factory = () => {
      const inner = nodeSha256();
      return {
        update(chunk) {
          largestUpdate = Math.max(largestUpdate, chunk.byteLength);
          inner.update(chunk);
        },
        digest: () => inner.digest(),
      };
    };

    expect(await hashFile(file, { chunkBytes: 4096, sha256: instrumented })).toEqual({
      hash: reference(bytes),
      byteSize: bytes.length,
    });
    expect(largestUpdate).toBeLessThanOrEqual(4096);
  });

  it('hashes a zero-byte file rather than treating it as an error', async () => {
    const file = await write('empty.jpg', new Uint8Array(0));
    expect(await hashFile(file)).toEqual({
      hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      byteSize: 0,
    });
  });

  it('propagates a missing file, which the caller records as unreadable', async () => {
    await expect(hashFile(path.join(root, 'absent.jpg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
