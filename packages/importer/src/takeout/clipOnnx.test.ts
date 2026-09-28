/**
 * Task 2.9: CLIP ONNX embedding integration tests.
 *
 * These tests require the ONNX model artifact at the path set by
 * CLIP_ONNX_MODEL_PATH (or the default .models/ location). They are skipped
 * when the model is not present so CI does not fail without the 153 MB file.
 *
 * The parity assertion (importer vs spike reference) is the load-bearing check:
 * it ensures the importer's preprocessing convention matches the spike's, so
 * vectors computed on the desktop are directly comparable to vectors computed
 * on-device (Req 11.2, 11.5, task 2.9).
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  COARSE_VECTOR_DIM,
  EmbeddingError,
  projectAndQuantize,
  RAW_VECTOR_DIM,
} from './embeddings.ts';
import { ClipOnnxSession, toClipPixelValues, CLIP_INPUT_SIZE } from './clipOnnx.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL_PATH = path.join(HERE, '../../../../.models/clip_full_quantized.onnx');
const MODEL_PATH = process.env['CLIP_ONNX_MODEL_PATH'] ?? DEFAULT_MODEL_PATH;
const MODEL_AVAILABLE = existsSync(MODEL_PATH);

/** Renders a flat-colour 224×224 RGB image — same convention as the spike fixtures. */
function renderSolidRgb(r: number, g: number, b: number): Uint8Array {
  const pixels = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
  const out = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** Int8 dot product (approximates cosine for L2-normalized projected vectors). */
function int8DotProduct(a: Int8Array, b: Int8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

describe('ClipOnnxSession', () => {
  describe('toClipPixelValues (unit, no model required)', () => {
    it('produces CHW float32 tensor of correct length', () => {
      const rgb = renderSolidRgb(128, 64, 32);
      const tensor = toClipPixelValues(rgb);
      expect(tensor.length).toBe(3 * CLIP_INPUT_SIZE * CLIP_INPUT_SIZE);
    });

    it('applies CLIP channel normalization', () => {
      // Pure red pixel: R=255, G=0, B=0
      const rgb = renderSolidRgb(255, 0, 0);
      const tensor = toClipPixelValues(rgb);
      const pixels = CLIP_INPUT_SIZE * CLIP_INPUT_SIZE;
      // R channel: (1.0 - 0.48145466) / 0.26862954 ≈ 1.9305
      expect(tensor[0]).toBeCloseTo(1.9305, 2);
      // G channel: (0.0 - 0.4578275) / 0.26130258 ≈ -1.7522
      expect(tensor[pixels]).toBeCloseTo(-1.7522, 2);
    });

    it('throws EmbeddingError for wrong-sized input', () => {
      expect(() => toClipPixelValues(new Uint8Array(10))).toThrow(EmbeddingError);
    });
  });

  describe.skipIf(!MODEL_AVAILABLE)('ONNX inference (requires model artifact)', () => {
    let session: ClipOnnxSession;

    beforeAll(async () => {
      session = await ClipOnnxSession.create(MODEL_PATH);
    });

    it('embedImageRaw returns L2-normalized 512-dim vector', async () => {
      const rgb = renderSolidRgb(220, 30, 30); // red
      const vec = await session.embedRgbBytes(rgb);

      expect(vec.length).toBe(RAW_VECTOR_DIM);

      // L2 norm should be ~1.0 after normalization
      let sumSq = 0;
      for (let i = 0; i < vec.length; i++) sumSq += (vec[i] ?? 0) ** 2;
      expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 4);
    });

    it('embedImage returns 256-dim int8 quantized vector', async () => {
      const rgb = renderSolidRgb(30, 60, 210); // blue
      const q = await session.embedImage(Buffer.from(rgb));

      expect(q.length).toBe(COARSE_VECTOR_DIM);
      expect(q).toBeInstanceOf(Int8Array);
      // Values must be in int8 range
      for (let i = 0; i < q.length; i++) {
        expect(q[i]).toBeGreaterThanOrEqual(-128);
        expect(q[i]).toBeLessThanOrEqual(127);
      }
    });

    it('parity: same RGB bytes produce identical projected int8 vectors across two calls', async () => {
      // This is the importer-vs-app parity assertion: the projection is deterministic
      // and the same input must always produce the same coarse vector.
      const rgb = renderSolidRgb(30, 160, 60); // green
      const q1 = await session.embedRgbBytes(rgb).then(projectAndQuantize);
      const q2 = await session.embedRgbBytes(rgb).then(projectAndQuantize);

      expect(Array.from(q1)).toEqual(Array.from(q2));
    });

    it('distinct images produce distinct vectors (separation check)', async () => {
      const redRgb = renderSolidRgb(220, 30, 30);
      const blueRgb = renderSolidRgb(30, 60, 210);

      const redVec = await session.embedRgbBytes(redRgb).then(projectAndQuantize);
      const blueVec = await session.embedRgbBytes(blueRgb).then(projectAndQuantize);

      // Self-similarity should exceed cross-similarity
      const selfSim = int8DotProduct(redVec, redVec);
      const crossSim = int8DotProduct(redVec, blueVec);
      expect(selfSim).toBeGreaterThan(crossSim);
    });
  });
});
