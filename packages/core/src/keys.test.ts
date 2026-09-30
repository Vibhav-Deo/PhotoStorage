/**
 * Key stability.
 *
 * The golden table below is the authoritative record of the object layout. Its expectations
 * are written as whole literal strings rather than composed from the inputs, because a test
 * that rebuilds the key the same way the implementation does would pass through any change
 * to the composition — which is the failure this suite exists to catch.
 *
 * If a change here fails, the fix is almost never to update the expectation. Every object
 * already stored by every user lives at the old key, and moving derivation moves nothing
 * with it: uploads keep succeeding while previously stored bytes become unreachable.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  KeyDerivationError,
  MAX_VECTOR_SHARD,
  isContentHash,
  manifestKey,
  origKey,
  previewKey,
  thumbKey,
  vecKey,
  videoKey,
} from './keys.ts';

/** A realistic Cognito identity id: region, colon, uuid. */
const PREFIX = 'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10';
const HASH = 'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';
const OTHER_HASH = '00ffeeddccbbaa998877665544332211908f7e6d5c4b3a2918076b4e2d9c1f3a';
const MODEL_ID = 'clip-vit-b32/pca256-v1';

const hashArb = fc
  .string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 64, maxLength: 64 })
  .filter(isContentHash);

const prefixArb = fc.constantFrom(
  PREFIX,
  'us-west-2:00000000-0000-4000-8000-000000000000',
  'single-user',
  'tenants/acme',
);

describe('key derivation — pinned output', () => {
  it('derives the exact keys the layout specifies', () => {
    expect(origKey(PREFIX, HASH)).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/orig/' +
        'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
    );
    expect(thumbKey(PREFIX, HASH)).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/th/' +
        'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00.webp',
    );
    expect(previewKey(PREFIX, HASH)).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/pv/' +
        'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00.webp',
    );
    expect(videoKey(PREFIX, HASH)).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/vid/' +
        'a3f1c9d2e4b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00/720p.mp4',
    );
    expect(vecKey(PREFIX, MODEL_ID, 0)).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/vec/clip-vit-b32/pca256-v1/00000.bin',
    );
    expect(manifestKey(PREFIX, '2019-07')).toBe(
      'us-east-1:2f4e6a1c-0c3d-4c8f-9a1b-7d5e3f2a9b10/manifest/2019-07.ndjson',
    );
  });

  it('zero-pads vector shards to five digits so a listing is in slot order', () => {
    expect(vecKey('u', MODEL_ID, 7)).toBe('u/vec/clip-vit-b32/pca256-v1/00007.bin');
    expect(vecKey('u', MODEL_ID, 42)).toBe('u/vec/clip-vit-b32/pca256-v1/00042.bin');
    expect(vecKey('u', MODEL_ID, 1234)).toBe('u/vec/clip-vit-b32/pca256-v1/01234.bin');
    expect(vecKey('u', MODEL_ID, MAX_VECTOR_SHARD)).toBe('u/vec/clip-vit-b32/pca256-v1/99999.bin');

    const listed = [0, 1, 9, 10, 99, 100, 9999, 10000].map((shard) => vecKey('u', MODEL_ID, shard));
    expect([...listed].sort()).toEqual(listed);
  });

  it('keeps a model id with a path separator intact, since ids carry one', () => {
    expect(vecKey('u', 'clip-vit-b32/pca256-v2', 3)).toBe('u/vec/clip-vit-b32/pca256-v2/00003.bin');
    expect(vecKey('u', 'flat-model-id', 3)).toBe('u/vec/flat-model-id/00003.bin');
  });

  it('pins the manifest partition to the capture month', () => {
    expect(manifestKey('u', '2019-01')).toBe('u/manifest/2019-01.ndjson');
    expect(manifestKey('u', '2019-12')).toBe('u/manifest/2019-12.ndjson');
    expect(manifestKey('u', '1999-06')).toBe('u/manifest/1999-06.ndjson');
  });
});

describe('key derivation — structural properties', () => {
  it('is pure: repeated calls on the same input give the same key', () => {
    fc.assert(
      fc.property(prefixArb, hashArb, (prefix, hash) => {
        expect(origKey(prefix, hash)).toBe(origKey(prefix, hash));
        expect(thumbKey(prefix, hash)).toBe(thumbKey(prefix, hash));
        expect(previewKey(prefix, hash)).toBe(previewKey(prefix, hash));
        expect(videoKey(prefix, hash)).toBe(videoKey(prefix, hash));
      }),
    );
  });

  it('confines every key to the tenant prefix', () => {
    fc.assert(
      fc.property(
        prefixArb,
        hashArb,
        fc.integer({ min: 0, max: MAX_VECTOR_SHARD }),
        (prefix, hash, shard) => {
          const keys = [
            origKey(prefix, hash),
            thumbKey(prefix, hash),
            previewKey(prefix, hash),
            videoKey(prefix, hash),
            vecKey(prefix, MODEL_ID, shard),
            manifestKey(prefix, '2019-07'),
          ];
          for (const key of keys) {
            expect(key.startsWith(`${prefix}/`)).toBe(true);
            expect(key).not.toContain('//');
            expect(key).not.toContain('..');
          }
        },
      ),
    );
  });

  it('separates the derivative kinds, so no two share a key', () => {
    fc.assert(
      fc.property(prefixArb, hashArb, (prefix, hash) => {
        const keys = [
          origKey(prefix, hash),
          thumbKey(prefix, hash),
          previewKey(prefix, hash),
          videoKey(prefix, hash),
          vecKey(prefix, MODEL_ID, 0),
          manifestKey(prefix, '2019-07'),
        ];
        expect(new Set(keys).size).toBe(keys.length);
      }),
    );
  });

  it('is injective in the hash: distinct content never collides', () => {
    fc.assert(
      fc.property(prefixArb, hashArb, hashArb, (prefix, a, b) => {
        fc.pre(a !== b);
        expect(origKey(prefix, a)).not.toBe(origKey(prefix, b));
        expect(thumbKey(prefix, a)).not.toBe(thumbKey(prefix, b));
        expect(previewKey(prefix, a)).not.toBe(previewKey(prefix, b));
        expect(videoKey(prefix, a)).not.toBe(videoKey(prefix, b));
      }),
    );
  });

  it('is injective in the prefix: one tenant never derives into another', () => {
    fc.assert(
      fc.property(prefixArb, prefixArb, hashArb, (a, b, hash) => {
        fc.pre(a !== b);
        expect(origKey(a, hash)).not.toBe(origKey(b, hash));
      }),
    );
  });
});

describe('isContentHash', () => {
  it('accepts 64 lowercase hex characters', () => {
    expect(isContentHash(HASH)).toBe(true);
    expect(isContentHash(OTHER_HASH)).toBe(true);
    expect(isContentHash('0'.repeat(64))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isContentHash(HASH.toUpperCase())).toBe(false);
    expect(isContentHash(HASH.slice(0, 63))).toBe(false);
    expect(isContentHash(`${HASH}0`)).toBe(false);
    expect(isContentHash('')).toBe(false);
    expect(isContentHash(`${HASH.slice(0, 63)}g`)).toBe(false);
    expect(isContentHash(`${HASH.slice(0, 63)}\n`)).toBe(false);
  });

  it('accepts every hex digest a generator can produce, and rejects near misses', () => {
    fc.assert(
      fc.property(hashArb, (hash) => {
        expect(isContentHash(hash)).toBe(true);
        expect(isContentHash(hash.slice(1))).toBe(false);
        expect(isContentHash(` ${hash}`)).toBe(false);
      }),
    );
  });
});

describe('malformed input', () => {
  const hashTakers = [
    ['origKey', origKey],
    ['thumbKey', thumbKey],
    ['previewKey', previewKey],
    ['videoKey', videoKey],
  ] as const;

  for (const [name, derive] of hashTakers) {
    describe(name, () => {
      it('rejects a hash that is not 64 hex characters', () => {
        expect(() => derive(PREFIX, '')).toThrow(KeyDerivationError);
        expect(() => derive(PREFIX, HASH.slice(0, 63))).toThrow(KeyDerivationError);
        expect(() => derive(PREFIX, `${HASH}00`)).toThrow(KeyDerivationError);
        expect(() => derive(PREFIX, 'not-a-hash')).toThrow(KeyDerivationError);
        expect(() => derive(PREFIX, `${HASH.slice(0, 63)}z`)).toThrow(KeyDerivationError);
      });

      it('rejects an uppercase hash instead of folding it, so one asset cannot get two keys', () => {
        expect(() => derive(PREFIX, HASH.toUpperCase())).toThrow(/lowercase/);
      });

      it('rejects a hash carrying path or whitespace characters', () => {
        expect(() => derive(PREFIX, `${HASH.slice(0, 32)}/${HASH.slice(33)}`)).toThrow(
          KeyDerivationError,
        );
        expect(() => derive(PREFIX, `${HASH.slice(0, 63)} `)).toThrow(KeyDerivationError);
      });

      it('rejects a prefix that would escape the tenant partition', () => {
        expect(() => derive('', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('/leading', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('trailing/', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('double//slash', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('..', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('tenant/../other', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('tenant/./same', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('has space', HASH)).toThrow(KeyDerivationError);
        expect(() => derive('has\nnewline', HASH)).toThrow(KeyDerivationError);
      });
    });
  }

  describe('vecKey', () => {
    it('rejects a malformed model id', () => {
      expect(() => vecKey(PREFIX, '', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, '/leading', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, 'trailing/', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, 'a//b', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, '../escape', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, 'model id', 0)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, 'model:id', 0)).toThrow(KeyDerivationError);
    });

    it('rejects a shard that is not a whole number in range', () => {
      expect(() => vecKey(PREFIX, MODEL_ID, -1)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, MODEL_ID, 1.5)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, MODEL_ID, Number.NaN)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, MODEL_ID, Number.POSITIVE_INFINITY)).toThrow(KeyDerivationError);
      expect(() => vecKey(PREFIX, MODEL_ID, MAX_VECTOR_SHARD + 1)).toThrow(KeyDerivationError);
    });
  });

  describe('manifestKey', () => {
    it('rejects anything that is not a yyyy-mm month', () => {
      expect(() => manifestKey(PREFIX, '')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019-7')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019-00')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019-13')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019-07-04')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '2019/07')).toThrow(KeyDerivationError);
      expect(() => manifestKey(PREFIX, '../07')).toThrow(KeyDerivationError);
    });

    it('accepts every month of a year', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 12 }), (month) => {
          const padded = String(month).padStart(2, '0');
          expect(manifestKey('u', `2019-${padded}`)).toBe(`u/manifest/2019-${padded}.ndjson`);
        }),
      );
    });
  });

  it('reports failures as KeyDerivationError, naming the offending value', () => {
    try {
      origKey(PREFIX, 'nope');
      expect.unreachable('expected a KeyDerivationError');
    } catch (error) {
      expect(error).toBeInstanceOf(KeyDerivationError);
      expect((error as KeyDerivationError).name).toBe('KeyDerivationError');
      expect((error as KeyDerivationError).message).toContain('nope');
    }
  });
});
