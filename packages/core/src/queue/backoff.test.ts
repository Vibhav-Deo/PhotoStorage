/**
 * Retry scheduling.
 *
 * The interesting assertions here are the bounds, because a backoff schedule fails in two
 * directions and both are silent. Too short and a job burns its five attempts inside a second,
 * so a transient network loss dead-letters an item that would have uploaded fine a moment later.
 * Too long — or unbounded, which is what an uncapped doubling becomes — and a retry is scheduled
 * beyond the background window the app is alive for, so it simply never happens.
 *
 * Every test injects the jitter source. That is the point of injecting it: bounds can be
 * *sampled* with a real random source but never *pinned* by one.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  InvalidBackoffError,
  backoffCeilingMs,
  backoffDelayMs,
  nextAttemptAt,
} from './backoff.ts';

const fixed = (value: number) => () => value;

/** Attempt counts a job can actually reach, plus a margin past the dead-letter budget. */
const attemptsArb = fc.integer({ min: 1, max: 12 });
const unitArb = fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true });

describe('backoffCeilingMs', () => {
  it('doubles from the base delay', () => {
    expect(backoffCeilingMs(1)).toBe(1_000);
    expect(backoffCeilingMs(2)).toBe(2_000);
    expect(backoffCeilingMs(3)).toBe(4_000);
    expect(backoffCeilingMs(4)).toBe(8_000);
    expect(backoffCeilingMs(5)).toBe(16_000);
  });

  it('saturates at the cap rather than growing without bound', () => {
    // The failure this rules out is arithmetic, not policy: 2 ** 1000 is Infinity, and an
    // Infinity delay written to next_attempt_at is a job that is never claimable again.
    expect(backoffCeilingMs(1_000)).toBe(DEFAULT_MAX_DELAY_MS);
    expect(Number.isFinite(backoffCeilingMs(Number.MAX_SAFE_INTEGER))).toBe(true);
  });

  it('treats a nonsensical attempt count as the first attempt', () => {
    // `attempts` comes out of a database column. A row that somehow reads 0 should still get
    // scheduled; throwing inside the retry path would strand it instead.
    expect(backoffCeilingMs(0)).toBe(DEFAULT_BASE_DELAY_MS);
    expect(backoffCeilingMs(-5)).toBe(DEFAULT_BASE_DELAY_MS);
    expect(backoffCeilingMs(1.9)).toBe(DEFAULT_BASE_DELAY_MS);
  });

  it('rejects a base or cap that is not a duration', () => {
    expect(() => backoffCeilingMs(1, { baseDelayMs: 0 })).toThrow(InvalidBackoffError);
    expect(() => backoffCeilingMs(1, { baseDelayMs: -1 })).toThrow(InvalidBackoffError);
    expect(() => backoffCeilingMs(1, { maxDelayMs: Number.NaN })).toThrow(InvalidBackoffError);
  });
});

describe('backoffDelayMs', () => {
  it('spans the top half of the ceiling, so a retry is never immediate', () => {
    expect(backoffDelayMs(1, { random: fixed(0) })).toBe(500);
    expect(backoffDelayMs(1, { random: fixed(1) })).toBe(1_000);
    expect(backoffDelayMs(3, { random: fixed(0) })).toBe(2_000);
    expect(backoffDelayMs(3, { random: fixed(0.5) })).toBe(3_000);
    expect(backoffDelayMs(3, { random: fixed(1) })).toBe(4_000);
  });

  it('clamps a jitter source that leaves the unit interval', () => {
    // The generator is the one input from outside this package, and a draw above 1 would push
    // the delay past the cap that maxDelayMs exists to hold.
    expect(backoffDelayMs(1, { random: fixed(9) })).toBe(1_000);
    expect(backoffDelayMs(1, { random: fixed(-9) })).toBe(500);
    expect(backoffDelayMs(1, { random: fixed(Number.NaN) })).toBe(500);
  });

  it('never returns zero, so the retry lands in a later millisecond than the failure', () => {
    // A zero delay means the claim loop can re-take the job it just failed within one tick of
    // the clock, spending the whole attempt budget without the failing condition changing.
    fc.assert(
      fc.property(attemptsArb, unitArb, (attempts, unit) => {
        expect(backoffDelayMs(attempts, { baseDelayMs: 1, random: fixed(unit) })).toBeGreaterThan(
          0,
        );
      }),
    );
  });

  it('stays within half the ceiling and the ceiling', () => {
    fc.assert(
      fc.property(attemptsArb, unitArb, (attempts, unit) => {
        const ceiling = backoffCeilingMs(attempts);
        const delay = backoffDelayMs(attempts, { random: fixed(unit) });
        expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(delay).toBeLessThanOrEqual(ceiling);
      }),
    );
  });

  it('never exceeds the cap, whatever the attempt count or the draw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4_000 }),
        unitArb,
        fc.integer({ min: 1, max: 60_000 }),
        (attempts, unit, maxDelayMs) => {
          expect(backoffDelayMs(attempts, { maxDelayMs, random: fixed(unit) })).toBeLessThanOrEqual(
            maxDelayMs,
          );
        },
      ),
    );
  });

  it('is non-decreasing in the attempt count for a fixed draw', () => {
    // Otherwise a later attempt could be scheduled sooner than an earlier one, which is not
    // backoff at all — it is a retry loop with extra steps.
    fc.assert(
      fc.property(attemptsArb, unitArb, (attempts, unit) => {
        const earlier = backoffDelayMs(attempts, { random: fixed(unit) });
        const later = backoffDelayMs(attempts + 1, { random: fixed(unit) });
        expect(later).toBeGreaterThanOrEqual(earlier);
      }),
    );
  });

  it('is a function of its inputs alone, so a test can pin it', () => {
    fc.assert(
      fc.property(attemptsArb, unitArb, (attempts, unit) => {
        const options = { random: fixed(unit) };
        expect(backoffDelayMs(attempts, options)).toBe(backoffDelayMs(attempts, options));
      }),
    );
  });

  it('spreads correlated failures apart rather than retrying them in lockstep', () => {
    // The failure mode jitter exists for: network loss fails every in-flight upload in the same
    // instant, and without jitter they all come back at the same instant, forever.
    const draws = [0, 0.2, 0.4, 0.6, 0.8];
    const delays = draws.map((draw) => backoffDelayMs(4, { random: fixed(draw) }));
    expect(new Set(delays).size).toBe(draws.length);
  });
});

describe('nextAttemptAt', () => {
  it('is the delay measured from the injected now', () => {
    const now = 1_700_000_000_000;
    expect(nextAttemptAt(now, 1, { random: fixed(0) })).toBe(now + 500);
  });

  it('is always strictly in the future', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 45 }), attemptsArb, unitArb, (now, a, unit) => {
        expect(nextAttemptAt(now, a, { random: fixed(unit) })).toBeGreaterThan(now);
      }),
    );
  });
});
