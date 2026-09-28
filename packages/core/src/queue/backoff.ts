/**
 * Retry scheduling: exponential backoff, capped, with jitter.
 *
 * Pure arithmetic, deliberately separated from the queue that calls it. The queue's job is
 * to be atomic; this file's job is to pick a number. Keeping them apart is what makes the
 * schedule testable as a property — over every attempt count and every jitter draw — without
 * a database, and without waiting (design: "Job queue … retry backoff … unit with an injected
 * clock").
 *
 * ## Why jitter, on a single device
 *
 * The usual argument for jitter is a thundering herd of clients against one server, which is
 * not the situation here. The situation here is a *correlated* failure: network loss fails
 * every in-flight upload at the same instant, so without jitter four to six jobs come back
 * with identical `next_attempt_at` values and retry in lockstep, forever, at whatever the
 * backoff schedule says. Jitter is what breaks that lockstep apart.
 *
 * ## Equal jitter rather than full jitter
 *
 * The AWS-blog default is "full jitter" — a uniform draw over `[0, ceiling)`. This uses
 * **equal jitter**: half the ceiling, plus a uniform draw over the other half. The reason is
 * that on a device the wait is not only there to desynchronize. It is there to give the
 * failing condition time to change: the radio to reassociate, the thermal governor to release
 * the CPU, iCloud to finish materializing an original. Full jitter permits a near-zero wait,
 * which spends an attempt from a budget of five on a condition that has had no time to clear
 * — and attempts are the scarce resource, because five of them is all a job gets before it
 * dead-letters.
 *
 * So the guarantee is a floor of `ceiling / 2` and a spread of the same width, which
 * desynchronizes correlated failures just as effectively while never retrying instantly.
 */

/** Delay after the first failure, before jitter. Doubles per attempt from here. */
export const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * The ceiling the doubling saturates at, reached on the ninth attempt at the default base —
 * which is past the point a job dead-letters, so in practice this only binds when a caller
 * raises the attempt budget. Five minutes rather than something larger because the app may
 * only be alive in a background window, and a retry scheduled beyond that window does not
 * happen at all until the next launch.
 */
export const DEFAULT_MAX_DELAY_MS = 300_000;

export interface BackoffOptions {
  /** Delay after attempt 1, before jitter. Defaults to {@link DEFAULT_BASE_DELAY_MS}. */
  readonly baseDelayMs?: number;
  /** Upper bound on the pre-jitter delay. Defaults to {@link DEFAULT_MAX_DELAY_MS}. */
  readonly maxDelayMs?: number;
  /**
   * Uniform source over `[0, 1)`. Injected for the same reason the clock is: a schedule that
   * consults `Math.random` directly can be bounded by a test but never pinned by one.
   */
  readonly random?: () => number;
}

/** A backoff option was not a usable duration. A programming error, not a runtime condition. */
export class InvalidBackoffError extends Error {
  override readonly name = 'InvalidBackoffError';

  constructor(field: string, value: number) {
    super(
      `${field} must be a positive finite number of milliseconds, not ${String(value)}. A ` +
        'non-positive backoff would retry a failing job in the same millisecond it failed, ' +
        'spending the whole attempt budget in one tick.',
    );
  }
}

/**
 * The un-jittered delay after `attempts` failures: `base * 2^(attempts - 1)`, capped.
 *
 * Exported because it is the bound the jittered delay is asserted against, and because the
 * error view can use it to say how long a retry might take without predicting the draw.
 */
export function backoffCeilingMs(attempts: number, options: BackoffOptions = {}): number {
  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  if (!Number.isFinite(base) || base <= 0) throw new InvalidBackoffError('baseDelayMs', base);
  if (!Number.isFinite(max) || max <= 0) throw new InvalidBackoffError('maxDelayMs', max);

  // A first failure is attempt 1, so the exponent starts at 0. Anything lower is treated as
  // the first attempt rather than rejected: `attempts` comes from a database column, and a
  // row that somehow reads 0 should still be scheduled rather than throw inside a retry path.
  const exponent = Math.max(0, Math.floor(attempts) - 1);

  // 2 ** exponent overflows to Infinity well before it overflows anything else, and
  // Math.min then yields the cap, so a wild attempt count saturates rather than producing NaN.
  return Math.min(max, base * 2 ** exponent);
}

/**
 * How long to wait before attempt `attempts + 1`, given that `attempts` have already failed.
 *
 * Never zero: the result is at least 1 ms, so a retry always lands in a later millisecond
 * than the failure that scheduled it. That is what keeps a claim loop from re-claiming the
 * job it just failed within the same tick of the clock.
 */
export function backoffDelayMs(attempts: number, options: BackoffOptions = {}): number {
  const ceiling = backoffCeilingMs(attempts, options);
  const draw = options.random?.() ?? Math.random();

  // Clamped rather than trusted. A caller's generator is the one input here that comes from
  // outside this package, and a draw outside [0, 1) would push the delay past the cap that
  // the whole point of `maxDelayMs` is to hold.
  const unit = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 0;

  const half = ceiling / 2;
  return Math.max(1, Math.min(ceiling, Math.round(half + unit * half)));
}

/**
 * The epoch-millisecond instant to write into `jobs.next_attempt_at`.
 *
 * `now` is passed in rather than read, because the queue owns the clock — see the `Clock`
 * seam in `jobQueue.ts`.
 */
export function nextAttemptAt(now: number, attempts: number, options: BackoffOptions = {}): number {
  return now + backoffDelayMs(attempts, options);
}
