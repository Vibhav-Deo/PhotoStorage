/**
 * Off-device half of task 0.2's search question.
 *
 *     npm run reference
 *
 * Prints the graded report, then the tokenizer's actual output and the per-query
 * detail, because those are what make a number in the summary interpretable.
 *
 * Exits non-zero if neither index can serve Requirement 5.4, so this is usable as
 * a check rather than only as something to read.
 */

import {
  runSearchProbe,
  type IndexOutcome,
  type SearchProbeReport,
} from '../sqlite-heic-probe-core/src/index.ts';
import { NodeSqliteDriver } from './nodeSqliteDriver.ts';

async function main(): Promise<void> {
  const driver = new NodeSqliteDriver();
  let report: SearchProbeReport;
  try {
    report = await runSearchProbe(driver);
  } finally {
    driver.close();
  }

  console.log('='.repeat(78));
  console.log(report.summary);
  console.log('='.repeat(78));

  console.log('\nTokenizer output for the probe string');
  console.log('  (this is unicode61 remove_diacritics 2 as the library actually implements it)');
  console.log(`  ${report.capability.probeTokens.join(' | ') || 'unavailable'}`);

  console.log('\nCompile options mentioning FTS or Unicode');
  console.log(
    `  ${report.capability.compileOptions.filter((option) => /FTS|UNICODE|ICU/i.test(option)).join(' ') || 'none'}`
  );

  for (const outcome of report.indexes) {
    printIndex(outcome);
  }

  if (report.indexes.every((outcome) => outcome.verdict === 'fail')) {
    process.exitCode = 1;
  }
}

function printIndex(outcome: IndexOutcome): void {
  console.log(`\n--- ${outcome.kind} ---`);
  if (!outcome.available) {
    console.log(`  unavailable: ${outcome.error ?? 'unknown'}`);
    return;
  }
  for (const query of [...outcome.queries, ...outcome.cjkSubstring]) {
    const flag = query.error
      ? 'ERR '
      : query.forbidden.length > 0
        ? 'BAD '
        : query.recall === 1
          ? 'ok  '
          : 'MISS';
    console.log(
      `  ${flag} ${query.query.padEnd(18)} -> [${query.retrieved.join(' ')}]` +
        `  recall ${(query.recall * 100).toFixed(0)}%` +
        (query.error ? `  ${query.error}` : '')
    );
    if (query.forbidden.length > 0) {
      console.log(`       forbidden matches: ${query.forbidden.join(' ')}  (${query.why})`);
    }
  }
}

await main();
