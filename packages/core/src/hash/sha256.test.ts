/**
 * `PortableSha256`.
 *
 * Hand-written cryptographic code is only worth its risk if it is checked against a reference,
 * so this file does two things and nothing else clever:
 *
 * 1. **Published vectors.** The FIPS 180-4 examples plus the empty string, which is the one
 *    input where the padding block is entirely padding.
 * 2. **Differential testing against `node:crypto`.** Random inputs, and — the part that
 *    actually matters — random *chunk boundaries*. A streaming hasher's bugs live in the
 *    partial-block bookkeeping, not in the compression function: get the round constants wrong
 *    and every vector fails immediately, but mishandle a chunk that ends 3 bytes into a block
 *    and the digest is correct for almost every file until it silently is not. The property
 *    test splits the same bytes every way it can think of and requires one answer.
 *
 * The equality asserted here is load-bearing beyond correctness. The importer hashes with
 * OpenSSL and the device hashes with this, and if the two ever disagreed, a photo imported from
 * Takeout would not deduplicate against the same photo on the phone — which is the premise of
 * Requirement 3.2.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { PortableSha256, Sha256FinalizedError, portableSha256 } from './sha256.ts';
import { nodeSha256 } from './nodeHash.ts';

const encoder = new TextEncoder();

function portableDigest(chunks: readonly Uint8Array[]): string {
  const hasher = new PortableSha256();
  for (const chunk of chunks) hasher.update(chunk);
  return hasher.digest();
}

function reference(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('published vectors', () => {
  // FIPS 180-4 appendix B, plus the empty input and the two lengths that straddle a block.
  const vectors: readonly [input: string, digest: string][] = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];

  for (const [input, digest] of vectors) {
    it(`hashes ${input.length} bytes of ASCII to the published digest`, () => {
      expect(portableDigest([encoder.encode(input)])).toBe(digest);
    });
  }

  it('hashes a million repeated characters', () => {
    // FIPS 180-4's third example. Fed in irregular chunks, because a million bytes is the one
    // vector long enough for a carry in the 64-bit length field to be worth exercising.
    const hasher = new PortableSha256();
    const chunk = encoder.encode('a'.repeat(1000));
    for (let index = 0; index < 1000; index += 1) hasher.update(chunk);
    expect(hasher.digest()).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('agreement with node:crypto', () => {
  it('matches for arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        expect(portableDigest([bytes])).toBe(reference(bytes));
      }),
      { numRuns: 300 },
    );
  });

  it('matches at every length across the padding boundary', () => {
    // 55/56 and 119/120 are where the length field no longer fits in the final block and a
    // second padding block appears. Enumerated rather than sampled, because there are only a
    // few and each is a distinct branch.
    for (let length = 0; length <= 130; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
      expect(portableDigest([bytes]), `length ${String(length)}`).toBe(reference(bytes));
    }
  });

  it('is independent of how the bytes are chunked', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 2048 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (bytes, rawCuts) => {
          // Arbitrary cut points, including duplicates and both ends, so zero-length chunks and
          // chunks that end mid-block are both covered.
          const cuts = [...new Set(rawCuts.map((cut) => cut % (bytes.length + 1)))].sort(
            (a, b) => a - b,
          );
          const bounds = [0, ...cuts, bytes.length];
          const chunks: Uint8Array[] = [];
          for (let index = 0; index < bounds.length - 1; index += 1) {
            chunks.push(bytes.subarray(bounds[index] ?? 0, bounds[index + 1] ?? 0));
          }
          expect(portableDigest(chunks)).toBe(reference(bytes));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('agrees with the Node hasher through the same Sha256 seam', () => {
    // The seam, not the algorithm: the importer wires `nodeSha256` and the app wires
    // `portableSha256`, and dedupe across the two only works if the seam hides no difference.
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 8 }), (chunks) => {
        const portable = portableSha256();
        const node = nodeSha256();
        for (const chunk of chunks) {
          portable.update(chunk);
          node.update(chunk);
        }
        expect(portable.digest()).toBe(node.digest());
      }),
      { numRuns: 200 },
    );
  });
});

describe('digest spelling', () => {
  it('is 64 lowercase hex characters, so keys.ts accepts it', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(portableDigest([bytes])).toMatch(/^[0-9a-f]{64}$/);
      }),
      { numRuns: 100 },
    );
  });
});

describe('single use', () => {
  it('refuses to be updated or finalized twice', () => {
    for (const hasher of [portableSha256(), nodeSha256()]) {
      hasher.update(encoder.encode('abc'));
      expect(hasher.digest()).toHaveLength(64);
      // A stale digest returned here would name bytes other than the ones about to be stored.
      expect(() => hasher.digest()).toThrow(Sha256FinalizedError);
      expect(() => hasher.update(encoder.encode('d'))).toThrow(Sha256FinalizedError);
    }
  });
});

describe('buffer handling', () => {
  it('does not retain the caller\u2019s buffer', () => {
    // A streaming caller reuses one read buffer. A hasher that kept a reference instead of
    // absorbing the bytes would hash whatever the buffer held at digest time.
    const scratch = new Uint8Array(64);
    const hasher = new PortableSha256();
    scratch.fill(1);
    hasher.update(scratch.subarray(0, 32));
    scratch.fill(2);
    hasher.update(scratch.subarray(0, 32));

    const expected = new Uint8Array(64);
    expected.fill(1, 0, 32);
    expected.fill(2, 32, 64);
    expect(hasher.digest()).toBe(reference(expected));
  });

  it('treats an empty update as a no-op', () => {
    expect(portableDigest([new Uint8Array(0), encoder.encode('abc'), new Uint8Array(0)])).toBe(
      reference(encoder.encode('abc')),
    );
  });
});
