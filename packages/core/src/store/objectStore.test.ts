/**
 * The pure parts of the `ObjectStore` contract: key validation, multipart sizing, and the
 * verification-method fallback.
 *
 * These get their own suite rather than living in the conformance run because they are decided
 * once for every implementation. {@link planMultipart} in particular has to be a function of the
 * byte size alone: an uploader and, later, a verifier derive the same part boundaries without
 * talking to each other, and a composite checksum computed over different boundaries is simply
 * wrong. The properties below are what "the same boundaries" means.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { VerifyMethod } from '../states.ts';
import {
  InvalidObjectKeyError,
  MAX_PART_COUNT,
  MIN_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  MultipartError,
  assertObjectKey,
  isValidObjectKey,
  partByteRange,
  planMultipart,
  shouldUseMultipart,
  verifyMethodFor,
} from './objectStore.ts';
import type { ObjectStoreCapabilities } from './objectStore.ts';

const MIB = 1024 * 1024;

describe('multipart constants', () => {
  it('pins the sizes S3 and the design agree on', () => {
    // The threshold is 8 MiB per tasks 3.5 and 7.4; the floor is S3's own 5 MiB. Changing the
    // floor would make previously uploaded multipart originals unverifiable by composite,
    // because the composite depends on the part boundaries.
    expect(MULTIPART_THRESHOLD_BYTES).toBe(8 * MIB);
    expect(MIN_PART_SIZE_BYTES).toBe(5 * MIB);
    expect(MAX_PART_COUNT).toBe(10_000);
  });

  it('uses multipart strictly above the threshold', () => {
    expect(shouldUseMultipart(0)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES - 1)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_THRESHOLD_BYTES + 1)).toBe(true);
  });
});

describe('planMultipart', () => {
  it('takes the smallest legal part size while the count allows it', () => {
    expect(planMultipart(1)).toEqual({ partSize: 5 * MIB, partCount: 1, lastPartSize: 1 });
    expect(planMultipart(5 * MIB)).toEqual({
      partSize: 5 * MIB,
      partCount: 1,
      lastPartSize: 5 * MIB,
    });
    expect(planMultipart(5 * MIB + 1)).toEqual({
      partSize: 5 * MIB,
      partCount: 2,
      lastPartSize: 1,
    });
    expect(planMultipart(8 * MIB + 1)).toEqual({
      partSize: 5 * MIB,
      partCount: 2,
      lastPartSize: 3 * MIB + 1,
    });
    expect(planMultipart(50 * MIB)).toEqual({
      partSize: 5 * MIB,
      partCount: 10,
      lastPartSize: 5 * MIB,
    });
  });

  it('grows the part size only once the count would exceed the ceiling', () => {
    // 10 000 parts of 5 MiB covers just under 49 GiB, so that is where the size has to move.
    const atCeiling = MAX_PART_COUNT * 5 * MIB;
    expect(planMultipart(atCeiling)).toEqual({
      partSize: 5 * MIB,
      partCount: MAX_PART_COUNT,
      lastPartSize: 5 * MIB,
    });

    const justOver = planMultipart(atCeiling + 1);
    expect(justOver.partSize).toBeGreaterThan(5 * MIB);
    expect(justOver.partCount).toBeLessThanOrEqual(MAX_PART_COUNT);
  });

  it('keeps part sizes on a whole-mebibyte grid, so two implementations cannot disagree', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 * 1024 * 1024 * 1024 }), (byteSize) => {
        expect(planMultipart(byteSize).partSize % MIB).toBe(0);
      }),
    );
  });

  it('plans S3\u2019s largest object without exceeding the part ceiling', () => {
    const fiveTib = 5 * 1024 ** 4;
    const plan = planMultipart(fiveTib);
    expect(plan.partCount).toBeLessThanOrEqual(MAX_PART_COUNT);
    expect(plan.partSize * (plan.partCount - 1) + plan.lastPartSize).toBe(fiveTib);
  });

  it('rejects a size no multipart upload can express', () => {
    expect(() => planMultipart(0)).toThrow(MultipartError);
    expect(() => planMultipart(-1)).toThrow(MultipartError);
    expect(() => planMultipart(1.5)).toThrow(MultipartError);
    expect(() => planMultipart(Number.NaN)).toThrow(MultipartError);
    expect(() => planMultipart(Number.POSITIVE_INFINITY)).toThrow(MultipartError);
  });

  it('rejects limits that are not positive integers', () => {
    expect(() => planMultipart(1024, { minPartSize: 0 })).toThrow(MultipartError);
    expect(() => planMultipart(1024, { minPartSize: 1.5 })).toThrow(MultipartError);
    expect(() => planMultipart(1024, { maxPartCount: 0 })).toThrow(MultipartError);
  });

  it('stays inside a tight part ceiling by growing the part instead', () => {
    // The part count is the hard limit a provider rejects an upload over, so it is the part
    // size that has to move. There is no size within S3's own object limit where this fails.
    const plan = planMultipart(1_000_000, { minPartSize: 1024, maxPartCount: 2 });
    expect(plan.partCount).toBeLessThanOrEqual(2);
    expect(plan.partSize).toBeGreaterThanOrEqual(500_000);
    expect(plan.partSize * (plan.partCount - 1) + plan.lastPartSize).toBe(1_000_000);
  });

  it('honours a lowered minimum, so a test need not move 5 MiB to exercise part rules', () => {
    expect(planMultipart(200_000, { minPartSize: 65_536 })).toEqual({
      partSize: 65_536,
      partCount: 4,
      lastPartSize: 3392,
    });
  });

  const planArb = fc
    .record({
      byteSize: fc.integer({ min: 1, max: 200 * 1024 * 1024 * 1024 }),
      minPartSize: fc.constantFrom(1024, 65_536, MIN_PART_SIZE_BYTES, 16 * MIB),
    })
    .map((input) => ({ ...input, plan: planMultipart(input.byteSize, input) }));

  it('covers the object exactly', () => {
    fc.assert(
      fc.property(planArb, ({ byteSize, plan }) => {
        expect(plan.partSize * (plan.partCount - 1) + plan.lastPartSize).toBe(byteSize);
      }),
    );
  });

  it('never plans a part below the minimum, nor an empty or oversized last part', () => {
    fc.assert(
      fc.property(planArb, ({ minPartSize, plan }) => {
        expect(plan.partSize).toBeGreaterThanOrEqual(minPartSize);
        expect(plan.partCount).toBeGreaterThanOrEqual(1);
        expect(plan.partCount).toBeLessThanOrEqual(MAX_PART_COUNT);
        expect(plan.lastPartSize).toBeGreaterThan(0);
        expect(plan.lastPartSize).toBeLessThanOrEqual(plan.partSize);
        if (plan.partCount > 1) {
          // Every part but the last must clear the minimum, which is the whole rule S3 enforces
          // at CompleteMultipartUpload.
          expect(plan.partSize).toBeGreaterThanOrEqual(minPartSize);
        }
      }),
    );
  });

  it('is a pure function of the size and the limits', () => {
    fc.assert(
      fc.property(planArb, ({ byteSize, minPartSize, plan }) => {
        expect(planMultipart(byteSize, { minPartSize })).toEqual(plan);
      }),
    );
  });
});

describe('partByteRange', () => {
  it('tiles the object with no gap and no overlap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 400 * 1024 * 1024 }),
        fc.constantFrom(65_536, MIN_PART_SIZE_BYTES),
        (byteSize, minPartSize) => {
          const plan = planMultipart(byteSize, { minPartSize });
          // Walked without asserting per part: the interesting facts are that each range starts
          // where the previous one ended and that the last lands on byteSize - 1, and collapsing
          // to those keeps the property cheap enough to run over large sizes.
          let cursor = 0;
          let contiguous = true;
          for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
            const range = partByteRange(plan, partNumber);
            if (range.start !== cursor || range.end < range.start) contiguous = false;
            cursor = range.end + 1;
          }
          expect(contiguous).toBe(true);
          // Inclusive ends everywhere, so the final part must land exactly on byteSize - 1.
          expect(cursor).toBe(byteSize);
        },
      ),
    );
  });

  it('gives inclusive ends', () => {
    const plan = planMultipart(12 * MIB);
    expect(partByteRange(plan, 1)).toEqual({ start: 0, end: 5 * MIB - 1 });
    expect(partByteRange(plan, 2)).toEqual({ start: 5 * MIB, end: 10 * MIB - 1 });
    expect(partByteRange(plan, 3)).toEqual({ start: 10 * MIB, end: 12 * MIB - 1 });
  });

  it('rejects a part number outside the plan', () => {
    const plan = planMultipart(12 * MIB);
    expect(() => partByteRange(plan, 0)).toThrow(MultipartError);
    expect(() => partByteRange(plan, 4)).toThrow(MultipartError);
    expect(() => partByteRange(plan, 1.5)).toThrow(MultipartError);
  });
});

describe('object keys', () => {
  it('accepts the keys the layout derives', () => {
    const prefix = 'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10';
    const hash = 'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
    for (const key of [
      `${prefix}/orig/${hash}`,
      `${prefix}/th/${hash}.webp`,
      `${prefix}/pv/${hash}.webp`,
      `${prefix}/vid/${hash}/720p.mp4`,
      `${prefix}/vec/clip-vit-b32/pca256-v1/00000.bin`,
      `${prefix}/manifest/2019-07.ndjson`,
    ]) {
      expect(isValidObjectKey(key)).toBe(true);
      expect(() => assertObjectKey(key)).not.toThrow();
    }
  });

  it('rejects anything that would not read back from where it was written', () => {
    for (const key of [
      '',
      '/leading',
      'trailing/',
      'double//slash',
      '.',
      '..',
      'a/../b',
      'a/./b',
      'has space',
      'has\nnewline',
      'has\0null',
      'back\\slash',
      'a'.repeat(1025),
    ]) {
      expect(isValidObjectKey(key)).toBe(false);
      expect(() => assertObjectKey(key)).toThrow(InvalidObjectKeyError);
    }
  });
});

describe('verifyMethodFor', () => {
  const caps = (
    additionalChecksumSha256: boolean,
    compositeChecksumSha256: boolean,
  ): ObjectStoreCapabilities => ({
    name: 'test',
    additionalChecksumSha256,
    compositeChecksumSha256,
    minPartSize: MIN_PART_SIZE_BYTES,
    maxPartCount: MAX_PART_COUNT,
  });

  it('prefers the free checksum methods when the provider supports them', () => {
    expect(verifyMethodFor(caps(true, true), null)).toBe(VerifyMethod.S3ChecksumSha256);
    expect(verifyMethodFor(caps(true, true), 1)).toBe(VerifyMethod.S3ChecksumSha256);
    expect(verifyMethodFor(caps(true, true), 4)).toBe(VerifyMethod.S3CompositeSha256);
  });

  it('falls back to full re-download when the provider reports no checksum support', () => {
    // Requirement 6.3, and the reason LocalFsObjectStore reports no support: the fallback is
    // then exercised by every Phase 2 run rather than first tried in production.
    expect(verifyMethodFor(caps(false, false), null)).toBe(VerifyMethod.FullRedownloadSha256);
    expect(verifyMethodFor(caps(false, false), 7)).toBe(VerifyMethod.FullRedownloadSha256);
  });

  it('falls back for multipart alone when only the composite is unsupported', () => {
    expect(verifyMethodFor(caps(true, false), null)).toBe(VerifyMethod.S3ChecksumSha256);
    expect(verifyMethodFor(caps(true, false), 3)).toBe(VerifyMethod.FullRedownloadSha256);
  });

  it('never returns a checksum method the capabilities do not support', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.integer({ min: 1, max: MAX_PART_COUNT }), { nil: null }),
        (additional, composite, partCount) => {
          const method = verifyMethodFor(caps(additional, composite), partCount);
          if (method === VerifyMethod.S3ChecksumSha256) expect(additional).toBe(true);
          if (method === VerifyMethod.S3CompositeSha256) expect(composite).toBe(true);
          if (!additional && !composite) expect(method).toBe(VerifyMethod.FullRedownloadSha256);
        },
      ),
    );
  });
});
