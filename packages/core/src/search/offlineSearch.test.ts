/**
 * Offline Search Verification Test (Task 6.6).
 *
 * Requirements: 5.3, 5.7
 * Explicitly asserts that vector search, OCR FTS search, metadata filtering,
 * and reciprocal rank fusion execute completely offline using only local SQLite
 * and local coarse.bin, even when all network capabilities are disabled or severed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';
import { CoarseIndex, InMemoryCoarseStore } from '../embed/coarseIndex.ts';
import {
  RAW_VECTOR_DIM,
  DEFAULT_MODEL_ID,
  l2Normalize,
  projectAndQuantize,
} from '../embed/embedding.ts';
import {
  encodeFloat16Blob,
  executeTwoStageVectorSearch,
} from '../embed/retrieval.ts';
import { indexOcrDocument, searchOcrIndex } from './ocrIndex.ts';
import { filterCandidateHashes, reciprocalRankFusion } from './fusion.ts';

describe('Offline Search Verification (Task 6.6)', () => {
  let driver: NodeSqliteDriver;
  let coarseIndex: CoarseIndex;

  beforeEach(async () => {
    // 1. Sever network: any network fetch attempts will fail loudly
    vi.stubGlobal('fetch', () => {
      throw new Error('NETWORK_DISABLED: offline test invariant violated');
    });

    // 2. Initialize pure local storage
    driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    const store = new InMemoryCoarseStore();
    coarseIndex = await CoarseIndex.open(store, store);

    // 3. Populate local assets, coarse vectors, and OCR data
    const assets = [
      { hash: 'hash_beach', ocr: 'Sunny beach in Santa Cruz California', kind: 0, year: 2023 },
      { hash: 'hash_coffee', ocr: 'Espresso receipt Blue Bottle Coffee San Francisco', kind: 0, year: 2024 },
      { hash: 'hash_mountain', ocr: 'Trailhead Yosemite National Park hiking pass', kind: 0, year: 2022 },
    ];

    for (let i = 0; i < assets.length; i++) {
      const a = assets[i]!;
      // Insert asset row
      await driver.run(
        `INSERT INTO assets (
          hash, kind, byte_size, mime, captured_at, captured_at_src,
          thumbhash, remote_state, local_state, updated_at
        ) VALUES (?, ?, 5000, 'image/jpeg', ?, 0, X'00', 2, 1, ?)`,
        [a.hash, a.kind, a.year * 1000000, Date.now()],
      );

      // Create synthetic vector with unique signature
      const raw = new Float32Array(RAW_VECTOR_DIM);
      raw[i * 10] = 1.0;
      raw[i * 10 + 1] = 0.8;
      l2Normalize(raw);

      const int8 = projectAndQuantize(raw);
      const slot = await coarseIndex.allocate();
      await coarseIndex.writeVector(slot, int8);

      await driver.run(
        'INSERT INTO vector_slots (slot, hash, model_id) VALUES (?, ?, ?)',
        [slot, a.hash, DEFAULT_MODEL_ID],
      );

      const fp16 = encodeFloat16Blob(raw);
      await driver.run(
        'INSERT INTO vector_full (hash, model_id, vec) VALUES (?, ?, ?)',
        [a.hash, DEFAULT_MODEL_ID, fp16],
      );

      // Index OCR text into local FTS5
      await indexOcrDocument(driver, { hash: a.hash, text: a.ocr });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    driver.close();
  });

  it('completes two-stage vector search with networking completely disabled', async () => {
    const query = new Float32Array(RAW_VECTOR_DIM);
    // Target coffee asset (index 1)
    query[10] = 1.0;
    query[11] = 0.8;
    l2Normalize(query);

    const vectorResults = await executeTwoStageVectorSearch(coarseIndex, driver, query, {
      candidateLimit: 10,
      finalLimit: 3,
    });

    expect(vectorResults.length).toBeGreaterThan(0);
    expect(vectorResults[0]?.hash).toBe('hash_coffee');
    expect(vectorResults[0]?.score).toBeGreaterThan(0.95);
  });

  it('completes OCR text search and multimodal fusion entirely offline', async () => {
    // 1. Text search runs via SQLite FTS5
    const ocrHits = await searchOcrIndex(driver, 'Blue Bottle Coffee');
    expect(ocrHits.length).toBe(1);
    expect(ocrHits[0]?.hash).toBe('hash_coffee');

    // 2. Multimodal Reciprocal Rank Fusion
    const vectorRankings = ['hash_coffee', 'hash_beach', 'hash_mountain'];
    const ocrRankings = ocrHits.map((h) => h.hash);

    const fused = reciprocalRankFusion([vectorRankings, ocrRankings]);
    expect(fused[0]?.hash).toBe('hash_coffee');

    // 3. Metadata filters run via local SQLite
    const filtered = await filterCandidateHashes(driver, fused.map((f) => f.hash), {
      kind: 0,
      minCapturedAt: 2023 * 1000000,
    });

    expect(filtered).toContain('hash_coffee');
    expect(filtered).toContain('hash_beach');
    expect(filtered).not.toContain('hash_mountain');
  });
});
