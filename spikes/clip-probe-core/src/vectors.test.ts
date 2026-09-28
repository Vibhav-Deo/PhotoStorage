import { describe, expect, it } from 'vitest';

import {
  cosine,
  DegenerateVectorError,
  l2Normalize,
  mean,
  rankDescending,
} from './vectors.ts';

describe('l2Normalize', () => {
  // Tolerances here are float32-realistic (~1e-7). The output is a
  // Float32Array, matching what the runtimes actually hand back, so asserting
  // float64 precision would be testing a guarantee we neither have nor need.
  it('returns a unit-length vector', () => {
    const out = l2Normalize([3, 4]);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves an already-normalized vector unchanged', () => {
    const out = l2Normalize([1, 0, 0]);
    expect([...out]).toEqual([1, 0, 0]);
  });

  it('rejects a zero vector rather than producing NaN', () => {
    // A zero embedding is what an unloaded or misconfigured model returns.
    // Silently normalizing it to NaN would surface as a ranking failure later,
    // pointing the investigation at the wrong place.
    expect(() => l2Normalize([0, 0, 0])).toThrow(DegenerateVectorError);
  });

  it('rejects non-finite values', () => {
    expect(() => l2Normalize([1, Number.NaN])).toThrow(DegenerateVectorError);
    expect(() => l2Normalize([1, Number.POSITIVE_INFINITY])).toThrow(
      DegenerateVectorError
    );
  });
});

describe('cosine', () => {
  it('is 1 for identical directions regardless of magnitude', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('is -1 for opposed vectors', () => {
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1, 6);
  });

  it('stays within [-1, 1] despite floating-point drift', () => {
    const v = new Float32Array(512).fill(0.04419417);
    expect(cosine(v, v)).toBeLessThanOrEqual(1);
    expect(cosine(v, v)).toBeGreaterThanOrEqual(-1);
  });

  it('refuses to compare different dimensions', () => {
    // This is the shape a wrong-model bug takes: a 384-dim sentence-transformer
    // vector compared against a 512-dim CLIP vector.
    expect(() => cosine(new Float32Array(384), new Float32Array(512))).toThrow(
      /dimension mismatch/
    );
  });
});

describe('rankDescending', () => {
  it('orders indices by score, highest first', () => {
    expect(rankDescending([0.1, 0.9, 0.5])).toEqual([1, 2, 0]);
  });

  it('breaks ties by original order so results are deterministic', () => {
    expect(rankDescending([0.5, 0.5, 0.5])).toEqual([0, 1, 2]);
  });

  it('handles a single score', () => {
    expect(rankDescending([0.42])).toEqual([0]);
  });
});

describe('mean', () => {
  it('averages', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('is NaN for an empty list rather than 0', () => {
    // 0 would read as "no separation"; NaN reads as "no data".
    expect(mean([])).toBeNaN();
  });
});
