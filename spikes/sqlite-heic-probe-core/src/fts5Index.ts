/**
 * The primary OCR index: the design's `ocr_fts` virtual table, unchanged.
 *
 * The only non-obvious part is query construction. The user's raw text is not
 * passed to `MATCH` directly, because FTS5's query language would interpret `-`,
 * `:`, `"`, `(`, `*` and the bare words `AND`/`OR`/`NOT`/`NEAR` as syntax. OCR
 * search boxes get pasted receipt fragments and flight codes, so that is not a
 * theoretical risk — `MATCH 'SFO -> NRT'` is a syntax error, and a query
 * containing `OR` would quietly change the operator.
 *
 * So the query is tokenized first and rebuilt as quoted string terms, which FTS5
 * treats as literals and re-tokenizes itself. Because the tokenizer used here is
 * an equivalent of `unicode61 remove_diacritics 2`, that round trip is a no-op on
 * the tokens and only strips the syntax.
 *
 * Note the mode: `unicode61-equivalent`, *not* the fallback's `cjk-split`. FTS5's
 * index holds a whole CJK run as one token, so splitting the query would produce
 * terms that cannot exist in this index.
 */

import type { OcrDocument } from './corpus.ts';
import { DESIGN_FTS5_DDL } from './capability.ts';
import type { SqlDriver } from './driver.ts';
import type { OcrIndex, RankedHit } from './ocrIndex.ts';
import { parseQuery } from './tokenize.ts';

export class Fts5OcrIndex implements OcrIndex {
  readonly kind = 'fts5' as const;

  constructor(private readonly driver: SqlDriver) {}

  async create(): Promise<void> {
    await this.driver.exec('DROP TABLE IF EXISTS ocr_fts');
    await this.driver.exec(DESIGN_FTS5_DDL);
  }

  async index(documents: readonly OcrDocument[]): Promise<void> {
    for (const document of documents) {
      await this.driver.run('INSERT INTO ocr_fts(hash, text) VALUES (?, ?)', [
        document.hash,
        document.text,
      ]);
    }
  }

  async search(query: string, limit: number): Promise<RankedHit[]> {
    const expression = toMatchExpression(query);
    if (expression === null) return [];

    return this.driver.all<RankedHit>(
      `SELECT hash, bm25(ocr_fts) AS score
         FROM ocr_fts
        WHERE ocr_fts MATCH ?
        ORDER BY score
        LIMIT ?`,
      [expression, limit]
    );
  }

  async sizeBytes(): Promise<number | undefined> {
    try {
      // `dbstat` is only present with SQLITE_ENABLE_DBSTAT_VTAB, which
      // expo-sqlite does not define, so this is expected to be unavailable on
      // device. Attempted anyway because when it does work it is the only
      // honest measure of index size.
      const rows = await this.driver.all<{ bytes: number }>(
        "SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name LIKE 'ocr_fts%'"
      );
      return rows[0]?.bytes ?? undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Builds a safe FTS5 `MATCH` expression, or null when the query has no usable
 * tokens.
 *
 * Terms are joined implicitly, which FTS5 reads as AND. That matches the
 * fallback, and it is the right default for search-as-you-type: adding a word
 * should narrow the result set.
 */
export function toMatchExpression(query: string): string | null {
  const { terms, prefixes } = parseQuery(query, 'unicode61-equivalent');
  const parts = [
    ...terms.map((term) => `"${escapeFts5(term)}"`),
    // FTS5 accepts a trailing `*` on a quoted string as a prefix token.
    ...prefixes.map((prefix) => `"${escapeFts5(prefix)}"*`),
  ];
  return parts.length === 0 ? null : parts.join(' ');
}

/** Inside an FTS5 string literal, only the double quote needs escaping, by doubling. */
function escapeFts5(token: string): string {
  return token.replace(/"/g, '""');
}
