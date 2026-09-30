import { describe, expect, it } from 'vitest';
import {
  tokenizeOcrText,
  buildFts5MatchExpression,
  indexOcrDocument,
  searchOcrIndex,
} from './ocrIndex.ts';
import {
  reciprocalRankFusion,
  filterCandidateHashes,
} from './fusion.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import { migrate } from '../db/migrate.ts';

describe('OCR Indexing & Search (Task 6.4)', () => {
  it('tokenizes text and builds safe FTS5 query terms without syntax errors', () => {
    const raw = 'Coffee & Tea - $4.50 (Invoice: #102)';
    const tokens = tokenizeOcrText(raw);
    expect(tokens).toContain('coffee');
    expect(tokens).toContain('tea');
    expect(tokens).toContain('4');
    expect(tokens).toContain('50');
    expect(tokens).toContain('invoice');

    const expr = buildFts5MatchExpression('SFO -> NRT: Gate 42');
    expect(expr).toBe('"sfo" "nrt" "gate" "42"');
  });

  it('indexes OCR documents into ocr_fts and retrieves ranked BM25 matches', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    // Insert dummy asset rows
    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, thumbhash, remote_state, local_state, updated_at)
       VALUES ('h1', 0, 100, 'image/jpeg', 1000, 0, X'00', 2, 1, 1000),
              ('h2', 0, 100, 'image/jpeg', 2000, 0, X'00', 2, 1, 2000)`,
    );

    await indexOcrDocument(driver, {
      hash: 'h1',
      text: 'BLUE BOTTLE COFFEE SAN FRANCISCO CA OAT MILK LATTE',
    });
    await indexOcrDocument(driver, {
      hash: 'h2',
      text: 'ACME HARDWARE TOOLS & LUMBER RECEIPT',
    });

    const coffeeHits = await searchOcrIndex(driver, 'Blue Bottle Coffee');
    expect(coffeeHits.length).toBe(1);
    expect(coffeeHits[0]?.hash).toBe('h1');

    const lumberHits = await searchOcrIndex(driver, 'hardware receipt');
    expect(lumberHits.length).toBe(1);
    expect(lumberHits[0]?.hash).toBe('h2');

    driver.close();
  });
});

describe('Search Filters & Reciprocal Rank Fusion (Task 6.5)', () => {
  it('combines disparate rankings via Reciprocal Rank Fusion', () => {
    // Vector search top results: hA, hB, hC
    const vectorList = ['hA', 'hB', 'hC'];
    // OCR search top results: hB, hD, hA
    const ocrList = ['hB', 'hD', 'hA'];

    const fused = reciprocalRankFusion([vectorList, ocrList], 60);

    // hB is rank 2 in vector and rank 1 in ocr -> highest fused score
    expect(fused[0]?.hash).toBe('hB');
    // hA is rank 1 in vector and rank 3 in ocr -> second highest
    expect(fused[1]?.hash).toBe('hA');
  });

  it('filters candidate hashes by date, kind, and camera metadata', async () => {
    const driver = new NodeSqliteDriver({ path: ':memory:' });
    await migrate(driver);

    await driver.run(
      `INSERT INTO assets (hash, kind, byte_size, mime, captured_at, captured_at_src, camera_make, camera_model, thumbhash, remote_state, local_state, updated_at)
       VALUES ('photo_sony', 0, 100, 'image/jpeg', 1000, 0, 'Sony', 'A7 IV', X'00', 2, 1, 1000),
              ('photo_iphone', 0, 100, 'image/jpeg', 2000, 0, 'Apple', 'iPhone 15 Pro', X'00', 2, 1, 2000),
              ('video_sony', 1, 500, 'video/mp4', 3000, 0, 'Sony', 'A7 IV', X'00', 2, 1, 3000)`,
    );

    const candidates = ['photo_sony', 'photo_iphone', 'video_sony'];

    // Filter by kind = 0 (photo)
    const photosOnly = await filterCandidateHashes(driver, candidates, { kind: 0 });
    expect(photosOnly).toEqual(['photo_sony', 'photo_iphone']);

    // Filter by cameraMake = Sony
    const sonyOnly = await filterCandidateHashes(driver, candidates, { cameraMake: 'Sony' });
    expect(sonyOnly).toEqual(['photo_sony', 'video_sony']);

    // Filter by date range
    const dateFiltered = await filterCandidateHashes(driver, candidates, {
      minCapturedAt: 1500,
      maxCapturedAt: 2500,
    });
    expect(dateFiltered).toEqual(['photo_iphone']);

    driver.close();
  });
});
