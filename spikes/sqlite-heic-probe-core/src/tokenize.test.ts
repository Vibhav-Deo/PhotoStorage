import { describe, expect, it } from 'vitest';

import { fold, parseQuery, prefixRange, termFrequencies, tokenize } from './tokenize.ts';

describe('fold', () => {
  it('strips combining marks and lowercases, matching remove_diacritics 2', () => {
    expect(fold('Café')).toBe('cafe');
    expect(fold('Résumé')).toBe('resume');
    expect(fold('Martínez')).toBe('martinez');
    // Precomposed and decomposed inputs must land on the same string, or the
    // index and the query fold differently and matching silently stops.
    expect(fold('cafe\u0301')).toBe(fold('caf\u00e9'));
  });
});

describe('tokenize in unicode61-equivalent mode', () => {
  it('reproduces the token set SQLite 3.50 produced for the same input', () => {
    // Captured by executing the design's ocr_fts declaration against SQLite
    // 3.50.4 and reading fts5vocab. If this ever drifts, the fallback has
    // stopped being comparable to the primary.
    const tokens = tokenize(
      '東京都渋谷区の看板 Shibuya ward sign 12.50 SFO-NRT',
      'unicode61-equivalent'
    );
    expect([...tokens].sort()).toEqual(
      ['12', '50', 'nrt', 'sfo', 'shibuya', 'sign', 'ward', '東京都渋谷区の看板'].sort()
    );
  });

  it('keeps a CJK run as a single token, which is why CJK substrings cannot be found', () => {
    expect(tokenize('東京都渋谷区', 'unicode61-equivalent')).toEqual(['東京都渋谷区']);
  });
});

describe('tokenize in cjk-split mode', () => {
  it('splits CJK runs per character so substrings become findable', () => {
    expect(tokenize('東京都渋谷区', 'cjk-split')).toEqual(['東', '京', '都', '渋', '谷', '区']);
  });

  it('treats a CJK character as a boundary for an adjacent Latin run', () => {
    expect(tokenize('ab東cd', 'cjk-split')).toEqual(['ab', '東', 'cd']);
  });

  it('leaves Latin text identical to unicode61 mode', () => {
    const text = 'BOARDING PASS SFO -> NRT gate B24';
    expect(tokenize(text, 'cjk-split')).toEqual(tokenize(text, 'unicode61-equivalent'));
  });
});

describe('termFrequencies', () => {
  it('counts repeats rather than deduplicating', () => {
    expect(termFrequencies('cafe Cafe CAFÉ')).toEqual(new Map([['cafe', 3]]));
  });
});

describe('parseQuery', () => {
  it('separates a trailing star into a prefix', () => {
    expect(parseQuery('board*')).toEqual({ terms: [], prefixes: ['board'] });
  });

  it('applies the star only to the final token of a hyphenated word', () => {
    expect(parseQuery('san-fran*')).toEqual({ terms: ['san'], prefixes: ['fran'] });
  });

  it('folds query terms the same way the index folds documents', () => {
    expect(parseQuery('Café RÉSUMÉ')).toEqual({ terms: ['cafe', 'resume'], prefixes: [] });
  });

  it('drops punctuation-only input rather than producing an empty term', () => {
    expect(parseQuery('  ->  !!! ')).toEqual({ terms: [], prefixes: [] });
  });
});

describe('prefixRange', () => {
  it('produces a half-open range covering exactly the tokens with that prefix', () => {
    const { lower, upper } = prefixRange('board');
    expect(lower).toBe('board');
    expect(upper).toBe('boare');
    // The range must include the prefix itself and every extension of it, and
    // exclude the next sibling.
    expect('board' >= lower && 'board' < upper).toBe(true);
    expect('boarding' >= lower && 'boarding' < upper).toBe(true);
    expect('boardzzz' >= lower && 'boardzzz' < upper).toBe(true);
    expect('boare' >= lower && 'boare' < upper).toBe(false);
    // And it must not reach words that merely contain the prefix.
    expect('whiteboard' >= lower && 'whiteboard' < upper).toBe(false);
  });

  it('rejects an empty prefix instead of producing a range over everything', () => {
    expect(() => prefixRange('')).toThrow();
  });
});
