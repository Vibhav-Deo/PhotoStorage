/**
 * OCR text indexing and searching (Task 6.4).
 *
 * Implements FTS5 index access against `ocr_fts` virtual table,
 * sanitized query builder (avoiding FTS syntax collisions),
 * and indexing pipeline for detected textual content.
 *
 * Requirements:
 * - 5.4: On-device text recognition searchable via text queries.
 */

import type { SqlDriver } from '../db/driver.ts';

export interface OcrDocument {
  readonly hash: string;
  readonly text: string;
}

export interface OcrSearchHit {
  readonly hash: string;
  readonly score: number; // BM25 rank score (negative is better in FTS5)
}

/** Regex identifying token characters (Unicode letters and numbers). */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

/**
 * Normalizes text and splits into tokens using unicode61-compatible rules.
 */
export function tokenizeOcrText(text: string): string[] {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const tokens: string[] = [];
  let current = '';

  for (const ch of folded) {
    if (TOKEN_CHAR.test(ch)) {
      current += ch;
    } else if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Converts a raw search query into an FTS5 MATCH expression by wrapping
 * individual tokens in quotes to prevent syntax collisions with FTS5 operators
 * (like NEAR, NOT, OR, colons, hyphens).
 */
export function buildFts5MatchExpression(rawQuery: string): string | null {
  const tokens = tokenizeOcrText(rawQuery);
  if (tokens.length === 0) return null;
  // Quote each token and join with space (implicit AND in FTS5)
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Indexes an OCR document into the `ocr_fts` virtual table.
 */
export async function indexOcrDocument(
  driver: SqlDriver,
  doc: OcrDocument,
): Promise<void> {
  const text = doc.text.trim();
  if (!text) return;

  // Delete existing entry if present
  await driver.run('DELETE FROM ocr_fts WHERE hash = ?', [doc.hash]);

  // Insert into FTS5
  await driver.run('INSERT INTO ocr_fts (hash, text) VALUES (?, ?)', [
    doc.hash,
    text,
  ]);
}

/**
 * Batch indexes multiple OCR documents in a single transaction.
 */
export async function indexOcrDocuments(
  driver: SqlDriver,
  docs: readonly OcrDocument[],
): Promise<void> {
  await driver.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of docs) {
      const text = doc.text.trim();
      if (!text) continue;
      await driver.run('DELETE FROM ocr_fts WHERE hash = ?', [doc.hash]);
      await driver.run('INSERT INTO ocr_fts (hash, text) VALUES (?, ?)', [
        doc.hash,
        text,
      ]);
    }
    await driver.exec('COMMIT');
  } catch (err) {
    await driver.exec('ROLLBACK').catch(() => {});
    throw err;
  }
}

/**
 * Searches the `ocr_fts` virtual table and returns ranked hits using SQLite's BM25.
 */
export async function searchOcrIndex(
  driver: SqlDriver,
  query: string,
  limit = 100,
): Promise<OcrSearchHit[]> {
  const matchExpr = buildFts5MatchExpression(query);
  if (!matchExpr) return [];

  try {
    const rows = await driver.all<{ hash: string; score: number }>(
      `SELECT hash, bm25(ocr_fts) AS score
         FROM ocr_fts
        WHERE ocr_fts MATCH ?
        ORDER BY score ASC
        LIMIT ?`,
      [matchExpr, limit],
    );
    return rows;
  } catch (_err) {
    // If table not found or MATCH syntax error, return empty
    return [];
  }
}
