/**
 * The durable job queue.
 *
 * Three things are actually being tested here, and the rest is scaffolding around them.
 *
 * **Exclusivity.** A claim must hand a job to one worker. This is checked twice: once across two
 * async workers sharing one connection, and once across two separate connections to the same
 * file, because those are different mechanisms — the first relies on the claim being a single
 * statement, the second on SQLite's write lock. A queue that is exclusive in one and not the
 * other is a queue that uploads some items twice.
 *
 * **Resumption.** `killedRunnerLosesNoWork` is the test the plan asks for by name: a runner is
 * killed mid-stage, exactly as a process death leaves things — no rollback, no release, no
 * chance to record anything — and afterwards every unit of work must have completed exactly
 * once. Not "once or more". A stage that runs twice re-uploads bytes and re-derives images, and
 * Requirement 1.9 says resuming skips work that is already done.
 *
 * **Giving up correctly.** Five attempts, then `dead` with the reason retained. Including the
 * case where nothing ever reports a failure because the job keeps killing the process, which is
 * the one that would otherwise loop forever.
 *
 * The clock is injected throughout, so the backoff and lease-expiry tests assert on schedules
 * measured in minutes without waiting for any of it.
 */

import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { applyConnectionPragmas, migrate } from '../db/migrate.ts';
import { NodeSqliteDriver } from '../db/nodeSqliteDriver.ts';
import type { SqlDriver } from '../db/driver.ts';
import { IngestStage, JobState } from '../states.ts';
import {
  DEFAULT_LEASE_MS,
  InvalidJobSpecError,
  JobLeaseLostError,
  MAX_JOB_ATTEMPTS,
  claim,
  complete,
  deadLetters,
  enqueue,
  enqueueOnce,
  fail,
  heartbeat,
  jobById,
  jobCounts,
  reapAbandoned,
  type Clock,
  type Job,
} from './jobQueue.ts';

const T0 = 1_700_000_000_000;

/** A clock a test drives by hand. Nothing here ever waits for real time. */
class ManualClock implements Clock {
  private current: number;

  constructor(start = T0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(instant: number): void {
    this.current = instant;
  }
}

/** Jitter pinned mid-interval, so every scheduled retry in these tests is an exact number. */
const midJitter = () => 0.5;

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

let driver: NodeSqliteDriver;
let clock: ManualClock;

async function open(dbPath?: string): Promise<NodeSqliteDriver> {
  const opened = new NodeSqliteDriver(dbPath === undefined ? {} : { path: dbPath });
  await applyConnectionPragmas(opened);
  await migrate(opened);
  return opened;
}

beforeEach(async () => {
  driver = await open();
  clock = new ManualClock();
});

afterEach(() => {
  driver.close();
});

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

describe('enqueue', () => {
  it('writes a pending job that is runnable now', async () => {
    const id = await enqueue(
      driver,
      { kind: IngestStage.Hash, localId: 'ios-1', priority: 7 },
      { clock },
    );

    expect(await jobById(driver, id)).toEqual({
      id,
      kind: IngestStage.Hash,
      hash: null,
      localId: 'ios-1',
      priority: 7,
      state: JobState.Pending,
      attempts: 0,
      nextAttemptAt: T0,
      lastError: null,
      createdAt: T0,
    });
  });

  it('always writes next_attempt_at, which the claim query requires', async () => {
    // The column is nullable, and a NULL never satisfies `next_attempt_at <= now`. A job
    // enqueued without one would look pending forever and appear in no error view either.
    await enqueue(driver, { kind: IngestStage.Scan }, { clock });
    const rows = await driver.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM jobs WHERE next_attempt_at IS NULL',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('defers a job with a future runAt until its time', async () => {
    await enqueue(driver, { kind: IngestStage.Verify, hash: 'a', runAt: T0 + 5_000 }, { clock });

    expect(await claim(driver, { clock })).toBeNull();
    clock.advance(5_000);
    expect(must(await claim(driver, { clock }), 'the deferred job').kind).toBe(IngestStage.Verify);
  });

  it('refuses a kind that is not a pipeline stage', async () => {
    await expect(enqueue(driver, { kind: 99 as IngestStage }, { clock })).rejects.toThrow(
      InvalidJobSpecError,
    );
  });
});

describe('enqueueOnce', () => {
  const hashJob = { kind: IngestStage.Hash, localId: 'ios-1' };

  it('inserts once and then recognises the same job', async () => {
    const first = await enqueueOnce(driver, hashJob, { clock });
    const second = await enqueueOnce(driver, hashJob, { clock });

    expect(first.inserted).toBe(true);
    expect(second).toEqual({ id: null, inserted: false });
    expect((await jobCounts(driver)).pending).toBe(1);
  });

  it('treats two absent targets as the same target', async () => {
    // A resumed Scan is about the library as a whole and has no target. Without NULL-safe
    // comparison every resume would add another scan.
    await enqueueOnce(driver, { kind: IngestStage.Scan }, { clock });
    expect((await enqueueOnce(driver, { kind: IngestStage.Scan }, { clock })).inserted).toBe(false);
  });

  it('distinguishes targets and kinds', async () => {
    await enqueueOnce(driver, hashJob, { clock });
    expect(
      (await enqueueOnce(driver, { kind: IngestStage.Hash, localId: 'ios-2' }, { clock })).inserted,
    ).toBe(true);
    expect(
      (await enqueueOnce(driver, { kind: IngestStage.Derive, localId: 'ios-1' }, { clock }))
        .inserted,
    ).toBe(true);
  });

  it('skips work that is already done, which is what resuming means', async () => {
    await enqueueOnce(driver, hashJob, { clock });
    await complete(driver, must(await claim(driver, { clock }), 'the enqueued job'));

    expect((await enqueueOnce(driver, hashJob, { clock })).inserted).toBe(false);
  });

  it('can be narrowed so a legitimate re-run is allowed', async () => {
    // Re-embedding after a model change (Requirement 5.9) needs a second Embed job for a hash
    // whose first one succeeded.
    const embed = { kind: IngestStage.Embed, hash: 'a' };
    await enqueueOnce(driver, embed, { clock });
    await complete(driver, must(await claim(driver, { clock }), 'the embed job'));

    const again = await enqueueOnce(driver, embed, {
      clock,
      skipIfIn: [JobState.Pending, JobState.Running, JobState.Failed],
    });
    expect(again.inserted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

describe('claim', () => {
  it('returns null on an empty queue', async () => {
    expect(await claim(driver, { clock })).toBeNull();
  });

  it('takes the lowest priority number first', async () => {
    await enqueue(driver, { kind: IngestStage.Hash, priority: 5 }, { clock });
    await enqueue(driver, { kind: IngestStage.Derive, priority: 1 }, { clock });
    await enqueue(driver, { kind: IngestStage.Verify, priority: 9 }, { clock });

    const order: IngestStage[] = [];
    for (let index = 0; index < 3; index += 1) {
      order.push(must(await claim(driver, { clock }), 'a job').kind);
    }
    expect(order).toEqual([IngestStage.Derive, IngestStage.Hash, IngestStage.Verify]);
  });

  it('marks the claim running, increments attempts, and writes the lease deadline', async () => {
    await enqueue(driver, { kind: IngestStage.Hash, localId: 'ios-1' }, { clock });
    const job = must(await claim(driver, { clock, leaseMs: 30_000 }), 'a job');

    expect(job.state).toBe(JobState.Running);
    expect(job.attempts).toBe(1);
    expect(job.nextAttemptAt).toBe(T0 + 30_000);
  });

  it('restricts to the requested kinds, so a pool can serve one stage', async () => {
    // This is how the design's per-stage concurrency is expressed: the queue filters, the
    // runner sizes the pool. Priority deliberately favours the job that is filtered out.
    await enqueue(driver, { kind: IngestStage.Embed, hash: 'a', priority: 1 }, { clock });
    await enqueue(driver, { kind: IngestStage.UploadOriginal, hash: 'b', priority: 9 }, { clock });

    const job = must(await claim(driver, { clock, kinds: [IngestStage.UploadOriginal] }), 'a job');
    expect(job.kind).toBe(IngestStage.UploadOriginal);
  });

  it('claims nothing when asked for no kinds, which is how a paused pool idles', async () => {
    await enqueue(driver, { kind: IngestStage.Hash }, { clock });
    expect(await claim(driver, { clock, kinds: [] })).toBeNull();
    expect((await jobCounts(driver)).pending).toBe(1);
  });

  it('refuses a lease that is already expired when granted', async () => {
    await expect(claim(driver, { clock, leaseMs: 0 })).rejects.toThrow(InvalidJobSpecError);
  });

  it('hands each job to exactly one of several workers sharing a connection', async () => {
    for (let index = 0; index < 6; index += 1) {
      await enqueue(driver, { kind: IngestStage.Hash, localId: `ios-${String(index)}` }, { clock });
    }

    // Nothing is completed, so every claim must come from the six pending rows and every
    // subsequent claim must find the queue empty rather than re-issuing a held job.
    const claims = await Promise.all([
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
      claim(driver, { clock }),
    ]);

    const ids = claims.filter((job): job is Job => job !== null).map((job) => job.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect((await jobCounts(driver)).running).toBe(6);
  });

  it('hands each job to exactly one worker across separate connections', async () => {
    // A different mechanism from the test above: two connections rely on SQLite's own write
    // lock rather than on statement atomicity within one connection. The importer runs this
    // way, and so does the app when a background upload task overlaps the foreground process.
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'photo-archive-queue-'));
    const dbPath = path.join(dir, 'queue.db');
    const writer = await open(dbPath);
    const other = await open(dbPath);
    try {
      for (let index = 0; index < 5; index += 1) {
        await enqueue(
          writer,
          { kind: IngestStage.UploadOriginal, hash: `h${String(index)}` },
          { clock },
        );
      }

      const ids: number[] = [];
      for (const connection of [writer, other, writer, other, writer, other, writer]) {
        const job = await claim(connection, { clock });
        if (job !== null) ids.push(job.id);
      }

      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
    } finally {
      writer.close();
      other.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('never issues one job twice, over any queue shape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 200 }), { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        async (priorities, workers) => {
          const isolated = await open();
          try {
            for (const [index, priority] of priorities.entries()) {
              await enqueue(
                isolated,
                { kind: IngestStage.Hash, localId: `ios-${String(index)}`, priority },
                { clock },
              );
            }

            const ids: number[] = [];
            let progressed = true;
            while (progressed) {
              progressed = false;
              for (let worker = 0; worker < workers; worker += 1) {
                const job = await claim(isolated, { clock });
                if (job !== null) {
                  ids.push(job.id);
                  progressed = true;
                }
              }
            }

            expect(ids).toHaveLength(priorities.length);
            expect(new Set(ids).size).toBe(priorities.length);
          } finally {
            isolated.close();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

describe('complete', () => {
  it('is terminal and clears the error from the failed attempt', async () => {
    await enqueue(driver, { kind: IngestStage.Hash, localId: 'ios-1' }, { clock });
    const first = must(await claim(driver, { clock }), 'a job');
    await fail(driver, first, new Error('network went away'), { clock, random: midJitter });

    clock.advance(60_000);
    const retry = must(await claim(driver, { clock }), 'the retry');
    await complete(driver, retry);

    const done = must(await jobById(driver, retry.id), 'the job');
    expect(done.state).toBe(JobState.Done);
    expect(done.lastError).toBeNull();
    expect(done.nextAttemptAt).toBeNull();
    expect(await claim(driver, { clock })).toBeNull();
  });
});

describe('fail', () => {
  it('schedules a retry that grows, and is not claimable until it arrives', async () => {
    await enqueue(driver, { kind: IngestStage.UploadOriginal, hash: 'a' }, { clock });

    const delays: number[] = [];
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt += 1) {
      const job = must(await claim(driver, { clock }), `claim ${String(attempt)}`);
      expect(job.attempts).toBe(attempt);

      const outcome = await fail(driver, job, new Error('503 from storage'), {
        clock,
        random: midJitter,
      });
      expect(outcome.deadLettered).toBe(false);

      const retryAt = must(outcome.nextAttemptAt, 'a scheduled retry');
      delays.push(retryAt - clock.now());

      // One millisecond short of the retry time the job must stay put; the backoff is the
      // only thing giving the failing condition time to clear.
      clock.set(retryAt - 1);
      expect(await claim(driver, { clock })).toBeNull();
      clock.set(retryAt);
    }

    // Equal jitter at the midpoint: three quarters of the un-jittered ceiling, doubling.
    expect(delays).toEqual([750, 1_500, 3_000, 6_000]);
  });

  it('records the error class, not just the message', async () => {
    // last_error is what the per-item error view shows, and the class is often the part that
    // tells a user whether retrying could possibly help.
    await enqueue(driver, { kind: IngestStage.Verify, hash: 'a' }, { clock });
    const job = must(await claim(driver, { clock }), 'a job');
    await fail(driver, job, new TypeError('not a buffer'), { clock, random: midJitter });

    expect(must(await jobById(driver, job.id), 'the job').lastError).toBe(
      'TypeError: not a buffer',
    );
  });

  it('dead-letters after five attempts and keeps the reason', async () => {
    await enqueue(driver, { kind: IngestStage.UploadOriginal, hash: 'a' }, { clock });

    let jobId = 0;
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const job = must(await claim(driver, { clock }), `claim ${String(attempt)}`);
      jobId = job.id;
      const outcome = await fail(driver, job, new Error('permission denied'), {
        clock,
        random: midJitter,
      });

      if (attempt < MAX_JOB_ATTEMPTS) {
        clock.set(must(outcome.nextAttemptAt, 'a scheduled retry'));
      } else {
        expect(outcome).toEqual({ deadLettered: true, attempts: 5, nextAttemptAt: null });
      }
    }

    const dead = must(await jobById(driver, jobId), 'the job');
    expect(dead.state).toBe(JobState.Dead);
    expect(dead.nextAttemptAt).toBeNull();
    expect(dead.lastError).toBe('Error: permission denied');

    // Out of the runnable index for good. Nothing was dropped — something stopped retrying.
    clock.advance(365 * 24 * 60 * 60 * 1_000);
    expect(await claim(driver, { clock })).toBeNull();
    expect((await deadLetters(driver)).map((job) => job.id)).toEqual([jobId]);
  });
});

// ---------------------------------------------------------------------------
// Leases: reclamation and fencing
// ---------------------------------------------------------------------------

describe('lease', () => {
  it('keeps a held job out of reach until the lease expires', async () => {
    await enqueue(driver, { kind: IngestStage.Derive, hash: 'a' }, { clock });
    const held = must(await claim(driver, { clock, leaseMs: 10_000 }), 'a job');

    clock.advance(9_999);
    expect(await claim(driver, { clock })).toBeNull();
    expect(must(await jobById(driver, held.id), 'the job').state).toBe(JobState.Running);
  });

  it('returns an abandoned job to the queue once the lease expires', async () => {
    await enqueue(driver, { kind: IngestStage.Derive, hash: 'a' }, { clock });
    const held = must(await claim(driver, { clock, leaseMs: 10_000 }), 'a job');

    clock.advance(10_000);
    const reclaimed = must(await claim(driver, { clock }), 'the reclaimed job');

    expect(reclaimed.id).toBe(held.id);
    expect(reclaimed.attempts).toBe(2);
  });

  it('prefers genuinely runnable work over reclaiming an expired lease', async () => {
    // The reclaim query cannot use idx_jobs_runnable, because that index excludes `running`.
    // Running it only when the indexed query came back empty is what keeps the scan off the
    // hot path.
    await enqueue(driver, { kind: IngestStage.Hash, localId: 'stalled', priority: 1 }, { clock });
    const stalled = must(await claim(driver, { clock, leaseMs: 1_000 }), 'the first job');
    await enqueue(driver, { kind: IngestStage.Hash, localId: 'fresh', priority: 50 }, { clock });

    clock.advance(1_000);
    const next = must(await claim(driver, { clock }), 'a job');
    expect(next.localId).toBe('fresh');

    const after = must(await claim(driver, { clock }), 'the reclaimed job');
    expect(after.id).toBe(stalled.id);
  });

  it('extends on heartbeat without spending an attempt', async () => {
    await enqueue(driver, { kind: IngestStage.Hash, localId: 'big-video' }, { clock });
    const job = must(await claim(driver, { clock, leaseMs: 1_000 }), 'a job');

    clock.advance(900);
    const beating = await heartbeat(driver, job, { clock, leaseMs: 1_000 });
    expect(beating.attempts).toBe(job.attempts);
    expect(beating.nextAttemptAt).toBe(T0 + 1_900);

    // Past the original deadline, still held.
    clock.advance(500);
    expect(await claim(driver, { clock })).toBeNull();
    await complete(driver, job);
    expect(must(await jobById(driver, job.id), 'the job').state).toBe(JobState.Done);
  });

  it('rejects an outcome from a worker whose lease was taken', async () => {
    // The stall-then-wake case: worker A is suspended past its lease, worker B reclaims and
    // runs the job, and A must not be able to record an outcome over B's work.
    await enqueue(driver, { kind: IngestStage.UploadOriginal, hash: 'a' }, { clock });
    const stale = must(await claim(driver, { clock, leaseMs: 1_000 }), 'A');

    clock.advance(1_000);
    const fresh = must(await claim(driver, { clock, leaseMs: 60_000 }), 'B');
    expect(fresh.attempts).toBeGreaterThan(stale.attempts);

    await expect(complete(driver, stale)).rejects.toThrow(JobLeaseLostError);
    await expect(fail(driver, stale, new Error('too late'), { clock })).rejects.toThrow(
      JobLeaseLostError,
    );
    await expect(heartbeat(driver, stale, { clock })).rejects.toThrow(JobLeaseLostError);

    // B's outcome is the one that lands.
    await complete(driver, fresh);
    expect(must(await jobById(driver, fresh.id), 'the job').state).toBe(JobState.Done);
  });

  it('rejects an outcome for a job that was never claimed', async () => {
    const id = await enqueue(driver, { kind: IngestStage.Ocr, hash: 'a' }, { clock });
    await expect(complete(driver, { id, attempts: 1 })).rejects.toThrow(JobLeaseLostError);
    expect(must(await jobById(driver, id), 'the job').state).toBe(JobState.Pending);
  });
});

describe('reapAbandoned', () => {
  it('dead-letters a job that has killed its worker on every attempt', async () => {
    // A poison pill: nothing ever calls fail, because the process does not survive to. Without
    // this the job would be reclaimed forever and the app could never get past it.
    const id = await enqueue(driver, { kind: IngestStage.Derive, hash: 'a' }, { clock });

    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const job = must(await claim(driver, { clock, leaseMs: 1_000 }), `claim ${String(attempt)}`);
      expect(job.attempts).toBe(attempt);
      clock.advance(1_000);
    }

    // The next claim reaps it rather than handing it out a sixth time.
    expect(await claim(driver, { clock })).toBeNull();

    const dead = must(await jobById(driver, id), 'the job');
    expect(dead.state).toBe(JobState.Dead);
    expect(dead.nextAttemptAt).toBeNull();
    expect(dead.lastError).toContain('abandoned');
    expect((await deadLetters(driver)).map((job) => job.id)).toEqual([id]);
  });

  it('leaves a job whose lease is still valid alone', async () => {
    await enqueue(driver, { kind: IngestStage.Derive, hash: 'a' }, { clock });
    const job = must(await claim(driver, { clock, leaseMs: DEFAULT_LEASE_MS }), 'a job');
    // Attempts exhausted, but the lease is live: the worker is still working.
    await driver.run('UPDATE jobs SET attempts = ? WHERE id = ?', [MAX_JOB_ATTEMPTS, job.id]);

    expect(await reapAbandoned(driver, { clock })).toEqual([]);
    expect(must(await jobById(driver, job.id), 'the job').state).toBe(JobState.Running);
  });
});

// ---------------------------------------------------------------------------
// Resumption
// ---------------------------------------------------------------------------

/**
 * A two-stage pipeline, small enough to reason about and shaped like the real one: `Hash`
 * enqueues `Derive` for the same item on success, and `Derive` is terminal.
 *
 * `Hash` uses {@link enqueueOnce}, which is the mechanism under test as much as the queue is —
 * it is what makes a re-run of an interrupted stage idempotent rather than additive.
 */
interface RunLog {
  /** Every stage execution that began, including repeats. */
  readonly started: string[];
  /** Every stage execution that was recorded complete. Must contain no duplicates. */
  readonly completed: string[];
}

function tag(job: Job): string {
  return `${String(job.kind)}:${job.localId ?? '-'}`;
}

/**
 * Drains the queue. Returns `'killed'` if `killOn` matched, having abandoned the job exactly
 * as process death does: mid-stage, with nothing recorded and no lease released.
 */
async function runUntilDrained(
  connection: SqlDriver,
  now: Clock,
  log: RunLog,
  killOn: (job: Job) => boolean = () => false,
): Promise<'drained' | 'killed'> {
  for (;;) {
    const job = await claim(connection, { clock: now, leaseMs: 30_000 });
    if (job === null) return 'drained';

    log.started.push(tag(job));
    if (killOn(job)) return 'killed';

    if (job.kind === IngestStage.Hash) {
      await enqueueOnce(
        connection,
        { kind: IngestStage.Derive, localId: job.localId, priority: 100 },
        { clock: now },
      );
    }
    await complete(connection, job);
    log.completed.push(tag(job));
  }
}

describe('resumption after the runner is killed mid-stage', () => {
  const items = ['a', 'b', 'c', 'd'];

  it('loses no work and duplicates none', async () => {
    for (const [index, item] of items.entries()) {
      await enqueueOnce(
        driver,
        { kind: IngestStage.Hash, localId: item, priority: index },
        { clock },
      );
    }

    const log: RunLog = { started: [], completed: [] };
    const first = await runUntilDrained(
      driver,
      clock,
      log,
      (job) => job.kind === IngestStage.Hash && job.localId === 'b',
    );
    expect(first).toBe('killed');
    expect(log.completed).toEqual([`${String(IngestStage.Hash)}:a`]);

    // The killed process left its claim behind. Nothing else may touch the job until the lease
    // it never released expires — that window is what stops a second runner duplicating work.
    const abandonedId = must(await findJob(driver, IngestStage.Hash, 'b'), "b's hash job");
    expect(must(await jobById(driver, abandonedId), 'the abandoned job').state).toBe(
      JobState.Running,
    );

    // Reboot: a new runner, no memory of the old one, no cleanup step.
    clock.advance(30_000);
    expect(await runUntilDrained(driver, clock, log)).toBe('drained');

    // Nothing lost: every item finished both stages.
    expect(await jobCounts(driver)).toEqual({
      pending: 0,
      running: 0,
      done: items.length * 2,
      failed: 0,
      dead: 0,
    });

    // Nothing duplicated: exactly one completion per stage per item, and exactly one Derive job
    // per item despite the interrupted Hash re-running and re-enqueueing it.
    expect(log.completed).toHaveLength(items.length * 2);
    expect(new Set(log.completed).size).toBe(items.length * 2);
    for (const item of items) {
      expect(log.completed.filter((entry) => entry.endsWith(`:${item}`))).toHaveLength(2);
    }

    // The interrupted stage is the only one that ran twice, and work finished before the kill
    // was not repeated.
    expect(log.started.filter((entry) => entry === `${String(IngestStage.Hash)}:b`)).toHaveLength(
      2,
    );
    expect(log.started.filter((entry) => entry === `${String(IngestStage.Hash)}:a`)).toHaveLength(
      1,
    );
    expect(log.started.filter((entry) => entry === `${String(IngestStage.Derive)}:b`)).toHaveLength(
      1,
    );
  });

  it('loses no work wherever the kill lands', async () => {
    // The single case above is the readable one; this is the one that covers the boundaries —
    // killed on the first stage, killed on the last, killed on a stage the previous run created.
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 7 }), async (killAfter) => {
        const isolated = await open();
        const isolatedClock = new ManualClock();
        try {
          for (const [index, item] of items.entries()) {
            await enqueueOnce(
              isolated,
              { kind: IngestStage.Hash, localId: item, priority: index },
              { clock: isolatedClock },
            );
          }

          const log: RunLog = { started: [], completed: [] };
          let seen = 0;
          await runUntilDrained(isolated, isolatedClock, log, () => {
            const kill = seen === killAfter;
            seen += 1;
            return kill;
          });

          isolatedClock.advance(30_000);
          expect(await runUntilDrained(isolated, isolatedClock, log)).toBe('drained');

          expect(await jobCounts(isolated)).toEqual({
            pending: 0,
            running: 0,
            done: items.length * 2,
            failed: 0,
            dead: 0,
          });
          expect(new Set(log.completed).size).toBe(log.completed.length);
          expect(log.completed).toHaveLength(items.length * 2);
        } finally {
          isolated.close();
        }
      }),
      { numRuns: 8 },
    );
  });
});

/** The id of the single job for a kind and local id, for assertions. */
async function findJob(
  connection: SqlDriver,
  kind: IngestStage,
  localId: string,
): Promise<number | null> {
  const rows = await connection.all<{ id: number | bigint }>(
    'SELECT id FROM jobs WHERE kind = ? AND local_id = ?',
    [kind, localId],
  );
  const id = rows[0]?.id;
  return id === undefined ? null : Number(id);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('progress reporting', () => {
  it('counts every state, which is the ingest status summary', async () => {
    await enqueue(driver, { kind: IngestStage.Hash, localId: '1' }, { clock });
    await enqueue(driver, { kind: IngestStage.Hash, localId: '2' }, { clock });
    await enqueue(driver, { kind: IngestStage.Hash, localId: '3' }, { clock });

    const done = must(await claim(driver, { clock }), 'a job');
    await complete(driver, done);

    const failed = must(await claim(driver, { clock }), 'a job');
    await fail(driver, failed, new Error('nope'), { clock, random: midJitter });

    const running = must(await claim(driver, { clock }), 'a job');
    expect(running.state).toBe(JobState.Running);

    expect(await jobCounts(driver)).toEqual({
      pending: 0,
      running: 1,
      done: 1,
      failed: 1,
      dead: 0,
    });
  });

  it('reports nothing for an untouched queue', async () => {
    expect(await jobCounts(driver)).toEqual({
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      dead: 0,
    });
    expect(await deadLetters(driver)).toEqual([]);
  });
});
