/**
 * The contract both OCR index implementations satisfy.
 *
 * Having one contract is the point of the exercise. Requirement 5.4 says OCR text
 * must be searchable; it does not say FTS5. If the primary and the fallback are
 * interchangeable behind this interface, then task 6.4 and the search fusion in
 * task 6.5 are written once and the FTS5 question stops being able to block them.
 */

import type { OcrDocument } from './corpus.ts';

export type OcrIndexKind = 'fts5' | 'token-table';

export interface RankedHit {
  readonly hash: string;
  /**
   * Lower is better, matching FTS5's `bm25()` convention of returning a negated
   * score so that `ORDER BY ... ASC` is best-first. The fallback follows the same
   * sign convention so callers cannot tell the two apart.
   */
  readonly score: number;
}

export interface OcrIndex {
  readonly kind: OcrIndexKind;
  /** Creates the schema. Must be idempotent so a probe can be re-run. */
  create(): Promise<void>;
  index(documents: readonly OcrDocument[]): Promise<void>;
  search(query: string, limit: number): Promise<RankedHit[]>;
  /** Bytes the index occupies, when the driver can measure it. Diagnostic only. */
  sizeBytes(): Promise<number | undefined>;
}

/** BM25 parameters, fixed to the values FTS5's `bm25()` uses. */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/**
 * FTS5's inverse document frequency, reproduced exactly.
 *
 * Two details are not the textbook formula and both matter for the fallback to
 * rank the same way as FTS5:
 *
 * 1. The `+ 0.5` terms are on the *unsmoothed* Robertson/Sparck-Jones form, so
 *    idf goes negative for terms present in more than about half the corpus.
 * 2. FTS5 clamps a non-positive idf to a tiny positive epsilon rather than to
 *    zero, which keeps such a term contributing a hair of signal instead of
 *    silently dropping out of the ranking.
 *
 * Computed here in JS rather than in SQL on purpose: it needs only the corpus
 * size and the term's document frequency, both of which are one cheap query, and
 * keeping it out of SQL means the fallback does not depend on
 * `SQLITE_ENABLE_MATH_FUNCTIONS`. A fallback that needs its own build flags to
 * work would not be much of a fallback.
 */
export function idf(documentCount: number, matchingDocuments: number): number {
  const value = Math.log(
    (documentCount - matchingDocuments + 0.5) / (matchingDocuments + 0.5)
  );
  return value <= 0 ? 1e-6 : value;
}
