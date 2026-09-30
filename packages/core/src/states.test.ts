/**
 * Persisted state values.
 *
 * Every number asserted here is written to the device database and to the change log, so a
 * change to one silently reinterprets rows that already exist — on this device and on every
 * other device that syncs. The literal maps below duplicate the definitions on purpose:
 * asserting against the module's own object would pass through any renumbering.
 *
 * Adding a member means adding it to a map here too. That is the point — the diff makes the
 * new persisted value visible in review.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  AssetKind,
  CapturedAtSource,
  DerivativeKind,
  HashState,
  IngestStage,
  JobState,
  LocalState,
  NO_DERIVATIVES,
  PURGE_REQUIRED_DERIVATIVES,
  Platform,
  RemoteState,
  TierState,
  VerifyMethod,
  addDerivatives,
  hasDerivatives,
  removeDerivatives,
} from './states.ts';

describe('persisted numeric values', () => {
  it('pins assets.kind', () => {
    expect(AssetKind).toEqual({ Image: 0, Video: 1, MotionComponent: 2 });
  });

  it('pins assets.captured_at_src', () => {
    expect(CapturedAtSource).toEqual({ Exif: 0, TakeoutJson: 1, FileMtime: 2, User: 3 });
  });

  it('pins assets.remote_state', () => {
    expect(RemoteState).toEqual({ LocalOnly: 0, Uploading: 1, Verified: 2, Failed: 3 });
  });

  it('pins assets.local_state', () => {
    expect(LocalState).toEqual({ Absent: 0, Present: 1, PurgeEligible: 2, Purged: 3 });
  });

  it('pins assets.tier_state', () => {
    expect(TierState).toEqual({ Instant: 0, Cold: 1, Restoring: 2 });
  });

  it('pins local_assets.platform', () => {
    expect(Platform).toEqual({ Ios: 0, Android: 1 });
  });

  it('pins local_assets.hash_state', () => {
    expect(HashState).toEqual({ Pending: 0, Done: 1, Unreadable: 2 });
  });

  it('pins purge_audit.verify_method, with the fallback method at 0', () => {
    expect(VerifyMethod).toEqual({
      FullRedownloadSha256: 0,
      S3ChecksumSha256: 1,
      S3CompositeSha256: 2,
    });
  });

  it('pins jobs.state, two of whose values are written into idx_jobs_runnable', () => {
    expect(JobState).toEqual({ Pending: 0, Running: 1, Done: 2, Failed: 3, Dead: 4 });
  });

  it('pins jobs.kind', () => {
    expect(IngestStage).toEqual({
      Scan: 0,
      Hash: 1,
      ExtractMeta: 2,
      Derive: 3,
      Embed: 4,
      Ocr: 5,
      UploadOriginal: 6,
      UploadDerivatives: 7,
      Verify: 8,
      Transcode: 9,
      ManifestAppend: 10,
      SyncPush: 11,
    });
  });

  it('pins assets.derivative_mask bits', () => {
    expect(DerivativeKind).toEqual({ Thumbhash: 1, Thumb: 2, Preview: 4, Video720p: 8 });
  });

  it('assigns no value twice within a state type', () => {
    const types = {
      AssetKind,
      CapturedAtSource,
      RemoteState,
      LocalState,
      TierState,
      Platform,
      HashState,
      VerifyMethod,
      JobState,
      IngestStage,
      DerivativeKind,
    };
    for (const [name, members] of Object.entries(types)) {
      const values = Object.values(members);
      expect(new Set(values).size, `${name} has a duplicated value`).toBe(values.length);
    }
  });
});

describe('derivative bitfield', () => {
  const kinds = Object.values(DerivativeKind);
  const maskArb = fc.integer({ min: 0, max: 15 });

  it('assigns each kind a distinct single bit', () => {
    for (const kind of kinds) {
      expect(kind & (kind - 1), `${String(kind)} is not a power of two`).toBe(0);
    }
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('defaults to an empty mask holding nothing', () => {
    expect(NO_DERIVATIVES).toBe(0);
    for (const kind of kinds) {
      expect(hasDerivatives(NO_DERIVATIVES, kind)).toBe(false);
    }
  });

  it('gates purge eligibility on the thumbnail and the preview only', () => {
    expect(PURGE_REQUIRED_DERIVATIVES).toBe(DerivativeKind.Thumb | DerivativeKind.Preview);

    const thumbOnly = addDerivatives(NO_DERIVATIVES, DerivativeKind.Thumb);
    expect(hasDerivatives(thumbOnly, PURGE_REQUIRED_DERIVATIVES)).toBe(false);

    const both = addDerivatives(thumbOnly, DerivativeKind.Preview);
    expect(hasDerivatives(both, PURGE_REQUIRED_DERIVATIVES)).toBe(true);

    // A video with a thumbnail and preview still renders a complete timeline, so the
    // transcode is not required — it is regenerable from the stored original.
    expect(hasDerivatives(both, DerivativeKind.Video720p)).toBe(false);

    // Losing a required derivative must walk the asset back out of eligibility.
    expect(
      hasDerivatives(removeDerivatives(both, DerivativeKind.Preview), PURGE_REQUIRED_DERIVATIVES),
    ).toBe(false);
  });

  it('reads back every bit it is given, and no other', () => {
    fc.assert(
      fc.property(maskArb, (mask) => {
        for (const kind of kinds) {
          expect(hasDerivatives(addDerivatives(mask, kind), kind)).toBe(true);
          expect(hasDerivatives(removeDerivatives(mask, kind), kind)).toBe(false);
        }
      }),
    );
  });

  it('adds and removes without disturbing unrelated bits', () => {
    fc.assert(
      fc.property(maskArb, fc.constantFrom(...kinds), (mask, kind) => {
        expect(removeDerivatives(addDerivatives(mask, kind), kind)).toBe(
          removeDerivatives(mask, kind),
        );
        for (const other of kinds) {
          if (other === kind) continue;
          expect(hasDerivatives(addDerivatives(mask, kind), other)).toBe(
            hasDerivatives(mask, other),
          );
          expect(hasDerivatives(removeDerivatives(mask, kind), other)).toBe(
            hasDerivatives(mask, other),
          );
        }
      }),
    );
  });

  it('is idempotent, so a re-confirmed derivative changes nothing', () => {
    fc.assert(
      fc.property(maskArb, maskArb, (mask, kinds_) => {
        expect(addDerivatives(addDerivatives(mask, kinds_), kinds_)).toBe(
          addDerivatives(mask, kinds_),
        );
        expect(removeDerivatives(removeDerivatives(mask, kinds_), kinds_)).toBe(
          removeDerivatives(mask, kinds_),
        );
      }),
    );
  });

  it('treats a multi-bit mask as all-or-nothing', () => {
    fc.assert(
      fc.property(maskArb, maskArb, (mask, required) => {
        const expected = Object.values(DerivativeKind)
          .filter((kind) => (required & kind) !== 0)
          .every((kind) => (mask & kind) !== 0);
        expect(hasDerivatives(mask, required)).toBe(expected);
      }),
    );
  });
});
