/**
 * The schema itself: what it creates, and whether the numbers embedded in its partial
 * indexes still mean what `states.ts` says they mean.
 *
 * The partial index assertions are the point of this file. `WHERE remote_state <> 2` is
 * correct only while `RemoteState.Verified` is 2, and if that ever changed the index would
 * keep working while indexing the complement of what it claims — every verified asset, none
 * of the pending ones. Nothing would throw. Search and upload would just quietly consult the
 * wrong set of rows. So the literal in the DDL is compared against the constant it encodes.
 */

import { describe, expect, it } from 'vitest';

import { MIGRATIONS, OCR_FTS_DDL, SCHEMA_VERSION } from './schema.ts';
import { JobState, LocalState, RemoteState } from '../states.ts';

/** Every statement of every migration, flattened, for substring assertions. */
const ALL_STATEMENTS = MIGRATIONS.flatMap((migration) => migration.statements);

function statementContaining(fragment: string): string {
  const matches = ALL_STATEMENTS.filter((statement) => statement.includes(fragment));
  expect(matches, `expected exactly one statement containing ${fragment}`).toHaveLength(1);
  return matches[0] ?? '';
}

describe('migration list', () => {
  it('is contiguous, ascending, and starts at 1', () => {
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual(
      MIGRATIONS.map((_, index) => index + 1),
    );
  });

  it('reports the last version as SCHEMA_VERSION', () => {
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length);
  });

  it('contains no transaction control, which the runner owns', () => {
    for (const statement of ALL_STATEMENTS) {
      expect(statement).not.toMatch(/^\s*(?:begin|commit|end|rollback)\b/i);
    }
  });
});

describe('partial index predicates match the persisted state values', () => {
  it('idx_assets_timeline excludes tombstones', () => {
    // Tombstones are never hard-deleted (Req 8.3), so without this predicate the timeline —
    // the hottest query in the app — scans every asset the user ever deleted.
    expect(statementContaining('idx_assets_timeline')).toBe(
      'CREATE INDEX idx_assets_timeline ON assets(captured_at DESC) WHERE deleted_at IS NULL',
    );
  });

  it('idx_assets_pending means "not verified"', () => {
    expect(statementContaining('idx_assets_pending')).toContain(
      `WHERE remote_state <> ${RemoteState.Verified}`,
    );
    expect(RemoteState.Verified).toBe(2);
  });

  it('idx_assets_purgable means "purge eligible"', () => {
    expect(statementContaining('idx_assets_purgable')).toContain(
      `WHERE local_state = ${LocalState.PurgeEligible}`,
    );
    expect(LocalState.PurgeEligible).toBe(2);
  });

  it('idx_local_unhashed means "hash pending"', () => {
    // local_assets.hash_state has no constant in states.ts yet — it is device-scoped and
    // never syncs, so task 7.1 owns it. 0 = pending is the design's value.
    expect(statementContaining('idx_local_unhashed')).toBe(
      'CREATE INDEX idx_local_unhashed ON local_assets(hash_state) WHERE hash_state = 0',
    );
  });

  it('idx_jobs_runnable means "pending or failed"', () => {
    // Not `done` and not `dead`, which are the two states that accumulate forever. `running` is
    // excluded too, which is what makes lease reclamation the un-indexed path in
    // `queue/jobQueue.ts` — a renumbering that pulled `running` into this predicate would put
    // every in-flight job back in the claim query's way.
    expect(statementContaining('idx_jobs_runnable')).toContain(
      `WHERE state IN (${JobState.Pending}, ${JobState.Failed})`,
    );
    expect(JobState.Pending).toBe(0);
    expect(JobState.Failed).toBe(3);
  });
});

describe('ocr_fts', () => {
  it('keeps the tokenizer options spike 0.2 verified', () => {
    // remove_diacritics 2 needs SQLite 3.27+ and is what makes `cafe` find `Café`. The
    // capability detector probes this exact string, so the check and the schema cannot drift.
    expect(OCR_FTS_DDL).toContain("tokenize='unicode61 remove_diacritics 2'");
    expect(OCR_FTS_DDL).toContain('hash UNINDEXED');
    expect(ALL_STATEMENTS).toContain(OCR_FTS_DDL);
  });
});
