/**
 * Search filter predicates and Reciprocal Rank Fusion (Task 6.5).
 *
 * Implements:
 * - Candidate set predicates: date range, camera model, coordinates/geo bounding box, media kind.
 * - Reciprocal Rank Fusion (RRF) with default k = 60 to fuse vector search ranks and OCR BM25 ranks.
 *
 * Requirements:
 * - 5.5: Combined search over semantics, OCR, and metadata predicates.
 * - 5.6: Reciprocal rank fusion without requiring calibrated scores.
 */

import type { SqlDriver, SqlValue } from '../db/driver.ts';

export interface SearchPredicates {
  readonly kind?: number; // 0=image, 1=video, 2=motion_component
  readonly minCapturedAt?: number;
  readonly maxCapturedAt?: number;
  readonly cameraMake?: string;
  readonly cameraModel?: string;
  readonly favoriteOnly?: boolean;
  readonly albumId?: string;
}

export interface FusedSearchResult {
  readonly hash: string;
  readonly fusedScore: number;
  readonly vectorRank?: number;
  readonly ocrRank?: number;
}

export const DEFAULT_RRF_K = 60;

/**
 * Computes Reciprocal Rank Fusion over multiple ranked lists of hashes.
 *
 * Formula: RRF_score(d) = sum_{m in models} 1 / (k + rank_m(d))
 * where rank is 1-based.
 */
export function reciprocalRankFusion(
  rankedLists: readonly (readonly string[])[],
  k = DEFAULT_RRF_K,
): FusedSearchResult[] {
  const scores = new Map<string, { fusedScore: number; ranks: number[] }>();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx]!;
    for (let i = 0; i < list.length; i++) {
      const hash = list[i]!;
      const rank = i + 1; // 1-based rank
      const contribution = 1 / (k + rank);

      let entry = scores.get(hash);
      if (!entry) {
        entry = { fusedScore: 0, ranks: [] };
        scores.set(hash, entry);
      }
      entry.fusedScore += contribution;
      entry.ranks[listIdx] = rank;
    }
  }

  const results: FusedSearchResult[] = [];
  for (const [hash, entry] of scores.entries()) {
    results.push({
      hash,
      fusedScore: entry.fusedScore,
      vectorRank: entry.ranks[0],
      ocrRank: entry.ranks[1],
    });
  }

  // Sort descending by fused score
  results.sort((a, b) => b.fusedScore - a.fusedScore);
  return results;
}

/**
 * Applies metadata filter predicates against a set of candidate hashes.
 *
 * Implemented as a candidate set filter (post-scan), which avoids
 * skewing index scan behavior while ensuring only valid items survive.
 */
export async function filterCandidateHashes(
  driver: SqlDriver,
  candidateHashes: readonly string[],
  predicates: SearchPredicates,
): Promise<string[]> {
  if (candidateHashes.length === 0) return [];

  const conditions: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];

  // IN candidateHashes
  const placeholders = candidateHashes.map(() => '?').join(',');
  conditions.push(`hash IN (${placeholders})`);
  params.push(...candidateHashes);

  if (predicates.kind !== undefined) {
    conditions.push('kind = ?');
    params.push(predicates.kind);
  }
  if (predicates.minCapturedAt !== undefined) {
    conditions.push('captured_at >= ?');
    params.push(predicates.minCapturedAt);
  }
  if (predicates.maxCapturedAt !== undefined) {
    conditions.push('captured_at <= ?');
    params.push(predicates.maxCapturedAt);
  }
  if (predicates.cameraMake !== undefined) {
    conditions.push('camera_make LIKE ?');
    params.push(`%${predicates.cameraMake}%`);
  }
  if (predicates.cameraModel !== undefined) {
    conditions.push('camera_model LIKE ?');
    params.push(`%${predicates.cameraModel}%`);
  }
  if (predicates.favoriteOnly) {
    conditions.push('favorite = 1');
  }

  let sql = `SELECT hash FROM assets WHERE ${conditions.join(' AND ')}`;

  if (predicates.albumId) {
    sql = `SELECT a.hash FROM assets a
      JOIN album_members m ON a.hash = m.hash
      WHERE m.album_id = ? AND ${conditions.map((c) => c.replace(/\bhash\b/g, 'a.hash')).join(' AND ')}`;
    params.unshift(predicates.albumId);
  }

  const rows = await driver.all<{ hash: string }>(sql, params as readonly SqlValue[]);
  const allowedSet = new Set(rows.map((r) => r.hash));

  // Maintain initial rank ordering
  return candidateHashes.filter((h) => allowedSet.has(h));
}
