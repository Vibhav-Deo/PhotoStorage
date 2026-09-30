/**
 * A JavaScript tokenizer that reproduces FTS5's `unicode61 remove_diacritics 2`
 * closely enough to back the fallback index, with one deliberate difference.
 *
 * ## Why this exists
 *
 * The token-table fallback has to tokenize in JS, because SQLite's tokenizers
 * are only reachable from inside FTS5. For the fallback to be a *substitute*
 * rather than a different product, its tokens have to agree with FTS5's — if
 * they do not, the two indexes answer the same query differently and the
 * fallback cannot be validated against the primary.
 *
 * `unicode61` splits on anything that is not a Unicode letter or digit, folds
 * case, and with `remove_diacritics 2` strips combining marks (the `2` variant,
 * unlike `1`, also handles marks on characters that compose into a single
 * codepoint). NFD-normalizing and dropping `\p{M}` is the same operation.
 *
 * ## The one deliberate difference: CJK
 *
 * `unicode61` classifies Han, Hiragana, and Katakana as alphanumeric, so a run
 * of them becomes a *single* token. Measured against SQLite 3.50.4:
 *
 *     'AAAAAAA Shibuya ward sign 12.50'
 *       -> tokens: 12 | 50 | nrt | sfo | shibuya | sign | AAAAAAA
 *
 * where `AAAAAAA` stands for the whole unbroken CJK run. The consequence is that
 * no substring of CJK OCR text is findable — not even with a prefix query, since
 * the run's only token starts at its first character. For Requirement 5.4 that
 * means OCR of Japanese or Chinese signage indexes but does not retrieve.
 *
 * The fallback splits CJK runs per character instead, which makes substrings
 * findable. This is recorded as a difference rather than hidden, because it means
 * the fallback is *better* than FTS5 on CJK and the two indexes will legitimately
 * disagree there. `tokenize` therefore takes an explicit mode so the probe can
 * ask for FTS5-equivalent behaviour when it is comparing rankings.
 */

/** Han, Hiragana, Katakana, Hangul, and the CJK compatibility blocks. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/** Anything that is not a Unicode letter or digit is a separator, as in unicode61. */
const TOKEN_CHAR = /[\p{L}\p{N}]/u;

export type TokenizeMode =
  /** Match `unicode61 remove_diacritics 2` exactly, CJK runs included. */
  | 'unicode61-equivalent'
  /** As above, but split CJK runs into single characters. */
  | 'cjk-split';

/**
 * Folds to the form FTS5 stores: NFD, combining marks removed, lowercased.
 *
 * Exported because the fallback's *query* path must fold identically to its
 * *index* path. Folding in one place and not the other is the classic way an
 * inverted index silently stops matching.
 */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function tokenize(text: string, mode: TokenizeMode = 'cjk-split'): string[] {
  const folded = fold(text);
  const tokens: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (const char of folded) {
    if (!TOKEN_CHAR.test(char)) {
      flush();
      continue;
    }
    if (mode === 'cjk-split' && CJK.test(char)) {
      // A CJK character is a token on its own, and also terminates whatever
      // Latin run preceded it without a separator.
      flush();
      tokens.push(char);
      continue;
    }
    current += char;
  }
  flush();

  return tokens;
}

/** `{ token -> occurrences }` for one document. */
export function termFrequencies(text: string, mode: TokenizeMode = 'cjk-split'): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of tokenize(text, mode)) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
}

export interface ParsedQuery {
  /** Tokens that must match exactly. */
  readonly terms: readonly string[];
  /** Tokens that match any term with this prefix, from a trailing `*`. */
  readonly prefixes: readonly string[];
}

/**
 * Parses the small subset of FTS5 query syntax the OCR search path actually
 * needs: whitespace-separated terms, with an optional trailing `*` for prefix
 * matching.
 *
 * Boolean operators, `NEAR`, and column filters are out of scope. The design
 * fuses FTS results with vector and metadata signals via reciprocal rank fusion
 * rather than expecting the user to write boolean queries, so supporting them is
 * not what decides whether the fallback is viable.
 */
export function parseQuery(query: string, mode: TokenizeMode = 'cjk-split'): ParsedQuery {
  const terms: string[] = [];
  const prefixes: string[] = [];

  for (const raw of query.split(/\s+/).filter((part) => part.length > 0)) {
    const isPrefix = raw.endsWith('*');
    const tokens = tokenize(isPrefix ? raw.slice(0, -1) : raw, mode);
    if (tokens.length === 0) continue;
    if (isPrefix) {
      // Only the final token of a multi-token word carries the prefix; the
      // earlier ones are complete. 'san-fran*' -> term 'san', prefix 'fran'.
      terms.push(...tokens.slice(0, -1));
      prefixes.push(tokens[tokens.length - 1]!);
    } else {
      terms.push(...tokens);
    }
  }

  return { terms, prefixes };
}

/**
 * Half-open range that selects every token starting with `prefix`.
 *
 * Used instead of `GLOB 'prefix*'` so the lookup is an index range scan on
 * `ocr_tokens`' `(token, hash)` primary key on every SQLite build, with no
 * reliance on the query planner recognising a pattern. The upper bound
 * increments the last code unit, which is the standard trick and is safe here
 * because tokens are already folded and never end at a surrogate boundary that
 * matters for ordering.
 */
export function prefixRange(prefix: string): { readonly lower: string; readonly upper: string } {
  if (prefix.length === 0) {
    throw new Error('prefixRange needs a non-empty prefix');
  }
  const lastIndex = prefix.length - 1;
  const bumped = String.fromCharCode(prefix.charCodeAt(lastIndex) + 1);
  return { lower: prefix, upper: prefix.slice(0, lastIndex) + bumped };
}
