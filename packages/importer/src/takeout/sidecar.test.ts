/**
 * Reading a Takeout sidecar's time fields (task 2.4).
 *
 * The sidecars here are written in Takeout's own layout, string timestamps and all, because the
 * trap this module exists to avoid is a reader that treats `"1560003751"` as a number and gets
 * `NaN`. A `NaN` capture time does not throw; it produces an asset that sorts nowhere.
 */

import { describe, expect, it } from 'vitest';

import { parseSidecarTimes } from './sidecar.ts';

/** A sidecar in Takeout's layout, with whatever the test wants in the time fields. */
function sidecar(fields: Record<string, unknown>): string {
  return JSON.stringify({ title: 'IMG_1234.jpg', description: '', imageViews: '0', ...fields });
}

const TAKEN = { timestamp: '1560003751', formatted: '8 Jun 2019, 14:22:31 UTC' };

describe('reading photoTakenTime and creationTime', () => {
  it('coerces the string timestamp Takeout actually writes', () => {
    const times = parseSidecarTimes(
      sidecar({
        photoTakenTime: TAKEN,
        creationTime: { timestamp: '1560046260', formatted: '9 Jun 2019, 02:11:00 UTC' },
      }),
    );

    expect(times.problems).toEqual([]);
    expect(times.photoTakenAt?.epochMs).toBe(Date.parse('2019-06-08T14:22:31Z'));
    expect(times.photoTakenAt?.raw).toBe('1560003751');
    // Upload time, kept separate and never a capture-time candidate.
    expect(times.creationAt?.epochMs).toBe(Date.parse('2019-06-09T02:11:00Z'));
  });

  it('derives the instant from timestamp, never from formatted', () => {
    const times = parseSidecarTimes(
      sidecar({
        photoTakenTime: { timestamp: '1560003751', formatted: '1 Jan 1999, 00:00:00 UTC' },
        creationTime: TAKEN,
      }),
    );

    expect(times.photoTakenAt?.epochMs).toBe(Date.parse('2019-06-08T14:22:31Z'));
    expect(times.photoTakenAt?.formatted).toBe('1 Jan 1999, 00:00:00 UTC');
  });

  it('accepts a numeric timestamp, which re-exports write', () => {
    const times = parseSidecarTimes(
      sidecar({ photoTakenTime: { timestamp: 1560003751 }, creationTime: TAKEN }),
    );
    expect(times.photoTakenAt?.epochMs).toBe(Date.parse('2019-06-08T14:22:31Z'));
  });

  it('reads a zero timestamp as absent, the way Takeout zero-fills geoData', () => {
    const times = parseSidecarTimes(
      sidecar({ photoTakenTime: { timestamp: '0', formatted: '' }, creationTime: TAKEN }),
    );

    expect(times.photoTakenAt).toBeNull();
    expect(times.problems).toEqual([
      'photoTakenTime.timestamp is 0, which Takeout writes for no value',
    ]);
  });

  it('keeps a pre-1970 timestamp, because scanned photos are older than the epoch', () => {
    const times = parseSidecarTimes(
      sidecar({ photoTakenTime: { timestamp: '-157766400' }, creationTime: TAKEN }),
    );
    expect(times.photoTakenAt?.epochMs).toBe(Date.parse('1965-01-01T00:00:00Z'));
  });

  it('reports a malformed field instead of inventing a capture time', () => {
    for (const value of ['abc', '', '1560003751.5', ' ']) {
      const times = parseSidecarTimes(
        sidecar({ photoTakenTime: { timestamp: value }, creationTime: TAKEN }),
      );
      expect(times.photoTakenAt).toBeNull();
      expect(times.problems).toHaveLength(1);
      expect(times.problems[0]).toMatch(/not epoch seconds/u);
    }
  });

  it('survives a sidecar that is not JSON, or not an object, or missing the fields', () => {
    expect(parseSidecarTimes('{ truncated').problems[0]).toMatch(/not valid JSON/u);
    expect(parseSidecarTimes('[]').problems[0]).toMatch(/not an object/u);

    const bare = parseSidecarTimes('{}');
    expect(bare.photoTakenAt).toBeNull();
    expect(bare.creationAt).toBeNull();
    expect(bare.problems).toEqual(['photoTakenTime is absent', 'creationTime is absent']);
  });
});
