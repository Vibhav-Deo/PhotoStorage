/**
 * Timestamp provenance resolution against the fixture corpus (task 2.4, Requirements 1.2, 1.3).
 *
 * The corpus is the input and its declared expectations are the oracle: every fixture states the
 * capture time the importer must resolve **and** the `CapturedAtSource` it must record, so a
 * resolver that lands on the right instant from the wrong source fails here rather than passing
 * until a later change moves it off the source it was accidentally relying on.
 *
 * The fixture that matters most is `exact-sidecar`. Its three sources all disagree — EXIF says
 * 2019-06-01, mtime says 2024-01-15, the sidecar says 2019-06-08 — and only the sidecar is right
 * (Requirement 1.2). Its EXIF is a real APP1 segment written into the JPEG, not an assertion in a
 * comment, so a resolver that never reads EXIF at all cannot claim credit for that test.
 *
 * `tz_offset_min` gets its own group, because the corpus cannot cover it: Takeout strips
 * `OffsetTimeOriginal`, so every fixture must resolve to a null offset, and the cases where an
 * offset *is* recorded are stated directly against the pure resolver.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { CapturedAtSource } from '@photo-archive/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ExifCaptureFields } from './exif.ts';
import { buildCorpus } from './fixtures/buildCorpus.ts';
import { PART_001, PART_002, PART_003, TAKEOUT_CORPUS, fixtureById } from './fixtures/corpus.ts';
import type { MediaFixture } from './fixtures/corpusTypes.ts';
import { pairExport } from './pairing.ts';
import type { SidecarTimes } from './sidecar.ts';
import { resolveCapturedAt, resolveExportTimestamps } from './timestamps.ts';
import type { CapturedAtResolution } from './timestamps.ts';
import { traverseExport } from './traversal.ts';

const PARTS = [PART_001, PART_002, PART_003] as const;

let root: string;
let resolved: ReadonlyMap<string, CapturedAtResolution>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-timestamps-'));
  await buildCorpus(root);
  const exportSet = await traverseExport(PARTS.map((part) => path.join(root, part)));
  resolved = await resolveExportTimestamps(pairExport(exportSet));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The logical path a fixture's media occupies, which is also its source path. */
function resolutionFor(fixture: MediaFixture): CapturedAtResolution {
  const found = resolved.get(`${fixture.folder}/${fixture.file}`.normalize('NFC'));
  if (found === undefined) {
    throw new Error(`no resolution for ${fixture.id}; traversal or pairing dropped it`);
  }
  return found;
}

function candidate(
  resolution: CapturedAtResolution,
  source: CapturedAtSource,
): CapturedAtResolution['candidates'][number] {
  const found = resolution.candidates.find((entry) => entry.source === source);
  if (found === undefined) throw new Error(`no candidate recorded for source ${String(source)}`);
  return found;
}

// ---------------------------------------------------------------------------
// The whole corpus
// ---------------------------------------------------------------------------

describe('the corpus resolves as declared', () => {
  it.each(TAKEOUT_CORPUS.media.map((fixture) => [fixture.id, fixture] as const))(
    '%s',
    (_id, fixture) => {
      const resolution = resolutionFor(fixture);
      expect(resolution.capturedAt).toBe(Date.parse(fixture.expect.capturedAt));
      expect(resolution.capturedAtSource).toBe(fixture.expect.capturedAtSource);
    },
  );

  it('resolves every media file, paired or not', () => {
    expect(resolved.size).toBe(TAKEOUT_CORPUS.media.length);
  });

  it('records a null offset throughout, because Takeout strips OffsetTimeOriginal', () => {
    for (const fixture of TAKEOUT_CORPUS.media) {
      expect(resolutionFor(fixture).tzOffsetMin).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The case the task exists for
// ---------------------------------------------------------------------------

describe('the sidecar wins when EXIF disagrees (Requirement 1.2)', () => {
  it('takes 2019-06-08 from the sidecar over EXIF and mtime', () => {
    const fixture = fixtureById('exact-sidecar');
    if (fixture === undefined) throw new Error('the exact-sidecar fixture is gone');
    const resolution = resolutionFor(fixture);

    expect(resolution.capturedAt).toBe(Date.parse('2019-06-08T14:22:31Z'));
    expect(resolution.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
  });

  it('keeps the rejected timestamps rather than discarding them (Requirement 1.3)', () => {
    const fixture = fixtureById('exact-sidecar');
    if (fixture === undefined) throw new Error('the exact-sidecar fixture is gone');
    const resolution = resolutionFor(fixture);

    // Read from the JPEG's real APP1 segment, and a week earlier than the truth.
    const exif = candidate(resolution, CapturedAtSource.Exif);
    expect(exif.capturedAt).toBe(Date.parse('2019-06-01T08:00:00Z'));
    expect(exif.raw).toBe('2019:06:01 08:00:00');

    // The moment the archive was unpacked, five years out.
    const mtime = candidate(resolution, CapturedAtSource.FileMtime);
    expect(mtime.capturedAt).toBe(Date.parse('2024-01-15T10:15:30Z'));

    // Both losing sources are named, so a later correction pass can see the disagreement.
    expect(resolution.overruled).toEqual([CapturedAtSource.Exif, CapturedAtSource.FileMtime]);
  });

  it('never lets creationTime, which is upload time, decide anything', () => {
    // A sidecar with an upload time and no capture time falls through to EXIF, not to the upload.
    const sidecar: SidecarTimes = {
      photoTakenAt: null,
      creationAt: {
        epochMs: Date.parse('2019-06-09T02:11:00Z'),
        raw: '1560046260',
        formatted: null,
      },
      problems: ['photoTakenTime is absent'],
    };
    const exif: ExifCaptureFields = {
      dateTimeOriginal: '2019:06:01 08:00:00',
      offsetTimeOriginal: null,
      truncated: false,
      problem: null,
    };

    const resolution = resolveCapturedAt({
      sidecar,
      exif,
      mtimeMs: Date.parse('2024-01-15T10:15:30Z'),
    });

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.Exif);
    expect(resolution.capturedAt).toBe(Date.parse('2019-06-01T08:00:00Z'));
    expect(candidate(resolution, CapturedAtSource.TakeoutJson).problem).toBe(
      'photoTakenTime is absent',
    );
  });
});

describe('degraded provenance is recorded, never fatal', () => {
  it('falls back to mtime with no sidecar and no EXIF', () => {
    const fixture = fixtureById('unpaired-video');
    if (fixture === undefined) throw new Error('the unpaired-video fixture is gone');
    const resolution = resolutionFor(fixture);

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.FileMtime);
    expect(resolution.capturedAt).toBe(Date.parse('2021-07-04T12:13:14Z'));
    // The mp4 is not a container this reader parses, and the candidate says so rather than
    // claiming the file has no EXIF date.
    expect(candidate(resolution, CapturedAtSource.Exif).problem).toBe(
      'EXIF was not read for this file',
    );
  });

  it('gives a Live Photo pair one instant from the sidecar they share', () => {
    const still = fixtureById('live-photo-still');
    const motion = fixtureById('live-photo-motion');
    if (still === undefined || motion === undefined)
      throw new Error('Live Photo fixtures are gone');

    const stillResolution = resolutionFor(still);
    const motionResolution = resolutionFor(motion);

    expect(motionResolution.capturedAt).toBe(stillResolution.capturedAt);
    // Not mtime: the MOV would otherwise land in 2024 and sort away from its own still.
    expect(motionResolution.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
  });

  it('reads a sidecar in another archive part, so the file is not backdated to the unpack', () => {
    const fixture = fixtureById('cross-part-sidecar');
    if (fixture === undefined) throw new Error('the cross-part-sidecar fixture is gone');
    const resolution = resolutionFor(fixture);

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
    expect(resolution.capturedAt).toBe(Date.parse('2021-09-09T07:07:07Z'));
  });
});

// ---------------------------------------------------------------------------
// tz_offset_min
// ---------------------------------------------------------------------------

function exifFields(
  dateTimeOriginal: string | null,
  offsetTimeOriginal: string | null,
): ExifCaptureFields {
  return { dateTimeOriginal, offsetTimeOriginal, truncated: false, problem: null };
}

function sidecarAt(iso: string): SidecarTimes {
  const epochMs = Date.parse(iso);
  return {
    photoTakenAt: { epochMs, raw: String(epochMs / 1000), formatted: null },
    creationAt: null,
    problems: [],
  };
}

const UNPACK_MTIME = Date.parse('2024-01-15T10:15:30Z');

describe('tz_offset_min comes only from OffsetTimeOriginal, and only for the winning instant', () => {
  it('is populated when EXIF wins and recorded an offset', () => {
    const resolution = resolveCapturedAt({
      sidecar: null,
      exif: exifFields('2019:08:14 11:02:44', '+02:00'),
      mtimeMs: UNPACK_MTIME,
    });

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.Exif);
    // The naive reading is local time at capture, so the instant is two hours earlier.
    expect(resolution.capturedAt).toBe(Date.parse('2019-08-14T09:02:44Z'));
    expect(resolution.tzOffsetMin).toBe(120);
  });

  it('is null when EXIF wins with no offset recorded, rather than claiming UTC', () => {
    const resolution = resolveCapturedAt({
      sidecar: null,
      exif: exifFields('2019:08:14 11:02:44', null),
      mtimeMs: UNPACK_MTIME,
    });

    expect(resolution.capturedAt).toBe(Date.parse('2019-08-14T11:02:44Z'));
    expect(resolution.tzOffsetMin).toBeNull();
  });

  it('carries the offset across when the sidecar wins and EXIF agrees on the instant', () => {
    // The useful case: the sidecar has the instant, EXIF adds the zone the sidecar cannot carry.
    const resolution = resolveCapturedAt({
      sidecar: sidecarAt('2019-06-08T14:22:31Z'),
      exif: exifFields('2019:06:08 16:22:31', '+02:00'),
      mtimeMs: UNPACK_MTIME,
    });

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
    expect(resolution.capturedAt).toBe(Date.parse('2019-06-08T14:22:31Z'));
    expect(resolution.tzOffsetMin).toBe(120);
    expect(resolution.overruled).toEqual([CapturedAtSource.FileMtime]);
  });

  it('drops the offset when the EXIF date it qualifies was overruled', () => {
    // The offset describes the timestamp that was just rejected, so attaching it to the
    // sidecar's instant would claim a zone for a moment it was never about.
    const resolution = resolveCapturedAt({
      sidecar: sidecarAt('2019-06-08T14:22:31Z'),
      exif: exifFields('2019:06:01 08:00:00', '+02:00'),
      mtimeMs: UNPACK_MTIME,
    });

    expect(resolution.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
    expect(resolution.tzOffsetMin).toBeNull();
    expect(resolution.overruled).toEqual([CapturedAtSource.Exif, CapturedAtSource.FileMtime]);
  });

  it('is null for a sidecar-only and for an mtime-only resolution', () => {
    expect(
      resolveCapturedAt({
        sidecar: sidecarAt('2019-06-08T14:22:31Z'),
        exif: null,
        mtimeMs: UNPACK_MTIME,
      }).tzOffsetMin,
    ).toBeNull();

    const floor = resolveCapturedAt({ sidecar: null, exif: null, mtimeMs: UNPACK_MTIME });
    expect(floor.capturedAtSource).toBe(CapturedAtSource.FileMtime);
    expect(floor.tzOffsetMin).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rule, over arbitrary arrangements of the three sources
// ---------------------------------------------------------------------------

describe('the precedence order holds for any arrangement of sources', () => {
  /** Instants within a range an archive plausibly holds, at second granularity. */
  const instant = fc
    .integer({ min: Date.parse('1900-01-01T00:00:00Z') / 1000, max: 2_000_000_000 })
    .map((seconds) => seconds * 1000);

  const exifDate = fc
    .tuple(instant, fc.option(fc.integer({ min: -14 * 60, max: 14 * 60 })))
    .map(([epochMs, offsetMinutes]): { fields: ExifCaptureFields; epochMs: number } => {
      const local = new Date(epochMs + (offsetMinutes ?? 0) * 60_000);
      const pad = (value: number): string => String(value).padStart(2, '0');
      const text =
        `${String(local.getUTCFullYear()).padStart(4, '0')}:${pad(local.getUTCMonth() + 1)}:` +
        `${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:` +
        `${pad(local.getUTCSeconds())}`;
      const sign = (offsetMinutes ?? 0) < 0 ? '-' : '+';
      const magnitude = Math.abs(offsetMinutes ?? 0);
      return {
        fields: exifFields(
          text,
          offsetMinutes === null
            ? null
            : `${sign}${pad(Math.floor(magnitude / 60))}:${pad(magnitude % 60)}`,
        ),
        epochMs,
      };
    });

  it('chooses the highest-precedence source that offered an instant, and says which', () => {
    fc.assert(
      fc.property(fc.option(instant), fc.option(exifDate), instant, (sidecarMs, exif, mtimeMs) => {
        const resolution = resolveCapturedAt({
          sidecar: sidecarMs === null ? null : sidecarAt(new Date(sidecarMs).toISOString()),
          exif: exif?.fields ?? null,
          mtimeMs,
        });

        const expected =
          sidecarMs !== null
            ? { source: CapturedAtSource.TakeoutJson, at: sidecarMs }
            : exif !== null
              ? { source: CapturedAtSource.Exif, at: exif.epochMs }
              : { source: CapturedAtSource.FileMtime, at: mtimeMs };

        expect(resolution.capturedAtSource).toBe(expected.source);
        expect(resolution.capturedAt).toBe(expected.at);

        // The recorded source is never one that offered nothing.
        expect(candidate(resolution, resolution.capturedAtSource).capturedAt).toBe(
          resolution.capturedAt,
        );

        // An offset is only ever claimed when EXIF recorded one for this very instant.
        if (resolution.tzOffsetMin !== null) {
          expect(exif?.fields.offsetTimeOriginal).not.toBeNull();
          expect(exif?.epochMs).toBe(resolution.capturedAt);
        }

        // Every source is accounted for, in precedence order, win or lose.
        expect(resolution.candidates.map((entry) => entry.source)).toEqual([
          CapturedAtSource.TakeoutJson,
          CapturedAtSource.Exif,
          CapturedAtSource.FileMtime,
        ]);
      }),
      { numRuns: 300 },
    );
  });
});
