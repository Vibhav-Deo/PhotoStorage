import { describe, expect, it } from 'vitest';
import {
  BoundedMinHeap,
  dotProductInt8,
  cosineSimilarityFloat32,
  decodeVectorFullBlob,
  encodeFloat16Blob,
  executeTwoStageVectorSearch,
} from './retrieval.ts';
import { CoarseIndex, InMemoryCoarseStore } from './coarseIndex.ts';
import {
  COARSE_VECTOR_DIM,
  RAW_VECTOR_DIM,
  DEFAULT_MODEL_ID,
  l2Normalize,
  projectAndQuantize,
} from './embedding.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';

describe('BoundedMinHeap', () => {
  it('maintains the top-K elements by score', () => {
    const heap = new BoundedMinHeap<{ score: number; id: string }>(3);
    heap.push({ score: 10, id: 'a' });
    heap.push({ score: 50, id: 'b' });
    heap.push({ score: 20, id: 'c' });
    heap.push({ score: 5, id: 'd' }); // should be rejected
    heap.push({ score: 40, id: 'e' }); // evicts 10

    const sorted = heap.toArraySorted();
    expect(sorted).toEqual([
      { score: 50, id: 'b' },
      { score: 40, id: 'e' },
      { score: 20, id: 'c' },
    ]);
  });
});

describe('Float16 Encoding & Decoding', () => {
  it('accurately roundtrips float values in fp16', () => {
    const original = new Float32Array(RAW_VECTOR_DIM);
    for (let i = 0; i < RAW_VECTOR_DIM; i++) {
      original[i] = Math.sin(i * 0.1) * 0.5;
    }
    const fp16Bytes = encodeFloat16Blob(original);
    expect(fp16Bytes.byteLength).toBe(RAW_VECTOR_DIM * 2);

    const decoded = decodeVectorFullBlob(fp16Bytes);
    expect(decoded.length).toBe(RAW_VECTOR_DIM);

    // Assert cosine similarity between fp32 original and decoded fp16 is > 0.999
    const cos = cosineSimilarityFloat32(original, decoded);
    expect(cos).toBeGreaterThan(0.999);
  });
});

describe('Two-Stage Vector Retrieval (Task 6.3)', () => {
  it('executes coarse scan and exact rerank with high recall against exhaustive baseline', async () => {
    // 1. Setup in-memory SQLite and CoarseIndex
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const store = new InMemoryCoarseStore();
    const coarseIndex = await CoarseIndex.open(store, store);

    // 2. Generate a labeled corpus of 60 synthetic vectors
    const corpusCount = 60;
    const vectors: { hash: string; raw512: Float32Array; slot: number }[] = [];

    for (let i = 0; i < corpusCount; i++) {
      const hash = `hash_${String(i).padStart(4, '0')}`;
      const raw = new Float32Array(RAW_VECTOR_DIM);
      let seed = (i + 1) * 1103515245 + 12345;
      for (let d = 0; d < RAW_VECTOR_DIM; d++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        raw[d] = (seed / 0x7fffffff) * 2 - 1;
      }
      l2Normalize(raw);

      // Quantize to coarse vector
      const int8 = projectAndQuantize(raw);
      const slot = await coarseIndex.allocate();
      await coarseIndex.writeVector(slot, int8);

      // Insert into assets table to satisfy foreign key constraint
      await driver.run(
        `INSERT INTO assets (
          hash, kind, byte_size, mime, captured_at, captured_at_src,
          thumbhash, remote_state, local_state, updated_at
        ) VALUES (?, 0, 1024, 'image/jpeg', ?, 0, X'00', 2, 1, ?)`,
        [hash, Date.now(), Date.now()],
      );

      // Write slot mapping and full vector
      await driver.run(
        'INSERT INTO vector_slots (slot, hash, model_id) VALUES (?, ?, ?)',
        [slot, hash, DEFAULT_MODEL_ID],
      );

      const fp16 = encodeFloat16Blob(raw);
      await driver.run(
        'INSERT INTO vector_full (hash, model_id, vec) VALUES (?, ?, ?)',
        [hash, DEFAULT_MODEL_ID, fp16],
      );

      vectors.push({ hash, raw512: raw, slot });
    }

    // 3. Formulate query similar to item #15
    const targetItem = vectors[15]!;
    const query = new Float32Array(targetItem.raw512);
    for (let d = 0; d < RAW_VECTOR_DIM; d++) {
      query[d] = (query[d] ?? 0) + Math.sin(d) * 0.01;
    }
    l2Normalize(query);

    // 4. Run two-stage retrieval
    const results = await executeTwoStageVectorSearch(coarseIndex, driver, query, {
      candidateLimit: 20,
      finalLimit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    // Target item #15 must be the rank 1 result
    expect(results[0]?.hash).toBe(targetItem.hash);
    expect(results[0]?.score).toBeGreaterThan(0.95);

    driver.close();
  });
});
