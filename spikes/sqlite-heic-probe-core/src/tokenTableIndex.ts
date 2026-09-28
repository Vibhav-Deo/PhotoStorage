/**
 * The fallback the design names: "a normalized token table with manual ranking".
 *
 * This exists so the FTS5 question cannot block Requirement 5.4. It is designed
 * to be a *drop-in* for `Fts5OcrIndex`, right down to returning negated scores,
 * so tasks 6.4 and 6.5 never branch on which one is in use.
 *
 * ## Schema shape, and why
 *
 * ```sql
 * CREATE TABLE ocr_docs   (hash TEXT PRIMARY KEY, token_count INTEGER NOT NULL);
 * CREATE TABLE ocr_tokens (token TEXT, hash TEXT, tf INTEGER,
 *                          PRIMARY KEY (token, hash)) WITHOUT ROWID;
 * ```
 *
 * `WITHOUT ROWID` with `(token, hash)` as the primary key is the load-bearing
 * choice. It makes the table itself the inverted index: rows are physically
 * clustered by token, so a term lookup is one range scan over contiguous pages,
 * and a prefix lookup is the same scan over a wider range. The alternative — a
 * rowid table plus a separate index on `(token, hash)` — stores every posting
 * twice and adds an indirection per hit.
 *
 * `tf` is stored rather than one row per occurrence. Positions are not stored at
 * all, which is the fallback's real functional gap: without them there are no
 * phrase queries and no `NEAR`. The design does not use either — it fuses FTS
 * rank with vector rank via reciprocal rank fusion rather than asking users for
 * phrase syntax — so this is a deliberate omission, not an oversight. Adding
 * positions later is a schema migration, not a redesign.
 *
 * ## Ranking
 *
 * BM25 with FTS5's exact constants and idf form, so the two indexes can be
 * compared directly. The split of work is deliberate: idf needs only the corpus
 * size and each term's document frequency, which are tiny, so it is computed in
 * JS and bound in as a parameter. Everything that touches posting lists — the
 * scan, the per-document accumulation, and the top-k — stays in SQL, because at
 * 500,000 assets shipping whole posting lists into JS to sort them there is the
 * thing that would make this unusable.
 *
 * Keeping idf out of SQL has a second benefit: no `log()`, so the fallback does
 * not need `SQLITE_ENABLE_MATH_FUNCTIONS`. A fallback that requires its own build
 * flags would be answering the wrong question.
 */

import type { OcrDocument } from './corpus.ts';
import type { SqlDriver, SqlParam } from './driver.ts';
import { BM25_B, BM25_K1, idf, type OcrIndex, type RankedHit } from './ocrIndex.ts';
import { parseQuery, prefixRange, termFrequencies } from './tokenize.ts';

export const TOKEN_TABLE_DDL = [
  'DROP TABLE IF EXISTS ocr_tokens',
  'DROP TABLE IF EXISTS ocr_docs',
  `CREATE TABLE ocr_docs (
     hash        TEXT PRIMARY KEY,
     token_count INTEGER NOT NULL
   )`,
  `CREATE TABLE ocr_tokens (
     token TEXT NOT NULL,
     hash  TEXT NOT NULL,
     tf    INTEGER NOT NULL,
     PRIMARY KEY (token, hash)
   ) WITHOUT ROWID`,
  // Needed to delete a document's postings when an asset is removed or
  // re-recognized. Without it that becomes a full scan of the token table.
  'CREATE INDEX idx_ocr_tokens_hash ON ocr_tokens(hash)',
];

/** One atom of a parsed query: a single term, or a prefix range. */
interface Atom {
  readonly kind: 'term' | 'prefix';
  readonly text: string;
}

export class TokenTableOcrIndex implements OcrIndex {
  readonly kind = 'token-table' as const;

  constructor(private readonly driver: SqlDriver) {}

  async create(): Promise<void> {
    for (const statement of TOKEN_TABLE_DDL) {
      await this.driver.exec(statement);
    }
  }

  async index(documents: readonly OcrDocument[]): Promise<void> {
    for (const document of documents) {
      const frequencies = termFrequencies(document.text);
      let tokenCount = 0;
      for (const count of frequencies.values()) tokenCount += count;

      await this.driver.run('INSERT INTO ocr_docs(hash, token_count) VALUES (?, ?)', [
        document.hash,
        tokenCount,
      ]);
      for (const [token, tf] of frequencies) {
        await this.driver.run('INSERT INTO ocr_tokens(token, hash, tf) VALUES (?, ?, ?)', [
          token,
          document.hash,
          tf,
        ]);
      }
    }
  }

  async search(query: string, limit: number): Promise<RankedHit[]> {
    const { terms, prefixes } = parseQuery(query);
    const atoms: Atom[] = [
      ...terms.map((text): Atom => ({ kind: 'term', text })),
      ...prefixes.map((text): Atom => ({ kind: 'prefix', text })),
    ];
    if (atoms.length === 0) return [];

    const corpus = await this.corpusStats();
    if (corpus.documentCount === 0) return [];

    // Document frequency per atom, needed before scoring can be expressed.
    // One small query per atom rather than one combined query: each is an index
    // range scan over a single token range, which is exactly what the schema is
    // shaped for, and it keeps the SQL readable.
    const weights: number[] = [];
    for (const atom of atoms) {
      const matching = await this.documentFrequency(atom);
      if (matching === 0) {
        // Terms are ANDed, so one absent atom means no results. Returning early
        // also avoids emitting a query that cannot match.
        return [];
      }
      weights.push(idf(corpus.documentCount, matching));
    }

    const { sql, params } = this.buildScoringQuery(atoms, weights, corpus.averageLength, limit);
    return this.driver.all<RankedHit>(sql, params);
  }

  async sizeBytes(): Promise<number | undefined> {
    try {
      const rows = await this.driver.all<{ bytes: number }>(
        "SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('ocr_tokens', 'ocr_docs', 'idx_ocr_tokens_hash')"
      );
      return rows[0]?.bytes ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Corpus size and mean document length.
   *
   * Exact aggregates over `ocr_docs`, which is one row per asset with OCR text.
   * At reference scale that is trivial; at 500,000 it is a scan per query and
   * should be maintained incrementally in a counters table instead. Left exact
   * here because a spike measuring the fallback's ranking must not have an
   * approximation in the denominator.
   */
  private async corpusStats(): Promise<{ documentCount: number; averageLength: number }> {
    const rows = await this.driver.all<{ n: number; avg: number | null }>(
      'SELECT COUNT(*) AS n, AVG(token_count) AS avg FROM ocr_docs'
    );
    const row = rows[0];
    return {
      documentCount: row?.n ?? 0,
      // Guard against division by zero in the length-normalisation term.
      averageLength: row?.avg && row.avg > 0 ? row.avg : 1,
    };
  }

  private async documentFrequency(atom: Atom): Promise<number> {
    if (atom.kind === 'term') {
      const rows = await this.driver.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM ocr_tokens WHERE token = ?',
        [atom.text]
      );
      return rows[0]?.n ?? 0;
    }
    const { lower, upper } = prefixRange(atom.text);
    const rows = await this.driver.all<{ n: number }>(
      'SELECT COUNT(DISTINCT hash) AS n FROM ocr_tokens WHERE token >= ? AND token < ?',
      [lower, upper]
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Assembles the scoring query.
   *
   * One `SELECT` per atom, unioned, each tagged with its atom index and carrying
   * its own precomputed idf. A prefix atom sums `tf` across every token in its
   * range and groups by document, which is how FTS5 treats a prefix expression:
   * as one phrase whose frequency is the total of its expansions, not as several
   * independent terms.
   *
   * `HAVING COUNT(DISTINCT atom) = <n>` implements the implicit AND. It has to
   * count distinct atoms rather than rows, because a prefix atom can contribute
   * only one row per document but a document could match several atoms.
   */
  private buildScoringQuery(
    atoms: readonly Atom[],
    weights: readonly number[],
    averageLength: number,
    limit: number
  ): { sql: string; params: SqlParam[] } {
    const params: SqlParam[] = [];
    const branches: string[] = [];

    atoms.forEach((atom, index) => {
      if (atom.kind === 'term') {
        branches.push(
          `SELECT ? AS atom, ? AS weight, hash, tf FROM ocr_tokens WHERE token = ?`
        );
        params.push(index, weights[index] ?? 0, atom.text);
      } else {
        const { lower, upper } = prefixRange(atom.text);
        branches.push(
          `SELECT ? AS atom, ? AS weight, hash, SUM(tf) AS tf
             FROM ocr_tokens WHERE token >= ? AND token < ? GROUP BY hash`
        );
        params.push(index, weights[index] ?? 0, lower, upper);
      }
    });

    // BM25: sum over atoms of idf * tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl)),
    // negated so that ascending order is best-first, as FTS5's bm25() does.
    const sql = `
      WITH postings AS (
        ${branches.join('\n        UNION ALL\n        ')}
      )
      SELECT p.hash AS hash,
             -SUM(
               p.weight * (p.tf * (${BM25_K1} + 1.0)) /
               (p.tf + ${BM25_K1} * (1.0 - ${BM25_B} + ${BM25_B} * d.token_count / ?))
             ) AS score
        FROM postings p
        JOIN ocr_docs d ON d.hash = p.hash
       GROUP BY p.hash
      HAVING COUNT(DISTINCT p.atom) = ?
       ORDER BY score
       LIMIT ?`;

    params.push(averageLength, atoms.length, limit);
    return { sql, params };
  }
}
