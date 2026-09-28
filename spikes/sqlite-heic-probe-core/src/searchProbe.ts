/**
 * The grading harness for task 0.2's search half.
 *
 * One question, two places it has to be answered:
 *
 * - **Does FTS5 behave the way the design assumes?** A property of SQLite. It can
 *   be answered on any machine, and it is, by `sqlite-fts-reference`.
 * - **Does the SQLite that `expo-sqlite` actually ships expose FTS5 on iOS and
 *   Android?** A property of the shipped native binary. Only a device settles it.
 *
 * Both runs go through `runSearchProbe`, so a divergence between them isolates
 * the runtime rather than the SQL, the corpus, or the grading. That is the same
 * split spike 0.1 used, for the same reason.
 *
 * When FTS5 *is* available the probe builds **both** indexes and compares their
 * rankings. That comparison is the deliverable that makes the fallback
 * trustworthy: it is one thing to write a fallback, and another to have measured
 * that it returns the same documents in the same order as the thing it replaces.
 */

import { CJK_SUBSTRING_CASES, DOCUMENTS, SEARCH_CASES, type SearchCase } from './corpus.ts';
import { detectFts5, type Fts5Capability } from './capability.ts';
import type { SqlDriver } from './driver.ts';
import { Fts5OcrIndex } from './fts5Index.ts';
import type { OcrIndex, OcrIndexKind } from './ocrIndex.ts';
import { TokenTableOcrIndex } from './tokenTableIndex.ts';

/** Generous relative to a 12-document corpus, so nothing is truncated away. */
const SEARCH_LIMIT = 20;

export type Verdict = 'pass' | 'partial' | 'fail';

export interface QueryOutcome {
  readonly query: string;
  readonly why: string;
  readonly retrieved: readonly string[];
  /** Relevant documents that were retrieved, over all relevant documents. */
  readonly recall: number;
  /** Retrieved documents that are not relevant. */
  readonly extra: readonly string[];
  /** Retrieved documents the case explicitly forbids. A hit here is a real defect. */
  readonly forbidden: readonly string[];
  /** Undefined when the case declares no expected top result. */
  readonly topCorrect?: boolean;
  readonly elapsedMs: number;
  readonly error?: string;
}

export interface IndexOutcome {
  readonly kind: OcrIndexKind;
  readonly available: boolean;
  readonly error?: string;
  readonly buildMs: number;
  readonly sizeBytes?: number;
  readonly queries: readonly QueryOutcome[];
  readonly meanQueryMs: number;
  readonly meanRecall: number;
  readonly top1Accuracy: number;
  readonly forbiddenHits: number;
  /** CJK substring cases, reported separately because FTS5 is expected to fail them. */
  readonly cjkSubstring: readonly QueryOutcome[];
  readonly verdict: Verdict;
}

export interface RankingAgreement {
  readonly totalQueries: number;
  /** Queries where both indexes returned the same documents, ignoring order. */
  readonly sameSet: number;
  /** Queries where both returned the same documents in the same order. */
  readonly sameOrder: number;
  readonly disagreements: readonly {
    readonly query: string;
    readonly fts5: readonly string[];
    readonly tokenTable: readonly string[];
  }[];
}

export interface SearchProbeReport {
  readonly driver: string;
  readonly capability: Fts5Capability;
  readonly indexes: readonly IndexOutcome[];
  readonly agreement?: RankingAgreement;
  readonly verdict: Verdict;
  /** Safe to print straight into the spike UI or the terminal. */
  readonly summary: string;
}

export async function runSearchProbe(driver: SqlDriver): Promise<SearchProbeReport> {
  const capability = await detectFts5(driver);

  const indexes: IndexOutcome[] = [];

  if (capability.usable) {
    indexes.push(await exercise(new Fts5OcrIndex(driver)));
  } else {
    indexes.push({
      kind: 'fts5',
      available: false,
      error: capability.notes.join(' | ') || 'FTS5 is not usable on this build',
      buildMs: 0,
      queries: [],
      meanQueryMs: Number.NaN,
      meanRecall: 0,
      top1Accuracy: 0,
      forbiddenHits: 0,
      cjkSubstring: [],
      verdict: 'fail',
    });
  }

  // Always exercised, even when FTS5 works. The fallback is only worth having if
  // it is known to work, and the only moment it is cheap to establish that is
  // before anything depends on either.
  indexes.push(await exercise(new TokenTableOcrIndex(driver)));

  const fts5 = indexes.find((outcome) => outcome.kind === 'fts5');
  const tokenTable = indexes.find((outcome) => outcome.kind === 'token-table');
  const agreement =
    fts5?.available && tokenTable?.available ? compare(fts5, tokenTable) : undefined;

  const verdict = overallVerdict(indexes);

  return {
    driver: driver.name,
    capability,
    indexes,
    agreement,
    verdict,
    summary: describe(driver.name, capability, indexes, agreement, verdict),
  };
}

async function exercise(index: OcrIndex): Promise<IndexOutcome> {
  const buildStarted = Date.now();
  try {
    await index.create();
    await index.index(DOCUMENTS);
  } catch (error) {
    return {
      kind: index.kind,
      available: false,
      error: asMessage(error),
      buildMs: Date.now() - buildStarted,
      queries: [],
      meanQueryMs: Number.NaN,
      meanRecall: 0,
      top1Accuracy: 0,
      forbiddenHits: 0,
      cjkSubstring: [],
      verdict: 'fail',
    };
  }
  const buildMs = Date.now() - buildStarted;

  const queries: QueryOutcome[] = [];
  for (const searchCase of SEARCH_CASES) {
    queries.push(await runCase(index, searchCase));
  }
  const cjkSubstring: QueryOutcome[] = [];
  for (const searchCase of CJK_SUBSTRING_CASES) {
    cjkSubstring.push(await runCase(index, searchCase));
  }

  const withTop = queries.filter((outcome) => outcome.topCorrect !== undefined);
  const meanRecall = average(queries.map((outcome) => outcome.recall));
  const top1Accuracy =
    withTop.length === 0
      ? 1
      : withTop.filter((outcome) => outcome.topCorrect === true).length / withTop.length;
  const forbiddenHits = queries.reduce((total, outcome) => total + outcome.forbidden.length, 0);
  const extras = queries.reduce((total, outcome) => total + outcome.extra.length, 0);
  const errors = queries.filter((outcome) => outcome.error !== undefined).length;

  let verdict: Verdict = 'pass';
  if (errors > 0 || meanRecall < 1 || forbiddenHits > 0) {
    verdict = meanRecall === 0 ? 'fail' : 'partial';
    if (errors === queries.length) verdict = 'fail';
  } else if (extras > 0 || top1Accuracy < 1) {
    verdict = 'partial';
  }

  return {
    kind: index.kind,
    available: true,
    buildMs,
    sizeBytes: await index.sizeBytes(),
    queries,
    meanQueryMs: average(queries.map((outcome) => outcome.elapsedMs)),
    meanRecall,
    top1Accuracy,
    forbiddenHits,
    cjkSubstring,
    verdict,
  };
}

async function runCase(index: OcrIndex, searchCase: SearchCase): Promise<QueryOutcome> {
  const started = Date.now();
  let retrieved: string[] = [];
  let error: string | undefined;
  try {
    const hits = await index.search(searchCase.query, SEARCH_LIMIT);
    retrieved = hits.map((hit) => hit.hash);
  } catch (caught) {
    error = asMessage(caught);
  }
  const elapsedMs = Date.now() - started;

  const relevant = new Set(searchCase.relevant);
  const found = retrieved.filter((hash) => relevant.has(hash));
  const forbidden = retrieved.filter((hash) => searchCase.mustNotMatch?.includes(hash) ?? false);

  return {
    query: searchCase.query,
    why: searchCase.why,
    retrieved,
    recall: relevant.size === 0 ? 1 : found.length / relevant.size,
    extra: retrieved.filter((hash) => !relevant.has(hash)),
    forbidden,
    topCorrect:
      searchCase.expectedTop === undefined
        ? undefined
        : retrieved[0] === searchCase.expectedTop,
    elapsedMs,
    error,
  };
}

function compare(fts5: IndexOutcome, tokenTable: IndexOutcome): RankingAgreement {
  let sameSet = 0;
  let sameOrder = 0;
  const disagreements: {
    query: string;
    fts5: readonly string[];
    tokenTable: readonly string[];
  }[] = [];

  fts5.queries.forEach((left, position) => {
    const right = tokenTable.queries[position];
    if (right === undefined) return;
    const orderMatches = left.retrieved.join(',') === right.retrieved.join(',');
    const setMatches =
      left.retrieved.length === right.retrieved.length &&
      [...left.retrieved].sort().join(',') === [...right.retrieved].sort().join(',');
    if (setMatches) sameSet++;
    if (orderMatches) sameOrder++;
    else disagreements.push({ query: left.query, fts5: left.retrieved, tokenTable: right.retrieved });
  });

  return {
    totalQueries: fts5.queries.length,
    sameSet,
    sameOrder,
    disagreements,
  };
}

function overallVerdict(indexes: readonly IndexOutcome[]): Verdict {
  // Requirement 5.4 needs *an* index, so the overall verdict is the better of
  // the two rather than the worse. Recording which one carried it is the job of
  // the summary.
  const verdicts = indexes.map((outcome) => outcome.verdict);
  if (verdicts.includes('pass')) return 'pass';
  if (verdicts.includes('partial')) return 'partial';
  return 'fail';
}

function describe(
  driverName: string,
  capability: Fts5Capability,
  indexes: readonly IndexOutcome[],
  agreement: RankingAgreement | undefined,
  verdict: Verdict
): string {
  const lines: string[] = [];
  lines.push(`${driverName} · SQLite ${capability.sqliteVersion} · verdict ${verdict.toUpperCase()}`);
  lines.push(
    `FTS5: compile flag ${capability.declaresFts5 ? 'present' : 'ABSENT'}, ` +
      `design DDL ${capability.createsDesignTable ? 'ok' : 'FAILED'}, ` +
      `diacritic folding ${capability.foldsDiacritics ? 'ok' : 'FAILED'}, ` +
      `bm25 ${capability.hasBm25 ? 'ok' : 'FAILED'}, ` +
      `prefix ${capability.supportsPrefixQuery ? 'ok' : 'FAILED'}`
  );

  for (const outcome of indexes) {
    if (!outcome.available) {
      lines.push(`${outcome.kind}: unavailable — ${outcome.error ?? 'unknown reason'}`);
      continue;
    }
    lines.push(
      `${outcome.kind}: ${outcome.verdict} · recall ${pct(outcome.meanRecall)} · ` +
        `top-1 ${pct(outcome.top1Accuracy)} · forbidden hits ${outcome.forbiddenHits} · ` +
        `build ${outcome.buildMs} ms · mean query ${outcome.meanQueryMs.toFixed(1)} ms` +
        (outcome.sizeBytes === undefined ? '' : ` · ${outcome.sizeBytes} bytes`)
    );
    const cjk = outcome.cjkSubstring[0];
    if (cjk !== undefined) {
      lines.push(
        `  CJK substring "${cjk.query}": ${cjk.recall === 1 ? 'retrieved' : 'NOT retrieved'} ` +
          `(expected: FTS5 cannot, token-table can)`
      );
    }
  }

  if (agreement !== undefined) {
    lines.push(
      `fallback vs FTS5: same result set on ${agreement.sameSet}/${agreement.totalQueries} queries, ` +
        `same order on ${agreement.sameOrder}/${agreement.totalQueries}`
    );
    for (const disagreement of agreement.disagreements) {
      lines.push(
        `  "${disagreement.query}" fts5=[${disagreement.fts5.join(' ')}] ` +
          `token=[${disagreement.tokenTable.join(' ')}]`
      );
    }
  }

  for (const note of capability.notes) lines.push(`note: ${note}`);

  return lines.join('\n');
}

function average(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function pct(value: number): string {
  return Number.isNaN(value) ? '—' : `${(value * 100).toFixed(0)}%`;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
