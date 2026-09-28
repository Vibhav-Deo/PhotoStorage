/**
 * Incremental SHA-256.
 *
 * Content addressing is the load-bearing decision in this design — every object key, the
 * dedupe boundary, and the verification that gates irreversible deletion all reduce to this
 * digest (Requirements 3.1, 3.3, 6.2). So the hasher is a seam with two implementations
 * rather than a call to whatever the platform happens to provide, because the two platforms
 * do not provide the same thing.
 *
 * ## Why this is not `crypto.subtle.digest`
 *
 * WebCrypto's digest is **one-shot**: it takes a complete `BufferSource` and returns a
 * promise. There is no `update`. Hashing a 4 GB video through it means holding 4 GB in
 * memory, which is not a thing a phone will do — and originals at hundreds of megabytes are
 * routine, not exceptional. `expo-crypto` mirrors the same one-shot shape, so it does not
 * help either.
 *
 * That leaves three ways to stream on the device, and this module takes the third:
 *
 * 1. **A native incremental hasher** (`react-native-quick-crypto` or a small custom module).
 *    Fastest, and adds a native dependency plus a prebuild config plugin to a package whose
 *    root export is supposed to bundle anywhere. It is a task 7.x decision, not a task 1.5 one.
 * 2. **Chunk and combine WebCrypto calls.** Impossible: SHA-256 is not composable, and
 *    hashing chunk digests produces a different value than hashing the bytes, which would
 *    silently break dedupe against the importer.
 * 3. **An incremental hasher in TypeScript**, fed bounded chunks read from the file. Portable
 *    to any JS runtime, no native dependency, and correct by construction against a reference
 *    implementation. That is {@link PortableSha256}.
 *
 * The cost is throughput: pure JS on Hermes runs at tens of MB/s against OpenSSL's hundreds.
 * That is acceptable here and nowhere else — the design already puts bulk migration on the
 * desktop importer, where {@link Sha256Factory} is wired to `node:crypto` instead (see
 * `@photo-archive/core/node-hash`), and device ingest hashes new captures in the background a
 * few at a time. When a native hasher does arrive it is a one-line factory swap, which is the
 * whole reason the seam exists.
 *
 * A vetted library such as `@noble/hashes` would also serve, and was not taken because
 * `packages/core` currently has no runtime dependencies and because a pinned dependency here
 * also lands in the app bundle and the notices machinery. Hand-written cryptographic code
 * earns its keep only if it is checked against a reference, so `sha256.test.ts` runs the
 * published FIPS-180-4 vectors and then a property test against `node:crypto` over random
 * inputs and random chunk boundaries.
 *
 * ## Digest spelling
 *
 * {@link Sha256.digest} returns **lowercase hex**, because `keys.ts` rejects anything else:
 * accepting both spellings would let the same bytes produce two object keys and therefore two
 * stored objects, which is precisely the duplication Requirement 3.2 exists to prevent.
 */

/**
 * An incremental SHA-256, narrowed to what streaming needs.
 *
 * Single-use: {@link digest} finalizes the state, and both methods throw afterwards. That
 * matches `node:crypto`'s behaviour rather than silently returning a stale digest, which in
 * this codebase would mean uploading bytes under a key that describes different bytes.
 */
export interface Sha256 {
  /** Absorbs `chunk`. Never retains it, so the caller may reuse the buffer. */
  update(chunk: Uint8Array): void;
  /** Finalizes and returns the digest as 64 lowercase hex characters. */
  digest(): string;
}

/** Produces a fresh {@link Sha256}. The seam that lets Node use OpenSSL and the app not. */
export type Sha256Factory = () => Sha256;

/** Characters in a hex SHA-256 digest. Mirrors the pattern `keys.ts` enforces. */
export const SHA256_HEX_LENGTH = 64;

/** Thrown when a hasher is used after {@link Sha256.digest}. Always a programming error. */
export class Sha256FinalizedError extends Error {
  override readonly name = 'Sha256FinalizedError';

  constructor(operation: string) {
    super(
      `cannot ${operation} a SHA-256 that has already been finalized — create a new hasher ` +
        'rather than reusing one, or the digest will describe bytes other than the ones stored',
    );
  }
}

const BLOCK_BYTES = 64;

/** FIPS 180-4 section 4.2.2 round constants. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** FIPS 180-4 section 5.3.3 initial hash value. */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/**
 * SHA-256 in TypeScript, per FIPS 180-4. Runs anywhere JavaScript does.
 *
 * Every `?? 0` below is a concession to `noUncheckedIndexedAccess`, which types typed-array
 * reads as possibly `undefined`. All indices are provably in range — the schedule is a
 * fixed 64-word buffer written before it is read, and blocks are always a full 64 bytes — so
 * the fallbacks are unreachable and the alternative spellings (assertions, a wider type) hide
 * more than they explain.
 *
 * Allocation is per instance, not per block: the message schedule and the partial-block
 * buffer are created once, so hashing a gigabyte allocates nothing after construction. That
 * matters on the device, where the alternative is a garbage collection pause per 64 bytes.
 */
export class PortableSha256 implements Sha256 {
  private readonly h = new Uint32Array(H0);
  private readonly w = new Uint32Array(64);
  private readonly partial = new Uint8Array(BLOCK_BYTES);
  private partialLength = 0;
  /**
   * Total bytes absorbed. A double, not a bigint: the exact-integer range reaches 8 PiB,
   * which is five orders of magnitude past the largest object this product will ever hash.
   */
  private byteLength = 0;
  private finalized = false;

  update(chunk: Uint8Array): void {
    if (this.finalized) throw new Sha256FinalizedError('update');
    if (chunk.byteLength === 0) return;
    this.byteLength += chunk.byteLength;

    let offset = 0;

    // Top up a partial block left by the previous call. Chunk boundaries are arbitrary —
    // a file stream splits wherever its buffer ends — so this path runs constantly and is
    // the one a naive implementation gets wrong.
    if (this.partialLength > 0) {
      const take = Math.min(BLOCK_BYTES - this.partialLength, chunk.byteLength);
      this.partial.set(chunk.subarray(0, take), this.partialLength);
      this.partialLength += take;
      offset = take;
      if (this.partialLength < BLOCK_BYTES) return;
      this.compress(this.partial, 0);
      this.partialLength = 0;
    }

    // Whole blocks straight out of the caller's buffer: no copy, no intermediate allocation.
    while (chunk.byteLength - offset >= BLOCK_BYTES) {
      this.compress(chunk, offset);
      offset += BLOCK_BYTES;
    }

    if (offset < chunk.byteLength) {
      this.partial.set(chunk.subarray(offset), 0);
      this.partialLength = chunk.byteLength - offset;
    }
  }

  digest(): string {
    if (this.finalized) throw new Sha256FinalizedError('finalize');
    this.finalized = true;

    // Padding: a 0x80 byte, zeros, and the 64-bit big-endian bit length in the last 8 bytes.
    // One block suffices unless the trailing partial block leaves under 9 bytes of room.
    const tail = new Uint8Array(
      this.partialLength <= BLOCK_BYTES - 9 ? BLOCK_BYTES : 2 * BLOCK_BYTES,
    );
    tail.set(this.partial.subarray(0, this.partialLength));
    tail[this.partialLength] = 0x80;

    const bitLength = this.byteLength * 8;
    const lengthAt = tail.length - 8;
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    tail[lengthAt] = (high >>> 24) & 0xff;
    tail[lengthAt + 1] = (high >>> 16) & 0xff;
    tail[lengthAt + 2] = (high >>> 8) & 0xff;
    tail[lengthAt + 3] = high & 0xff;
    tail[lengthAt + 4] = (low >>> 24) & 0xff;
    tail[lengthAt + 5] = (low >>> 16) & 0xff;
    tail[lengthAt + 6] = (low >>> 8) & 0xff;
    tail[lengthAt + 7] = low & 0xff;

    for (let offset = 0; offset < tail.length; offset += BLOCK_BYTES) {
      this.compress(tail, offset);
    }

    let hex = '';
    for (let index = 0; index < 8; index += 1) {
      hex += (this.h[index] ?? 0).toString(16).padStart(8, '0');
    }
    return hex;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w;

    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      w[index] =
        ((data[at] ?? 0) << 24) |
        ((data[at + 1] ?? 0) << 16) |
        ((data[at + 2] ?? 0) << 8) |
        (data[at + 3] ?? 0);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15] ?? 0;
      const y = w[index - 2] ?? 0;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[index] = ((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) | 0;
    }

    let a = this.h[0] ?? 0;
    let b = this.h[1] ?? 0;
    let c = this.h[2] ?? 0;
    let d = this.h[3] ?? 0;
    let e = this.h[4] ?? 0;
    let f = this.h[5] ?? 0;
    let g = this.h[6] ?? 0;
    let hh = this.h[7] ?? 0;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choice = (e & f) ^ (~e & g);
      const t1 = (hh + sigma1 + choice + (K[index] ?? 0) + (w[index] ?? 0)) | 0;
      const sigma0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (sigma0 + majority) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    // Stores into a Uint32Array truncate mod 2^32, which is the addition FIPS specifies.
    this.h[0] = (this.h[0] ?? 0) + a;
    this.h[1] = (this.h[1] ?? 0) + b;
    this.h[2] = (this.h[2] ?? 0) + c;
    this.h[3] = (this.h[3] ?? 0) + d;
    this.h[4] = (this.h[4] ?? 0) + e;
    this.h[5] = (this.h[5] ?? 0) + f;
    this.h[6] = (this.h[6] ?? 0) + g;
    this.h[7] = (this.h[7] ?? 0) + hh;
  }
}

/**
 * The default hasher: portable, no native dependency, no platform assumption.
 *
 * The importer overrides it with `nodeSha256` from `@photo-archive/core/node-hash`, which is
 * an order of magnitude faster and is what a 2 TB import needs. Nothing in the root export
 * may reference that, because the root export is what Metro bundles.
 */
export const portableSha256: Sha256Factory = () => new PortableSha256();
