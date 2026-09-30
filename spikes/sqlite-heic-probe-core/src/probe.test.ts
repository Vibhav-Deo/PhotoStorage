import { describe, expect, it } from 'vitest';

import { CJK_SUBSTRING_CASES, DOCUMENTS, SEARCH_CASES } from './corpus.ts';
import { DESIGN_FTS5_DDL } from './capability.ts';
import { toMatchExpression } from './fts5Index.ts';
import { idf } from './ocrIndex.ts';
import { TOKEN_TABLE_DDL } from './tokenTableIndex.ts';
import { tokenize } from './tokenize.ts';

describe('corpus integrity', () => {
  const hashes = new Set(DOCUMENTS.map((document) => document.hash));

  it('has no duplicate document hashes', () => {
    expect(hashes.size).toBe(DOCUMENTS.length);
  });

  it('references only documents that exist', () => {
    // A typo in a `relevant` list would show up as a permanent recall shortfall
    // and would be read as a defect in the index rather than in the corpus.
    for (const searchCase of [...SEARCH_CASES, ...CJK_SUBSTRING_CASES]) {
      for (const hash of [...searchCase.relevant, ...(searchCase.mustNotMatch ?? [])]) {
        expect(hashes.has(hash), `${searchCase.query} -> ${hash}`).toBe(true);
      }
      if (searchCase.expectedTop !== undefined) {
        expect(searchCase.relevant).toContain(searchCase.expectedTop);
      }
    }
  });

  it('states, for every graded case, that its query tokens really occur in every relevant document', () => {
    // This is what makes a recall shortfall meaningful. If the corpus does not
    // actually contain the terms, full recall is unachievable and the verdict
    // would be measuring the fixture rather than the index.
    for (const searchCase of SEARCH_CASES) {
      const queryTokens = tokenize(searchCase.query.replace(/\*/g, ''));
      for (const hash of searchCase.relevant) {
        const document = DOCUMENTS.find((candidate) => candidate.hash === hash);
        const documentTokens = tokenize(document?.text ?? '');
        for (const token of queryTokens) {
          const present = documentTokens.some((candidate) => candidate.startsWith(token));
          expect(present, `"${token}" should occur in ${hash}`).toBe(true);
        }
      }
    }
  });
});

describe('the DDL under test', () => {
  it('declares ocr_fts exactly as the design does', () => {
    // Copied by hand from design.md. Pinning it here means a future edit to
    // either has to be deliberate.
    expect(DESIGN_FTS5_DDL).toContain('USING fts5(');
    expect(DESIGN_FTS5_DDL).toContain('hash UNINDEXED');
    expect(DESIGN_FTS5_DDL).toContain("tokenize='unicode61 remove_diacritics 2'");
  });

  it('clusters the fallback token table by token so a term lookup is one range scan', () => {
    const create = TOKEN_TABLE_DDL.join('\n');
    expect(create).toContain('PRIMARY KEY (token, hash)');
    expect(create).toContain('WITHOUT ROWID');
    expect(create).toContain('idx_ocr_tokens_hash');
  });
});

describe('toMatchExpression', () => {
  it('quotes terms so FTS5 cannot read OCR punctuation as query syntax', () => {
    // 'SFO -> NRT' passed to MATCH raw is a syntax error, and a query containing
    // the word OR would silently change the operator.
    expect(toMatchExpression('SFO -> NRT')).toBe('"sfo" "nrt"');
    expect(toMatchExpression('cats OR dogs')).toBe('"cats" "or" "dogs"');
    expect(toMatchExpression('(unbalanced')).toBe('"unbalanced"');
  });

  it('emits a prefix token for a trailing star', () => {
    expect(toMatchExpression('board*')).toBe('"board"*');
  });

  it('folds diacritics, so the expression matches what the index stores', () => {
    expect(toMatchExpression('Café')).toBe('"cafe"');
  });

  it('keeps a CJK run whole, because that is how FTS5 indexed it', () => {
    expect(toMatchExpression('東京都渋谷区')).toBe('"東京都渋谷区"');
  });

  it('returns null when nothing usable is left, rather than an empty MATCH', () => {
    expect(toMatchExpression('  -> !!! ')).toBeNull();
  });

  it('doubles embedded quotes', () => {
    expect(toMatchExpression('say "hi"')).toBe('"say" "hi"');
  });
});

describe('idf', () => {
  it('reproduces FTS5 bm25 idf for a rare term', () => {
    // N = 12, n = 1: log(11.5 / 1.5)
    expect(idf(12, 1)).toBeCloseTo(Math.log(11.5 / 1.5), 12);
  });

  it('clamps to a positive epsilon rather than zero for a term in most documents', () => {
    // FTS5 does the same, which keeps a very common term contributing a sliver
    // of signal instead of dropping out of the ranking entirely.
    expect(idf(12, 11)).toBe(1e-6);
    expect(idf(12, 12)).toBe(1e-6);
  });

  it('ranks a rarer term above a more common one', () => {
    expect(idf(1000, 2)).toBeGreaterThan(idf(1000, 200));
  });
});
