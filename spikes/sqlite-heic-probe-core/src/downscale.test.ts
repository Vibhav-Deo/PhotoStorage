import { describe, expect, it } from 'vitest';

import {
  applyOrientation,
  checkDownscale,
  decodedBytes,
  fitLongEdge,
  orientationSwapsAxes,
  PREVIEW_LONG_EDGE,
  THUMB_LONG_EDGE,
} from './downscale.ts';

describe('fitLongEdge', () => {
  it('scales a 12 MP landscape original to the design thumbnail and preview sizes', () => {
    const source = { width: 4032, height: 3024 };
    expect(fitLongEdge(source, THUMB_LONG_EDGE)).toEqual({ width: 256, height: 192 });
    expect(fitLongEdge(source, PREVIEW_LONG_EDGE)).toEqual({ width: 2048, height: 1536 });
  });

  it('puts the constraint on the long edge regardless of orientation', () => {
    expect(fitLongEdge({ width: 3024, height: 4032 }, THUMB_LONG_EDGE)).toEqual({
      width: 192,
      height: 256,
    });
  });

  it('never upscales', () => {
    const small = { width: 180, height: 120 };
    expect(fitLongEdge(small, PREVIEW_LONG_EDGE)).toEqual(small);
    expect(fitLongEdge(small, THUMB_LONG_EDGE)).toEqual(small);
  });

  it('keeps an extreme panorama at least one pixel tall', () => {
    // A 12000x400 panorama at a 256 px long edge scales its short edge to 8.5;
    // a 20000x100 one scales to 1.28. Neither may round to zero, because a
    // zero-dimension bitmap throws on both platforms.
    expect(fitLongEdge({ width: 20000, height: 100 }, THUMB_LONG_EDGE).height).toBeGreaterThanOrEqual(1);
    expect(fitLongEdge({ width: 200000, height: 100 }, THUMB_LONG_EDGE).height).toBe(1);
  });

  it('rejects non-positive dimensions rather than returning nonsense', () => {
    expect(() => fitLongEdge({ width: 0, height: 100 }, 256)).toThrow();
  });
});

describe('orientation', () => {
  it('treats only the transposing orientations as axis-swapping', () => {
    expect([1, 2, 3, 4].map(orientationSwapsAxes)).toEqual([false, false, false, false]);
    expect([5, 6, 7, 8].map(orientationSwapsAxes)).toEqual([true, true, true, true]);
  });

  it('swaps stored dimensions for a portrait photo tagged orientation 6', () => {
    // The common iPhone case: sensor writes 4032x3024 and tags orientation 6.
    expect(applyOrientation({ width: 4032, height: 3024 }, 6)).toEqual({
      width: 3024,
      height: 4032,
    });
  });
});

describe('checkDownscale', () => {
  const source = { width: 4032, height: 3024 };

  it('accepts an exact result', () => {
    expect(checkDownscale(source, { width: 256, height: 192 }, THUMB_LONG_EDGE).ok).toBe(true);
  });

  it('tolerates one pixel, because the platforms round differently', () => {
    // expo-image-manipulator truncates on Android and goes through CGSize on iOS.
    expect(checkDownscale(source, { width: 256, height: 191 }, THUMB_LONG_EDGE).ok).toBe(true);
  });

  it('rejects a stretched result even when the long edge is right', () => {
    const check = checkDownscale(source, { width: 256, height: 256 }, THUMB_LONG_EDGE);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/aspect ratio changed/);
  });

  it('rejects an upscale', () => {
    const check = checkDownscale({ width: 180, height: 120 }, { width: 2048, height: 1365 }, PREVIEW_LONG_EDGE);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/upscaled/);
  });

  it('rejects a result that was never resized at all', () => {
    const check = checkDownscale(source, source, THUMB_LONG_EDGE);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/long edge/);
  });
});

describe('decodedBytes', () => {
  it('quantifies the memory the naive full-resolution decode path costs', () => {
    // These two numbers are the reason the probe measures a subsampled decode
    // rather than assuming a full decode is fine.
    expect(decodedBytes({ width: 4032, height: 3024 })).toBe(48_771_072);
    expect(decodedBytes({ width: 256, height: 192 })).toBe(196_608);
  });
});
