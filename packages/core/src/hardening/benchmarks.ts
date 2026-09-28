/**
 * Performance Benchmarks (Task 10.2).
 *
 * Requirements: 4.3, 5.3
 * Measures:
 * - Timeline query pagination latency (Req 4.3)
 * - Two-stage vector retrieval latency (Req 5.3, sub-300ms SLA)
 */

import type { SqlDriver } from '../db/driver.ts';
import type { CoarseIndex } from '../embed/coarseIndex.ts';
import { executeTwoStageVectorSearch } from '../embed/retrieval.ts';
import { RAW_VECTOR_DIM } from '../embed/embedding.ts';

export interface BenchmarkReport {
  readonly timelineQueryLatencyMs: number;
  readonly searchLatencyMs: number;
  readonly timelinePassesSla: boolean;
  readonly searchPassesSla: boolean;
}

/**
 * Runs performance benchmarks against the active database and coarse index.
 */
export async function runPerformanceBenchmarks(
  driver: SqlDriver,
  coarseIndex: CoarseIndex,
  queryVector?: Float32Array,
): Promise<BenchmarkReport> {
  // 1. Timeline pagination benchmark (fetching top 150 items with captured_at ordering)
  const timelineStart = performance.now();
  const timelineRows = await driver.all(
    `SELECT hash, thumbhash, captured_at FROM assets
     WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT 150 OFFSET 0`,
  );
  const timelineDuration = performance.now() - timelineStart;

  // 2. Search latency benchmark (two-stage scan + rerank)
  const vec = queryVector ?? new Float32Array(RAW_VECTOR_DIM);
  if (!queryVector) {
    vec[0] = 1.0;
  }

  const searchStart = performance.now();
  await executeTwoStageVectorSearch(coarseIndex, driver, vec, {
    candidateLimit: 200,
    finalLimit: 50,
  });
  const searchDuration = performance.now() - searchStart;

  return {
    timelineQueryLatencyMs: timelineDuration,
    searchLatencyMs: searchDuration,
    timelinePassesSla: timelineDuration < 50, // sub-50ms query
    searchPassesSla: searchDuration < 300,    // sub-300ms Requirement 5.3 SLA
  };
}
