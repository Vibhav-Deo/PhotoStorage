/**
 * A small corpus of the kind of text on-device OCR actually produces, plus the
 * queries a user would type to find it.
 *
 * Requirement 5.4 is "extract text visible in images via on-device OCR and make
 * it searchable". The searchable half is what task 0.2 has to de-risk, so the
 * documents here are shaped like OCR output rather than like prose: fragmentary,
 * mixed case, mixed script, littered with numbers and punctuation, and containing
 * the recognition noise that a real recognizer emits.
 *
 * Each case exists to exercise one property of the index. They are annotated so
 * that a failure points at a cause rather than just lowering a score.
 */

export interface OcrDocument {
  /** Stands in for `assets.hash`. Short and readable so reports are legible. */
  readonly hash: string;
  readonly text: string;
  /** Why this document is in the corpus. */
  readonly why: string;
}

export const DOCUMENTS: readonly OcrDocument[] = [
  {
    hash: 'd01',
    text: 'Café Pergolesi\n1521 Pacific Ave\nSubtotal 11.00  Tax 1.02  TOTAL 12.02\nVISA ****4417',
    why: 'Receipt. Diacritic on a word the user will type without one; amounts with decimal points.',
  },
  {
    hash: 'd02',
    text: 'CAFE DOWNTOWN PARKING GARAGE\nLEVEL 3  SPACE 214\nPAY AT KIOSK',
    why: 'Second "cafe" document, all caps, so a cafe query has to rank rather than just match.',
  },
  {
    hash: 'd03',
    text: 'BOARDING PASS\nSFO -> NRT\nGATE B24  SEAT 31A  GROUP 4\nMARTINEZ/ANA',
    why: 'Airport codes joined by punctuation; the query is a prefix ("board*").',
  },
  {
    hash: 'd04',
    text: 'Whiteboard: Q3 roadmap\n- ingest pipeline\n- reclaim space\n- vector search',
    why: 'Contains "whiteboard", which a naive prefix query for "board*" must NOT match.',
  },
  {
    hash: 'd05',
    text: '東京都渋谷区宇田川町\nSHIBUYA WARD\n03-1234-5678',
    why: 'CJK signage. unicode61 makes the whole CJK run one token, so "渋谷" cannot retrieve it.',
  },
  {
    hash: 'd06',
    text: 'Résumé — Ana Martínez\nSenior Engineer\nreferences available',
    why: 'Multiple diacritics plus an em dash; "resume martinez" must find it.',
  },
  {
    hash: 'd07',
    text: 'PRESCRIPTION\nAMOXICILLIN 500MG\nTAKE 1 CAPSULE 3 TIMES DAILY\nDR. OKONKWO',
    why: 'Screenshot-like medical label; single-term query with exactly one relevant document.',
  },
  {
    hash: 'd08',
    text: 'WIFI\nnetwork: Pergolesi Guest\npassword: espresso2019',
    why: 'Second "Pergolesi" document, so that query has two relevant results to rank.',
  },
  {
    hash: 'd09',
    text: 'Trailhead 0.5 mi\nSTEEP GRADE\nNO BICYCLES\nPacific Crest Trail',
    why: 'Trail sign sharing the token "pacific" with d01, to keep idf from being trivial.',
  },
  {
    hash: 'd10',
    text: 'PARKING\nMON-FRI 8AM-6PM\n2 HOUR LIMIT\nTOW AWAY ZONE',
    why: 'Second "parking" document; time ranges tokenize into digit runs.',
  },
  {
    hash: 'd11',
    text: 'Happy Birthday Amara!!!\n7 today',
    why: 'Trailing punctuation, and token id 0 is "!" in the CLIP vocab — unrelated here, but a reminder that punctuation handling differs per component.',
  },
  {
    hash: 'd12',
    text: 'ingredients: water, sugar, citric acid, natural flavour\nBEST BEFORE 2019-07-04',
    why: 'ISO date in text. Dates in OCR text are not the same signal as assets.captured_at.',
  },
];

export interface SearchCase {
  readonly query: string;
  /** Every document that should be retrieved, in no particular order. */
  readonly relevant: readonly string[];
  /**
   * The document that should rank first, when the corpus makes one clearly best.
   * Omitted where two documents are genuinely equally good, so the harness never
   * penalises a defensible ordering.
   */
  readonly expectedTop?: string;
  /** Documents that a plausible but wrong implementation would return. */
  readonly mustNotMatch?: readonly string[];
  readonly why: string;
}

export const SEARCH_CASES: readonly SearchCase[] = [
  {
    query: 'cafe',
    relevant: ['d01', 'd02'],
    why: 'Diacritic folding in the index: "Café" must be found by "cafe".',
  },
  {
    query: 'café',
    relevant: ['d01', 'd02'],
    why: 'Diacritic folding in the query: the accented form must find the unaccented document too.',
  },
  {
    query: 'resume martinez',
    relevant: ['d06'],
    expectedTop: 'd06',
    why: 'Two folded terms in one document. "Résumé" and "Martínez" both carry marks.',
  },
  {
    query: 'board*',
    relevant: ['d03'],
    expectedTop: 'd03',
    mustNotMatch: ['d04'],
    why: 'Prefix search must anchor at a token start, so "whiteboard" is not a hit.',
  },
  {
    query: 'amoxicillin',
    relevant: ['d07'],
    expectedTop: 'd07',
    why: 'Rare single term. If this fails, nothing is indexed at all.',
  },
  {
    query: 'pergolesi',
    relevant: ['d01', 'd08'],
    why: 'Two relevant documents of very different length, which is what bm25 length normalisation is for.',
  },
  {
    query: 'parking',
    relevant: ['d02', 'd10'],
    why: 'Common term across two documents; checks that ranking is not arbitrary.',
  },
  {
    query: 'nrt',
    relevant: ['d03'],
    expectedTop: 'd03',
    why: 'Token produced by splitting "SFO -> NRT" on punctuation.',
  },
  {
    query: '4417',
    relevant: ['d01'],
    expectedTop: 'd01',
    why: 'Digit run adjacent to masking asterisks. Searching a card fragment is a real behaviour.',
  },
];

/**
 * Kept separate from `SEARCH_CASES` because these are *expected to fail* under
 * FTS5's `unicode61` and expected to pass under the fallback's CJK splitting.
 * Mixing them into the graded set would make the primary index look broken and
 * the fallback look better than it is on the things that matter.
 */
export const CJK_SUBSTRING_CASES: readonly SearchCase[] = [
  {
    query: '渋谷',
    relevant: ['d05'],
    expectedTop: 'd05',
    why: 'Substring of a CJK run. Impossible under unicode61, which emits the run as one token.',
  },
];
