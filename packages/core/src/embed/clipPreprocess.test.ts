import { describe, expect, it } from 'vitest';
import {
  CLIP_INPUT_SIZE,
  CLIP_MEAN,
  CLIP_STD,
  clipNormalizeOptions,
  toClipPixelValues,
} from './clipPreprocess.ts';

describe('CLIP preprocessing convention', () => {
  it('applies CLIP channel normalization to a pure red image', () => {
    const pixels = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
    const rgb = new Uint8Array(pixels * 3); // all zeros — B and G are 0
    for (let i = 0; i < pixels; i++) rgb[i * 3] = 255; // pure red

    const tensor = toClipPixelValues(rgb);
    expect(tensor.length).toBe(3 * pixels);
    // R channel: (1.0 - 0.48145466) / 0.26862954 ≈ 1.9305
    expect(tensor[0]).toBeCloseTo(1.9305, 2);
    // G channel: (0.0 - 0.4578275) / 0.26130258 ≈ -1.7522
    expect(tensor[pixels]).toBeCloseTo(-1.7522, 2);
  });

  it('rejects wrongly-sized input', async () => {
    const { EmbeddingError } = await import('./embedding.ts');
    expect(() => toClipPixelValues(new Uint8Array(10))).toThrow(EmbeddingError);
  });

  it('produces CHW layout: each channel plane is contiguous', () => {
    const pixels = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
    const rgb = new Uint8Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      rgb[i * 3] = 10;
      rgb[i * 3 + 1] = 20;
      rgb[i * 3 + 2] = 30;
    }
    const tensor = toClipPixelValues(rgb);
    // Every sample within a channel plane must be identical.
    const rPlane = tensor.subarray(0, pixels);
    const gPlane = tensor.subarray(pixels, 2 * pixels);
    expect(rPlane[0]).toBe(rPlane[pixels - 1]);
    expect(gPlane[0]).toBeCloseTo((20 / 255 - (CLIP_MEAN[1] ?? 0)) / (CLIP_STD[1] ?? 1), 6);
  });

  describe('clipNormalizeOptions parity with the reference convention', () => {
    // The ExecuTorch preprocessor computes `pixel * alpha[c] + beta[c]`; the
    // importer computes `(pixel/255 - mean[c]) / std[c]`. These are the same
    // function only if the algebra holds for every pixel value, so assert it
    // exhaustively over 0..255 for all three channels. This is the test that
    // keeps on-device vectors comparable to importer vectors (Req 11.2, 11.5).
    it('matches the reference formula for every pixel value and channel', () => {
      const { alpha, beta } = clipNormalizeOptions();
      for (let c = 0; c < 3; c++) {
        const a = alpha[c] ?? Number.NaN;
        const b = beta[c] ?? Number.NaN;
        const mean = CLIP_MEAN[c] ?? 0;
        const std = CLIP_STD[c] ?? 1;
        for (let p = 0; p <= 255; p++) {
          const reference = (p / 255 - mean) / std;
          const f32Reference = Math.fround(reference);
          const f32Preprocessor = Math.fround(Math.fround(p * a) + b);
          // The two forms are algebraically identical; in float32 they may
          // differ by a couple of ulps (~2.4e-7 at the largest values here).
          // Any real divergence in the constants is orders of magnitude above
          // that, so the budget is ulp-scale, not percentage-scale.
          expect(Math.abs(f32Preprocessor - f32Reference)).toBeLessThanOrEqual(
            Math.abs(f32Reference) * 1e-5 + 1e-6,
          );
        }
      }
    });

    it('differs from the registry default, which omits channel normalization', () => {
      const { alpha } = clipNormalizeOptions();
      // react-native-executorch's CLIP_IMAGE_EMBEDDINGS_OPTS uses a single
      // alpha of 1/255 and beta of 0. If our per-channel alpha ever collapses
      // to that, the importer/device parity is silently broken.
      for (let c = 0; c < 3; c++) {
        expect(alpha[c]).not.toBeCloseTo(1 / 255, 6);
      }
    });
  });
});
