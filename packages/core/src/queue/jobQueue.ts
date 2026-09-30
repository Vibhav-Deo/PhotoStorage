/**
 * The durable job queue.
 *
 * Every pipeline stage is a row in `jobs`. Nothing is held only in memory, so process death,
 * reboot, and network loss resume from the last completed stage rather than from the start
 * (Requirements 1.9, 2.4). Bulk export runs through the same queue (Requirement 7.3), which is
 * why this lives in `queue/` rather than under `ingest/`.
 *
 * Two operations here are correctness-critical, and everything else is bookkeeping around
 * them: **claim** must hand a job to exactly one worker, and a job whose worker died must
 * become claimable again rather than sitting in `running` forever. Get either wrong and the
 * failure is not an error — it is an item uploaded twice, or an item that silently never
 * finishes and so can never become purge-eligible.
 *
 * ## `next_attempt_at` means one thing
 *
 * The obvious way to reclaim a dead worker's job is a `lease_expires_at` column and an `owner`
 * column, and the schema has neither. That is not a gap to be patched by a migration. Read the
 * column as **"this row is not claimable before this instant"** and both cases are the same
 * case:
 *
 * | State | What `next_attempt_at` is | Who set it |
 * |---|---|---|
 * | `pending` | when the job may first run | `enqueue` |
 * | `failed` | when the backoff expires | `fail` |
 * | `running` | when the lease expires and the job may be taken from its holder | `claim` |
 * | `done`, `dead` | `NULL` — never claimable again | `complete`, `fail` |
 *
 * So there is no lease reaper, no janitor task, and nothing to schedule. A crashed worker's
 * job is reclaimed by the next {@link claim} that runs after its lease deadline passes,
 * because the deadline is already written in the row that the crash left behind. This matters
 * because there is no external coordinator to notice the death: no lock service, no heartbeat
 * registry, and on a phone not even a reliable process supervisor. The only thing that
 * survives the crash is the row, so the row has to carry the recovery.
 *
 * The cost is that `idx_jobs_runnable` is `WHERE state IN (0, 3)` and therefore excludes
 * `running`, so reclamation cannot use it. {@link claim} handles that by ordering its work:
 * the indexed query for genuinely runnable jobs runs first, and the un-indexed scan for
 * expired leases runs **only when that found nothing**. The scan is thus paid for exactly when
 * the worker would otherwise be idle, which is also exactly when a stranded job is the thing
 * standing between the queue and finishing.
 *
 * ## `attempts` is also the fence
 *
 * A lease alone does not prevent duplicated work. Worker A claims a job, stalls — a long GC, a
 * suspended app, a device asleep — its lease expires, worker B claims and runs the job, and
 * then A wakes up and reports success for work B already did. Detecting that needs a fencing
 * token: something a claim mints, that a later claim invalidates.
 *
 * `attempts` already is one. {@link claim} increments it, so it rises monotonically per job and
 * a reclaim always advances it. {@link complete}, {@link fail}, and {@link heartbeat} therefore
 * write `WHERE id = ? AND state = running AND attempts = ?` and check whether the update
 * matched. If it did not, the caller's lease is gone and it throws {@link JobLeaseLostError}
 * rather than overwriting the outcome of whoever holds the job now.
 *
 * Incrementing on *claim* rather than on failure has a second consequence worth stating
 * plainly, because it is the difference between a robust queue and one that can brick an app: a
 * job that hard-kills the process gets no chance to call {@link fail}, so if attempts only
 * counted reported failures such a job would be reclaimed and re-run forever. Counting claims
 * means a poison pill exhausts its budget like anything else, and {@link reapAbandoned} moves
 * it to `dead` with an error saying so.
 *
 * ## Atomicity without a transaction
 *
 * Every mutation here is a **single statement** — `UPDATE … WHERE id = (SELECT … LIMIT 1)
 * RETURNING …` for the claim, guarded `UPDATE … RETURNING id` for the rest. SQLite wraps each
 * statement in its own implicit transaction, so there is no read-then-write window for two
 * workers to interleave in, and `RETURNING` reports what actually changed.
 *
 * The alternative — `BEGIN IMMEDIATE`, select, update, commit — is worse here for a specific
 * reason: several workers draining the queue concurrently in one process share one connection,
 * and a second `BEGIN` on a connection that already has one open is an error rather than a
 * wait. The single-statement form is safe both across processes (SQLite's own write lock) and
 * across async workers on one connection (nothing to interleave).
 *
 * `RETURNING` needs SQLite 3.35+. Node 22 links 3.50.4 and `expo-sqlite@57` vendors 3.50.3, so
 * both targets clear it comfortably; `capability.ts` is where a version floor would be asserted
 * if that ever stopped being true.
 *
 * ## Per-kind concurrency is the runner's, not the queue's
 *
 * The design fixes concurrency per stage — Hash 2, Derive `min(4, cores-1)`, Embed 1, Upload
 * 4–6, Verify 4 — and none of it is enforced here. {@link claim} takes a `kinds` filter so a
 * worker can be dedicated to one stage, and the pool sizes belong to the runner (tasks 2.11,
 * 7.4). Three reasons:
 *
 * 1. **The limits are not properties of the queue.** `min(4, cores-1)` is a property of the
 *    machine; Embed's limit of 1 is a property of the ExecuTorch runtime holding one model
 *    instance. The queue can see neither.
 * 2. **Enforcing them would cost the atomicity above.** A cap means counting `running` rows per
 *    kind, and `idx_jobs_runnable` excludes `running` — so it is a scan, and folding it into the
 *    claim statement reintroduces exactly the read-then-write window the single statement
 *    exists to avoid.
 * 3. **Backpressure needs to pause a stage outright.** Requirement 2.6 wants uploads deferred on
 *    metered connections and everything paused when the device is hot or the battery is low.
 *    That is a scheduling decision made from sensor state, and expressing it as "stop asking for
 *    upload jobs" is both simpler and more correct than a limit stored in the queue.
 *
 * So the queue guarantees exclusivity per *job*, and the runner decides how many jobs of each
 * kind are in flight.
 */

import { IngestStage, JobState } from '../states.ts';
import type { SqlDriver, SqlValue } from '../db/driver.ts';
import { nextAttemptAt, type BackoffOptions } from './backoff.ts';

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Attempts a job gets before it dead-letters (design: "After 5 attempts a job moves to `dead`
 * and surfaces in a per-item error view rather than retrying forever").
 *
 * Counted per claim, not per reported failure — see this module's header.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** Default `jobs.priority`, matching the schema's own default. Lower runs first. */
export const DEFAULT_JOB_PRIORITY = 100;

/**
 * How long a claim is exclusive before another worker may take the job.
 *
 * One minute is deliberately shorter than the slowest stage this queue will run: hashing a
 * 4 GB video that iOS must first pull down from iCloud takes far longer. A stage that outlives
 * its lease calls {@link heartbeat}, which is the right way round — a lease long enough for the
 * worst case would leave every crashed job stranded for the worst case, and crashes are more
 * common than 4 GB videos.
 */
export const DEFAULT_LEASE_MS = 60_000;

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

/**
 * The queue's only source of time.
 *
 * Injected so backoff and lease expiry are testable without waiting, which is what the design's
 * test strategy asks for. It also means a test can move time *backwards* or in jumps, which is
 * not a contrivance: a device whose clock is corrected by NTP mid-ingest does exactly that.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** `Date.now`. The default everywhere a `Clock` is optional. */
export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * What a job is about. Both fields are optional and both may be absent — a `Scan` job is about
 * the library as a whole.
 *
 * `hash` carries no foreign key in the schema, which is what lets a digest travel between the
 * `Hash` stage and the first stage able to write an `assets` row. See `ingest/dedupe.ts` on the
 * ordering constraint.
 */
export interface JobTarget {
  /** Content hash, once known. */
  readonly hash?: string | null;
  /** `PHAsset.localIdentifier` or MediaStore `_ID`, for device ingest. */
  readonly localId?: string | null;
}

/** A job to enqueue. */
export interface JobSpec extends JobTarget {
  readonly kind: IngestStage;
  /** Lower runs first. Defaults to {@link DEFAULT_JOB_PRIORITY}. */
  readonly priority?: number;
  /** Earliest epoch-ms the job may run. Defaults to now, i.e. immediately. */
  readonly runAt?: number;
}

/** A job row. */
export interface Job {
  readonly id: number;
  readonly kind: IngestStage;
  readonly hash: string | null;
  readonly localId: string | null;
  readonly priority: number;
  readonly state: JobState;
  /**
   * Claims so far. Also the fencing token: the value a claim returns is the one
   * {@link complete}, {@link fail}, and {@link heartbeat} must present to be accepted.
   */
  readonly attempts: number;
  /**
   * The instant before which this row is not claimable — the lease deadline while `running`,
   * the retry time while `pending` or `failed`, `null` once terminal. See this module's header.
   */
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
}

/**
 * The minimum a worker must present to report an outcome: which job, and which claim.
 *
 * A {@link Job} satisfies it, so a claimed job can be passed straight through. It exists as its
 * own type so that a caller which has persisted only the two numbers across a background-task
 * boundary can still report in.
 */
export interface JobLease {
  readonly id: number;
  readonly attempts: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A worker reported an outcome for a job it no longer holds.
 *
 * Either the lease expired and another worker claimed the job — so the outcome being reported
 * describes work that has since been redone — or the row is gone. Throwing rather than writing
 * is the whole purpose of the fence: the alternative is a stale worker marking `done` a job
 * that is at this moment running somewhere else.
 *
 * Recoverable, and usually should be: the correct response is to drop the result and claim
 * again. What must *not* happen is retrying the write.
 */
export class JobLeaseLostError extends Error {
  override readonly name = 'JobLeaseLostError';
  readonly jobId: number;
  readonly attempts: number;

  constructor(lease: JobLease, operation: string) {
    super(
      `cannot ${operation} job ${String(lease.id)} at attempt ${String(lease.attempts)}: it is ` +
        'no longer running under that claim. Either the lease expired and another worker took ' +
        'the job — in which case this result describes work that has already been redone — or ' +
        'the row is gone. Discard the result and claim again rather than reporting it.',
    );
    this.jobId = lease.id;
    this.attempts = lease.attempts;
  }
}

/** An enqueue or claim argument could not describe a job. A programming error. */
export class InvalidJobSpecError extends Error {
  override readonly name = 'InvalidJobSpecError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * The queue observed something its own reasoning says cannot happen.
 *
 * Exists because the claim statement's exclusivity rests on an argument about SQLite — that
 * `WHERE id = (scalar subquery)` matches at most one row — and an argument is worth checking
 * when being wrong about it means two workers on one job. Never expected; recoverable if it
 * ever fires, because anything already claimed returns to the queue when its lease expires.
 */
export class JobQueueInvariantError extends Error {
  override readonly name = 'JobQueueInvariantError';

  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  'id, kind, hash, local_id, priority, state, attempts, next_attempt_at, last_error, created_at';

/**
 * Written as a type alias rather than an interface on purpose: `SqlDriver.all` constrains its
 * row type to `SqlRow`, and TypeScript grants an implicit index signature to object type
 * aliases but not to interfaces.
 */
type JobRow = {
  id: number | bigint;
  kind: number | bigint;
  hash: string | null;
  local_id: string | null;
  priority: number | bigint;
  state: number | bigint;
  attempts: number | bigint;
  next_attempt_at: number | bigint | null;
  last_error: string | null;
  created_at: number | bigint;
};

function toJob(row: JobRow): Job {
  return {
    id: Number(row.id),
    kind: Number(row.kind) as IngestStage,
    hash: row.hash,
    localId: row.local_id,
    priority: Number(row.priority),
    state: Number(row.state) as JobState,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const INGEST_STAGES = new Set<number>(Object.values(IngestStage));

function assertStage(kind: number, field: string): void {
  if (!INGEST_STAGES.has(kind)) {
    throw new InvalidJobSpecError(
      `${field} is ${String(kind)}, which is not an IngestStage. jobs.kind is persisted and ` +
        'read back as a stage, so an unknown value produces a job no worker will ever run.',
    );
  }
}

function assertEpochMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidJobSpecError(
      `${field} must be a safe integer number of epoch milliseconds, not ${String(value)}. ` +
        'A fractional or out-of-range value compares unpredictably against next_attempt_at, ' +
        'which is what decides whether a job is claimable at all.',
    );
  }
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/** Every state a job row can be in. The default `skipIfIn` for {@link enqueueOnce}. */
const ALL_JOB_STATES: readonly JobState[] = Object.values(JobState);

export interface EnqueueOptions {
  /** Defaults to {@link systemClock}. Supplies `created_at` and the default `runAt`. */
  readonly clock?: Clock;
}

/**
 * Adds a job unconditionally and returns its id.
 *
 * Unconditional is the right default for stage-to-stage handoff, where the enqueuing worker
 * holds the only claim on the preceding stage and so cannot be racing itself. Use
 * {@link enqueueOnce} where the caller might be re-running — a resumed `Scan`, most obviously.
 */
export async function enqueue(
  driver: SqlDriver,
  spec: JobSpec,
  options: EnqueueOptions = {},
): Promise<number> {
  const now = (options.clock ?? systemClock).now();
  const row = prepareInsert(spec, now);

  const rows = await driver.all<{ id: number | bigint }>(
    `INSERT INTO jobs(kind, hash, local_id, priority, state, attempts, next_attempt_at,
                      last_error, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)
     RETURNING id`,
    row,
  );
  const id = rows[0]?.id;
  if (id === undefined) {
    // Unreachable: an unconditional INSERT either inserts a row or throws.
    throw new InvalidJobSpecError('the job insert reported no row; the queue write did not land');
  }
  return Number(id);
}

export interface EnqueueOnceOptions extends EnqueueOptions {
  /**
   * Skip the insert when a job for the same kind and target already exists in one of these
   * states. Defaults to **every** state, which makes the operation "record this stage unless it
   * is already on record" — the form Requirement 1.9 asks for, where resuming an interrupted
   * import skips work that is already done rather than re-hashing and re-uploading it.
   *
   * Narrow it to the non-terminal states to enqueue a stage that has legitimately run before:
   * re-embedding after a model change (Requirement 5.9) is the case that needs it.
   */
  readonly skipIfIn?: readonly JobState[];
}

export interface EnqueueOnceResult {
  /** The new job's id, or `null` when an existing job made the insert unnecessary. */
  readonly id: number | null;
  readonly inserted: boolean;
}

/**
 * Adds a job unless one already exists for the same kind and target.
 *
 * Identity is `(kind, hash, local_id)` compared with SQLite's `IS`, so two NULLs match: a
 * second `Scan` job with no target is recognised as the same job as the first, which is what
 * makes a resumed scan idempotent rather than additive.
 *
 * There is no unique constraint in the schema to lean on, so the check and the insert are one
 * statement — `INSERT … SELECT … WHERE NOT EXISTS (…) RETURNING id`. Read-then-insert across
 * two calls would let two workers both find nothing and both insert, and duplicate jobs are the
 * exact failure this operation exists to prevent.
 */
export async function enqueueOnce(
  driver: SqlDriver,
  spec: JobSpec,
  options: EnqueueOnceOptions = {},
): Promise<EnqueueOnceResult> {
  const now = (options.clock ?? systemClock).now();
  const row = prepareInsert(spec, now);
  const skipIfIn = options.skipIfIn ?? ALL_JOB_STATES;

  if (skipIfIn.length === 0) {
    return { id: await enqueue(driver, spec, options), inserted: true };
  }

  const placeholders = skipIfIn.map(() => '?').join(', ');
  const rows = await driver.all<{ id: number | bigint }>(
    `INSERT INTO jobs(kind, hash, local_id, priority, state, attempts, next_attempt_at,
                      last_error, created_at)
     SELECT ?, ?, ?, ?, ?, 0, ?, NULL, ?
      WHERE NOT EXISTS (
              SELECT 1 FROM jobs
               WHERE kind = ? AND hash IS ? AND local_id IS ? AND state IN (${placeholders})
            )
     RETURNING id`,
    [...row, spec.kind, spec.hash ?? null, spec.localId ?? null, ...skipIfIn],
  );

  const id = rows[0]?.id;
  return id === undefined ? { id: null, inserted: false } : { id: Number(id), inserted: true };
}

/** Bindings for the insert column list, shared by both enqueue forms. */
function prepareInsert(spec: JobSpec, now: number): SqlValue[] {
  assertStage(spec.kind, 'kind');
  const priority = spec.priority ?? DEFAULT_JOB_PRIORITY;
  if (!Number.isSafeInteger(priority)) {
    throw new InvalidJobSpecError(
      `priority must be a safe integer, not ${String(priority)}; it is the leading column of ` +
        'idx_jobs_runnable and so decides claim order.',
    );
  }
  assertEpochMs(now, 'clock.now()');
  const runAt = spec.runAt ?? now;
  assertEpochMs(runAt, 'runAt');

  // next_attempt_at is nullable in the schema but always written here. The claim query filters
  // on `next_attempt_at <= now`, which no NULL satisfies, so a row without one would be
  // enqueued and then never run — and it would not appear in any error view either, because
  // it would look pending forever.
  return [
    spec.kind,
    spec.hash ?? null,
    spec.localId ?? null,
    priority,
    JobState.Pending,
    runAt,
    now,
  ];
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  readonly clock?: Clock;
  /**
   * Restrict the claim to these stages, so a worker pool can be dedicated to one — which is how
   * the design's per-stage concurrency is expressed. See this module's header. An empty array
   * claims nothing, which is a usable way to say "this pool is paused".
   */
  readonly kinds?: readonly IngestStage[];
  /** Exclusivity window for the claim. Defaults to {@link DEFAULT_LEASE_MS}. */
  readonly leaseMs?: number;
  /** Attempt budget, for {@link reapAbandoned}. Defaults to {@link MAX_JOB_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

/**
 * Takes the next runnable job, or `null` if there is none.
 *
 * The returned job is `running`, its `attempts` is incremented, and its `nextAttemptAt` is the
 * lease deadline. The caller must eventually {@link complete} or {@link fail} it — but only
 * *eventually* is guaranteed: if the process dies first, the lease expires and a later claim
 * picks the job up. That is the resumption guarantee (Requirements 1.9, 2.4), and it is why
 * there is nothing to clean up on startup.
 *
 * Three statements, in an order chosen so the cheap one is the common one:
 *
 * 1. The indexed claim over `pending` and `failed` — `idx_jobs_runnable` serves it directly.
 * 2. Only if that found nothing: {@link reapAbandoned}, which dead-letters expired leases whose
 *    attempts are exhausted, so a job that kills the process cannot be reclaimed forever.
 * 3. Only then: the reclaim of an expired lease, which cannot use the index because the index
 *    excludes `running`.
 *
 * A busy queue therefore pays for one indexed statement per claim, and the scans happen when
 * the worker had nothing else to do anyway.
 */
export async function claim(driver: SqlDriver, options: ClaimOptions = {}): Promise<Job | null> {
  const now = (options.clock ?? systemClock).now();
  assertEpochMs(now, 'clock.now()');

  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new InvalidJobSpecError(
      `leaseMs must be a positive safe integer, not ${String(leaseMs)}. A zero-length lease is ` +
        'expired the moment it is granted, so the job could be reclaimed from underneath the ' +
        'worker still holding it.',
    );
  }
  const leaseUntil = now + leaseMs;

  const kindFilter = buildKindFilter(options.kinds);
  if (kindFilter === null) return null;

  const runnable = await claimWhere(
    driver,
    `state IN (?, ?) AND next_attempt_at <= ?${kindFilter.sql}`,
    [JobState.Pending, JobState.Failed, now, ...kindFilter.params],
    leaseUntil,
  );
  if (runnable !== null) return runnable;

  await reapAbandoned(driver, options);

  return claimWhere(
    driver,
    `state = ? AND next_attempt_at <= ? AND attempts < ?${kindFilter.sql}`,
    [JobState.Running, now, options.maxAttempts ?? MAX_JOB_ATTEMPTS, ...kindFilter.params],
    leaseUntil,
  );
}

/**
 * The claim statement. One `UPDATE` whose target is a scalar subquery, so selecting the job and
 * taking it are the same atomic operation and two workers cannot both see it as free.
 */
async function claimWhere(
  driver: SqlDriver,
  predicate: string,
  params: readonly SqlValue[],
  leaseUntil: number,
): Promise<Job | null> {
  const rows = await driver.all<JobRow>(
    `UPDATE jobs
        SET state = ?, attempts = attempts + 1, next_attempt_at = ?
      WHERE id = (SELECT id FROM jobs
                   WHERE ${predicate}
                   ORDER BY priority, next_attempt_at
                   LIMIT 1)
     RETURNING ${JOB_COLUMNS}`,
    [JobState.Running, leaseUntil, ...params],
  );

  if (rows.length > 1) {
    // `id = (scalar subquery)` can match at most one row, so this cannot happen — and it is
    // checked anyway because the consequence of being wrong is two workers on one job, which is
    // the one outcome this module exists to prevent. Throwing strands the claimed rows only
    // until their leases expire, so even the impossible case self-heals.
    throw new JobQueueInvariantError(
      `the claim statement matched ${String(rows.length)} rows instead of one (ids ` +
        `${rows.map((row) => String(row.id)).join(', ')}). A claim must be exclusive; these ` +
        'jobs are left to their leases rather than handed to this worker.',
    );
  }

  const row = rows[0];
  return row === undefined ? null : toJob(row);
}

/**
 * `AND kind IN (…)` plus its bindings, or `null` when the caller asked for no kinds at all.
 * `IN ()` is a syntax error in SQLite, so the empty case is answered without a query.
 */
function buildKindFilter(
  kinds: readonly IngestStage[] | undefined,
): { sql: string; params: readonly SqlValue[] } | null {
  if (kinds === undefined) return { sql: '', params: [] };
  if (kinds.length === 0) return null;
  for (const kind of kinds) assertStage(kind, 'kinds entry');
  return {
    sql: ` AND kind IN (${kinds.map(() => '?').join(', ')})`,
    params: kinds,
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Extends the lease on a held job and returns the refreshed row.
 *
 * `attempts` is untouched, so the caller's fence stays valid across any number of heartbeats.
 * A stage whose work can outlast {@link DEFAULT_LEASE_MS} — hashing a large video, a multipart
 * upload on a slow connection — must call this, or it will find its lease reclaimed while it is
 * still working and its {@link complete} rejected.
 *
 * @throws {JobLeaseLostError} if the lease has already been taken.
 */
export async function heartbeat(
  driver: SqlDriver,
  lease: JobLease,
  options: { readonly clock?: Clock; readonly leaseMs?: number } = {},
): Promise<Job> {
  const now = (options.clock ?? systemClock).now();
  const leaseUntil = now + (options.leaseMs ?? DEFAULT_LEASE_MS);

  const rows = await driver.all<JobRow>(
    `UPDATE jobs SET next_attempt_at = ?
      WHERE id = ? AND state = ? AND attempts = ?
     RETURNING ${JOB_COLUMNS}`,
    [leaseUntil, lease.id, JobState.Running, lease.attempts],
  );
  const row = rows[0];
  if (row === undefined) throw new JobLeaseLostError(lease, 'heartbeat');
  return toJob(row);
}

/**
 * Marks a held job `done`. Terminal: it leaves the runnable index and `last_error` is cleared,
 * because a job that eventually succeeded has no error to show.
 *
 * @throws {JobLeaseLostError} if the lease has been taken, so a stale worker cannot record
 *   success over a job that is currently running elsewhere.
 */
export async function complete(driver: SqlDriver, lease: JobLease): Promise<void> {
  const rows = await driver.all<{ id: number | bigint }>(
    `UPDATE jobs SET state = ?, next_attempt_at = NULL, last_error = NULL
      WHERE id = ? AND state = ? AND attempts = ?
     RETURNING id`,
    [JobState.Done, lease.id, JobState.Running, lease.attempts],
  );
  if (rows.length === 0) throw new JobLeaseLostError(lease, 'complete');
}

export interface FailOptions extends BackoffOptions {
  readonly clock?: Clock;
  /** Defaults to {@link MAX_JOB_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

export interface JobFailure {
  /** True when the attempt budget is spent and the job moved to `dead`. */
  readonly deadLettered: boolean;
  /** Attempts recorded against the job, including the one that just failed. */
  readonly attempts: number;
  /** When the retry is scheduled, or `null` if there will not be one. */
  readonly nextAttemptAt: number | null;
}

/**
 * Records a failed attempt: either a retry scheduled with jittered exponential backoff, or —
 * once {@link MAX_JOB_ATTEMPTS} attempts are spent — the move to `dead`.
 *
 * A dead job keeps its `last_error` and leaves the runnable index, which is precisely the
 * design's requirement: it "surfaces in a per-item error view rather than retrying forever"
 * (Requirements 1.10, 2.7). Nothing is dropped; something stops being retried.
 *
 * @throws {JobLeaseLostError} if the lease has been taken.
 */
export async function fail(
  driver: SqlDriver,
  lease: JobLease,
  error: unknown,
  options: FailOptions = {},
): Promise<JobFailure> {
  const now = (options.clock ?? systemClock).now();
  const maxAttempts = options.maxAttempts ?? MAX_JOB_ATTEMPTS;
  const deadLettered = lease.attempts >= maxAttempts;
  const retryAt = deadLettered ? null : nextAttemptAt(now, lease.attempts, options);

  const rows = await driver.all<{ id: number | bigint }>(
    `UPDATE jobs SET state = ?, next_attempt_at = ?, last_error = ?
      WHERE id = ? AND state = ? AND attempts = ?
     RETURNING id`,
    [
      deadLettered ? JobState.Dead : JobState.Failed,
      retryAt,
      describeError(error),
      lease.id,
      JobState.Running,
      lease.attempts,
    ],
  );
  if (rows.length === 0) throw new JobLeaseLostError(lease, 'fail');

  return { deadLettered, attempts: lease.attempts, nextAttemptAt: retryAt };
}

/**
 * Dead-letters every expired lease whose attempts are exhausted, and returns their ids.
 *
 * These are the jobs nobody will ever report on: the worker holding each one died without
 * calling {@link fail}, and it did so as many times as the job had attempts. Left alone they
 * would be reclaimed and re-run forever, which for a job that crashes the process means an app
 * that cannot get past it. Recorded as `dead` with an error naming the cause, they surface in
 * the error view like any other failure.
 *
 * Called by {@link claim} on the idle path, so nothing needs to schedule it. Exported because
 * an ingest-status view may reasonably want to run it before reporting counts.
 */
export async function reapAbandoned(
  driver: SqlDriver,
  options: { readonly clock?: Clock; readonly maxAttempts?: number } = {},
): Promise<readonly number[]> {
  const now = (options.clock ?? systemClock).now();
  const maxAttempts = options.maxAttempts ?? MAX_JOB_ATTEMPTS;

  const rows = await driver.all<{ id: number | bigint }>(
    `UPDATE jobs SET state = ?, next_attempt_at = NULL, last_error = ?
      WHERE state = ? AND next_attempt_at <= ? AND attempts >= ?
     RETURNING id`,
    [JobState.Dead, ABANDONED_ERROR, JobState.Running, now, maxAttempts],
  );
  return rows.map((row) => Number(row.id));
}

const ABANDONED_ERROR =
  'abandoned: the worker holding this job stopped without reporting an outcome, and it did so ' +
  'on every attempt the job had. The process was killed, terminated, or crashed while running ' +
  'this stage — possibly because of this item.';

/**
 * `last_error` is what the per-item error view shows a user, so the name is kept alongside the
 * message: `HashMismatchError` and `ObjectNotFoundError` mean very different things to whoever
 * is deciding whether to retry, and a bare message often omits which one happened.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name.length === 0 ? error.message : `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : String(error);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A single job by id, or `null`. */
export async function jobById(driver: SqlDriver, id: number): Promise<Job | null> {
  const rows = await driver.all<JobRow>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`, [id]);
  const row = rows[0];
  return row === undefined ? null : toJob(row);
}

export interface JobCounts {
  readonly pending: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly dead: number;
}

/**
 * How many jobs are in each state — the library-wide progress summary Requirement 2.7 asks
 * for, and the cheapest possible answer to "is ingest finished".
 */
export async function jobCounts(driver: SqlDriver): Promise<JobCounts> {
  const rows = await driver.all<{ state: number | bigint; n: number | bigint }>(
    'SELECT state, COUNT(*) AS n FROM jobs GROUP BY state',
  );
  const byState = new Map<number, number>(rows.map((row) => [Number(row.state), Number(row.n)]));
  return {
    pending: byState.get(JobState.Pending) ?? 0,
    running: byState.get(JobState.Running) ?? 0,
    done: byState.get(JobState.Done) ?? 0,
    failed: byState.get(JobState.Failed) ?? 0,
    dead: byState.get(JobState.Dead) ?? 0,
  };
}

/**
 * Jobs that gave up, oldest first — the per-item error view (Requirements 1.10, 2.7). Each row
 * still carries the `last_error` that ended it, which is the reason the user is owed.
 */
export async function deadLetters(
  driver: SqlDriver,
  options: { readonly limit?: number } = {},
): Promise<readonly Job[]> {
  const rows = await driver.all<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE state = ? ORDER BY id LIMIT ?`,
    [JobState.Dead, options.limit ?? 500],
  );
  return rows.map(toJob);
}
