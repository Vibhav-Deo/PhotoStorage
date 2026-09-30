import { describe, expect, it } from 'vitest';
import {
  COARSE_VECTOR_DIM,
  CoarseVectorBuffer,
  DEFAULT_MODEL_ID,
  EmbeddingError,
  RAW_VECTOR_DIM,
  l2Normalize,
  projectAndQuantize,
  projectVector256,
  quantizeInt8,
} from './embedding.ts';

describe('embeddings & CoarseVectorBuffer', () => {
  it('projects 512-dim raw Float32 vector to 256-dim normalized Float32 vector', () => {
    const raw512 = new Float32Array(RAW_VECTOR_DIM);
    for (let i = 0; i < RAW_VECTOR_DIM; i++) {
      raw512[i] = (i % 10) / 10.0;
    }

    const proj = projectVector256(raw512);
    expect(proj.length).toBe(COARSE_VECTOR_DIM);

    // Compute L2 norm
    let sumSq = 0;
    for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
      const v = proj[i] ?? 0;
      sumSq += v * v;
    }
    expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 4);
  });

  it('quantizes normalized Float32 vector to int8 range [-128..127]', () => {
    const vec256 = new Float32Array(COARSE_VECTOR_DIM);
    vec256[0] = 1.0;
    vec256[1] = -1.0;
    vec256[2] = 0.5;

    const q = quantizeInt8(vec256);
    expect(q.length).toBe(COARSE_VECTOR_DIM);
    expect(q[0]).toBe(127);
    expect(q[1]).toBe(-128);
    expect(q[2]).toBe(64);
  });

  it('projectAndQuantize performs projection and quantization in sequence', () => {
    const raw512 = new Float32Array(RAW_VECTOR_DIM);
    raw512.fill(0.1);

    const q = projectAndQuantize(raw512);
    expect(q.length).toBe(COARSE_VECTOR_DIM);
    expect(q).toBeInstanceOf(Int8Array);
  });

  it('throws EmbeddingError for invalid input dimensions', () => {
    expect(() => projectVector256(new Float32Array(100))).toThrow(EmbeddingError);
    expect(() => quantizeInt8(new Float32Array(100))).toThrow(EmbeddingError);
  });

  it('projectAndQuantize is deterministic for identical input', () => {
    // Parity is by construction now that importer and app share this module,
    // but determinism across calls is still worth asserting directly: a change
    // here invalidates every stored coarse vector (Req 12.5).
    const raw512 = new Float32Array(RAW_VECTOR_DIM);
    for (let i = 0; i < RAW_VECTOR_DIM; i++) raw512[i] = Math.sin(i * 0.37);

    const a = projectAndQuantize(raw512);
    const b = projectAndQuantize(raw512);
    expect(a).toEqual(b);
  });

  describe('l2Normalize', () => {
    it('normalizes to unit magnitude', () => {
      const v = new Float32Array([3, 4]);
      const out = l2Normalize(v);
      expect(out).toBe(v); // in place
      expect(out[0]).toBeCloseTo(0.6, 6);
      expect(out[1]).toBeCloseTo(0.8, 6);
    });

    it('is idempotent on an already-normalized vector', () => {
      const v = l2Normalize(new Float32Array([3, 4, 5]));
      const before = [...v];
      l2Normalize(v);
      for (let i = 0; i < v.length; i++) {
        expect(v[i]).toBeCloseTo(before[i] ?? 0, 6);
      }
    });

    it('throws EmbeddingError for near-zero magnitude', () => {
      expect(() => l2Normalize(new Float32Array([0, 0, 0]))).toThrow(EmbeddingError);
    });
  });

  describe('CoarseVectorBuffer slot allocation & free slot reuse', () => {
    it('allocates new slots sequentially and manages buffer expansion', () => {
      const coarseBuf = new CoarseVectorBuffer({ modelId: DEFAULT_MODEL_ID });
      expect(coarseBuf.slotCount).toBe(0);

      const slot0 = coarseBuf.allocateSlot();
      const slot1 = coarseBuf.allocateSlot();
      expect(slot0).toBe(0);
      expect(slot1).toBe(1);
      expect(coarseBuf.slotCount).toBe(2);

      const dummyVec = new Int8Array(COARSE_VECTOR_DIM);
      dummyVec.fill(42);
      coarseBuf.writeVector(slot0, dummyVec);

      const read0 = coarseBuf.readVector(slot0);
      expect(read0[0]).toBe(42);
      expect(read0[COARSE_VECTOR_DIM - 1]).toBe(42);
    });

    it('reuses freed slots before allocating new ones', () => {
      const coarseBuf = new CoarseVectorBuffer();
      const slot0 = coarseBuf.allocateSlot();
      const slot1 = coarseBuf.allocateSlot();
      const slot2 = coarseBuf.allocateSlot();

      expect(slot0).toBe(0);
      expect(slot1).toBe(1);
      expect(slot2).toBe(2);

      // Free slot 1
      coarseBuf.freeSlot(slot1);
      expect(coarseBuf.freeSlots).toContain(1);

      // Next allocation should reuse slot 1
      const slotReused = coarseBuf.allocateSlot();
      expect(slotReused).toBe(1);
      expect(coarseBuf.freeSlots).not.toContain(1);

      // Subsequent allocation gets slot 3
      const slot3 = coarseBuf.allocateSlot();
      expect(slot3).toBe(3);
    });

    it('exports well-formed header JSON representation', () => {
      const coarseBuf = new CoarseVectorBuffer({ modelId: 'test-model' });
      coarseBuf.allocateSlot(); // 0
      coarseBuf.allocateSlot(); // 1
      coarseBuf.freeSlot(0);

      const header = coarseBuf.getHeader();
      expect(header.modelId).toBe('test-model');
      expect(header.coarseDim).toBe(256);
      expect(header.slotCount).toBe(2);
      expect(header.freeSlots).toEqual([0]);
    });
  });
});
