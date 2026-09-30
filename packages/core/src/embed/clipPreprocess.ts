/**
 * CLIP ViT-B/32 preprocessing convention, shared by the importer and the app.
 *
 * Spike 0.1 found that `react-native-executorch`'s default CLIP image
 * configuration resizes by bilinear stretch and scales by a plain divide-by-255
 * with *no* channel normalization, costing ~21% of the retrieval margin. The
 * importer's ONNX path applies the full CLIP convention. Vectors from the two
 * paths are comparable only if the conventions match exactly, so the convention
 * lives here — one definition, consumed by both sides (Req 11.2, 11.5, task 6.1).
 *
 * The convention:
 * - Resize to 224×224 with bilinear stretch (no aspect-preserving crop).
 * - CLIP channel normalization: mean=[0.48145466, 0.4578275, 0.40821073],
 *   std=[0.26862954, 0.26130258, 0.27577711].
 * - Layout: CHW float32, shape [1, 3, 224, 224].
 */

import { EmbeddingError } from './embedding.ts';

export const CLIP_INPUT_SIZE = 224;

/** CLIP ViT-B/32 channel normalization constants from preprocessor_config.json. */
export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

/**
 * Converts a raw RGB Uint8Array (HWC, 224×224×3) to a CHW float32 tensor
 * with CLIP channel normalization. This is the reference definition of the
 * convention; the importer feeds its output to the ONNX session directly.
 */
export function toClipPixelValues(rgb: Uint8Array): Float32Array {
  const pixels = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
  if (rgb.length !== pixels * 3) {
    throw new EmbeddingError(
      `Expected ${String(pixels * 3)} bytes for 224×224 RGB, got ${String(rgb.length)}`,
    );
  }
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      const scaled = (rgb[i * 3 + c] ?? 0) / 255;
      out[c * pixels + i] = (scaled - (CLIP_MEAN[c] ?? 0)) / (CLIP_STD[c] ?? 1);
    }
  }
  return out;
}

/**
 * Per-channel `alpha`/`beta` coefficients expressing the same normalization in
 * the `pixel * alpha + beta` form consumed by the ExecuTorch image
 * preprocessor's `NormalizeOptions`.
 *
 * The reference convention computes `(pixel/255 - mean) / std`, which is
 * `pixel * (1 / (255 * std)) + (-mean / std)`. The app passes these arrays
 * instead of the registry default (`alpha: 1/255, beta: 0`) so that on-device
 * preprocessing matches the importer's byte for byte.
 */
export function clipNormalizeOptions(): {
  readonly alpha: readonly number[];
  readonly beta: readonly number[];
} {
  const alpha: number[] = [];
  const beta: number[] = [];
  for (let c = 0; c < 3; c++) {
    const std = CLIP_STD[c] ?? 1;
    const mean = CLIP_MEAN[c] ?? 0;
    alpha.push(1 / (255 * std));
    beta.push(-mean / std);
  }
  return { alpha, beta };
}
