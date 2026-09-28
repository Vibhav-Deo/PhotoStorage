/**
 * Timestamp provenance resolution (task 2.4, Requirements 1.2 and 1.3).
 *
 * This is the first half of `MetadataRepair` (design: Importer components). It consumes what
 * pairing concluded — a media file and, when there is one, the sidecar that describes it — and
 * decides the one number the timeline is ordered by, plus where that number came from.
 *
 * ## Precedence, and why the sidecar wins
 *
 * `sidecar.photoTakenTime` → EXIF `DateTimeOriginal` → file mtime, recorded in
 * `captured_at_src` (design: Timestamp provenance). Takeout frequently strips or rewrites EXIF
 * dates, so the sidecar wins **even when EXIF disagrees** (Requirement 1.2). The corpus's
 * `exact-sidecar` fixture is built to make that falsifiable: its EXIF says 2019-06-01, its mtime
 * says 2024-01-15 — the moment the archive was unpacked — and its sidecar says 2019-06-08. Only
 * one of the three is right, and a resolver that prefers EXIF because EXIF is "the real metadata"
 * backdates the photo by a week.
 *
 * mtime is last because in a Takeout export it is not a capture time at all. Every fixture but
 * one carries the download mtime, which is why it is normally in
 * {@link CapturedAtResolution.overruled} and why a resolution that lands on it is worth a line in
 * the reconciliation report.
 *
 * `creationTime` is nowhere in the order. It is when Google received the upload, and slotting it
 * in anywhere would let an upload timestamp beat a genuine EXIF capture date. `sidecar.ts` reads
 * it so the report can show it; this module never treats it as a candidate.
 *
 * ## Provenance is recorded, not discarded
 *
 * Requirement 1.3 asks for the provenance of the chosen timestamp, and the design says it is
 * stored "so a future correction pass can distinguish a trusted timestamp from a guess". So
 * {@link CapturedAtResolution} carries every candidate — including the ones that lost, with the
 * raw text each source recorded and the reason a source offered nothing — rather than only the
 * winner. `captured_at_src` is what persists in `assets`; the rest is what makes a disagreement
 * visible to task 2.12 and to any later correction pass.
 *
 * Resolution never fails. mtime is always available, so `captured_at` is always populated, which
 * is what the schema's `NOT NULL` requires and what "imported with degraded provenance, never
 * dropped" means in practice (Requirement 1.10).
 *
 * ## `tz_offset_min` is almost always null, and that is the honest answer
 *
 * The schema says "Minutes east of UTC at capture time. Null when the original recorded no
 * offset." Applied to a Takeout import, that leaves exactly one source:
 *
 * - **The sidecar cannot supply it.** `photoTakenTime.timestamp` is an absolute epoch instant,
 *   which carries no offset by construction, and `formatted` is that same instant rendered in a
 *   zone Google picked. Neither says where the camera was. So a sidecar-sourced timestamp gets a
 *   null offset — never the exporting user's zone, never the importing machine's zone.
 * - **mtime cannot supply it.** Also an absolute instant, and it is the unpack time anyway.
 * - **EXIF `OffsetTimeOriginal` can**, and it is the only thing that can. It is a separate tag
 *   from `DateTimeOriginal`, added in EXIF 2.31, and Takeout rarely preserves it.
 *
 * There is one more constraint. An offset qualifies the EXIF instant, so it only describes the
 * resolved `capturedAt` if the EXIF instant *is* the resolved instant. When the sidecar wins over
 * a disagreeing EXIF date, the surviving `OffsetTimeOriginal` describes the timestamp that was
 * just rejected, and carrying it across would attach a zone to an instant it was never about.
 * So: **`tzOffsetMin` is populated only from `OffsetTimeOriginal`, and only when the EXIF instant
 * it qualifies equals the resolved `capturedAt`.** That covers the useful case — EXIF and sidecar
 * agreeing, with EXIF adding the zone the sidecar could not carry — and refuses the guess.
 *
 * A null offset is not the same as UTC. It means the archive does not know, so a client renders
 * the instant in the viewer's zone rather than claiming to show local time at capture.
 */

import { CapturedAtSource } from '@photo-archive/core';

import {
  canCarryReadableExif,
  parseExifDateTimeMs,
  parseExifOffsetMinutes,
  readExifCaptureFields,
} from './exif.ts';
import type { ExifCaptureFields, ExifCaptureReader } from './exif.ts';
import type { PairingResult } from './pairing.ts';
import { readSidecarTimes } from './sidecar.ts';
import type { SidecarTimes, SidecarTimesReader } from './sidecar.ts';
import type { TakeoutFile } from './traversal.ts';

/**
 * The order the three sources are consulted in, highest first (design: Timestamp provenance).
 *
 * `CapturedAtSource.User` is absent on purpose: a manual correction outranks everything, and it
 * cannot exist during an import because there is no asset yet for a user to have corrected.
 */
export const CAPTURED_AT_PRECEDENCE: readonly CapturedAtSource[] = [
  CapturedAtSource.TakeoutJson,
  CapturedAtSource.Exif,
  CapturedAtSource.FileMtime,
];

/** What one source had to say. Kept whether it won or lost (Requirement 1.3). */
export interface CapturedAtCandidate {
  readonly source: CapturedAtSource;
  /** The instant this source offers, epoch milliseconds, or null when it offered none. */
  readonly capturedAt: number | null;
  /**
   * The offset this source can honestly attest, minutes east of UTC. Non-null only for
   * {@link CapturedAtSource.Exif} carrying `OffsetTimeOriginal`; see this module's header.
   */
  readonly tzOffsetMin: number | null;
  /** The value as the source recorded it, verbatim, for diagnosis. */
  readonly raw: string | null;
  /** Why this source offered nothing. Null when {@link capturedAt} is set. */
  readonly problem: string | null;
}

/** A candidate that is always available, so the resolution always has a floor. */
interface FloorCandidate extends CapturedAtCandidate {
  readonly capturedAt: number;
}

/** The resolved capture time, its provenance, and everything that was considered. */
export interface CapturedAtResolution {
  /** Epoch milliseconds. `assets.captured_at`. Always populated. */
  readonly capturedAt: number;
  /** `assets.captured_at_src`. */
  readonly capturedAtSource: CapturedAtSource;
  /** `assets.tz_offset_min`. Null unless EXIF recorded an offset for this very instant. */
  readonly tzOffsetMin: number | null;
  /** Every source, in {@link CAPTURED_AT_PRECEDENCE} order, whether it offered anything or not. */
  readonly candidates: readonly CapturedAtCandidate[];
  /**
   * Sources that offered a *different* instant than the winner, in precedence order.
   *
   * {@link CapturedAtSource.FileMtime} is in here for nearly every file in a Takeout export,
   * because the mtime is when the archive was unpacked. That is not noise, it is the reason mtime
   * is last in the order; task 2.12 decides what is worth reporting.
   */
  readonly overruled: readonly CapturedAtSource[];
}

// ---------------------------------------------------------------------------
// Building the three candidates
// ---------------------------------------------------------------------------

function takeoutCandidate(sidecar: SidecarTimes | null): CapturedAtCandidate {
  if (sidecar === null) {
    return {
      source: CapturedAtSource.TakeoutJson,
      capturedAt: null,
      tzOffsetMin: null,
      raw: null,
      problem: 'no sidecar paired with this file',
    };
  }
  const taken = sidecar.photoTakenAt;
  if (taken === null) {
    return {
      source: CapturedAtSource.TakeoutJson,
      capturedAt: null,
      tzOffsetMin: null,
      raw: null,
      problem: sidecar.problems.join('; ') || 'sidecar records no photoTakenTime',
    };
  }
  return {
    source: CapturedAtSource.TakeoutJson,
    capturedAt: taken.epochMs,
    // An absolute epoch instant carries no offset. See this module's header.
    tzOffsetMin: null,
    raw: taken.raw,
    problem: null,
  };
}

function exifCandidate(exif: ExifCaptureFields | null): CapturedAtCandidate {
  if (exif === null) {
    return {
      source: CapturedAtSource.Exif,
      capturedAt: null,
      tzOffsetMin: null,
      raw: null,
      problem: 'EXIF was not read for this file',
    };
  }
  const offsetMinutes = parseExifOffsetMinutes(exif.offsetTimeOriginal);
  const capturedAt = parseExifDateTimeMs(exif.dateTimeOriginal, offsetMinutes);
  if (capturedAt === null) {
    return {
      source: CapturedAtSource.Exif,
      capturedAt: null,
      tzOffsetMin: null,
      raw: exif.dateTimeOriginal,
      problem:
        exif.problem ??
        (exif.dateTimeOriginal === null
          ? 'EXIF records no DateTimeOriginal'
          : `EXIF DateTimeOriginal ${JSON.stringify(exif.dateTimeOriginal)} is not a real date`),
    };
  }
  return {
    source: CapturedAtSource.Exif,
    capturedAt,
    tzOffsetMin: offsetMinutes,
    raw:
      exif.offsetTimeOriginal === null
        ? exif.dateTimeOriginal
        : `${exif.dateTimeOriginal ?? ''}${exif.offsetTimeOriginal}`,
    problem: null,
  };
}

/**
 * mtime, the floor of the order.
 *
 * A non-finite mtime still yields an instant, because `captured_at` is `NOT NULL` and there is
 * nothing left to fall back to. Epoch zero with `FileMtime` provenance and a problem line is a
 * visibly wrong timestamp that says so, which is the whole point of storing provenance.
 */
function mtimeCandidate(mtimeMs: number): FloorCandidate {
  const finite = Number.isFinite(mtimeMs);
  return {
    source: CapturedAtSource.FileMtime,
    capturedAt: finite ? Math.floor(mtimeMs) : 0,
    tzOffsetMin: null,
    raw: finite ? String(Math.floor(mtimeMs)) : null,
    problem: finite ? null : `file mtime is ${String(mtimeMs)}, so no timestamp is available`,
  };
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** What the resolver needs. Stated rather than read, so the rule is testable without a disk. */
export interface CapturedAtInputs {
  /** The paired sidecar's times, or null when the file is unpaired. */
  readonly sidecar: SidecarTimes | null;
  /** What the EXIF reader found, or null when EXIF was not read for this container. */
  readonly exif: ExifCaptureFields | null;
  /** `TakeoutFile.mtimeMs`. */
  readonly mtimeMs: number;
}

/**
 * Applies the precedence order to one file's sources.
 *
 * Pure, synchronous, and the whole rule in one place. Everything below it is I/O.
 */
export function resolveCapturedAt(inputs: CapturedAtInputs): CapturedAtResolution {
  const takeout = takeoutCandidate(inputs.sidecar);
  const exif = exifCandidate(inputs.exif);
  const mtime = mtimeCandidate(inputs.mtimeMs);
  const candidates: readonly CapturedAtCandidate[] = [takeout, exif, mtime];

  // First source in precedence order that offered an instant. mtime always does, so this
  // terminates without a null case to invent an answer for.
  const chosen: CapturedAtCandidate =
    takeout.capturedAt !== null ? takeout : exif.capturedAt !== null ? exif : mtime;
  const capturedAt = chosen.capturedAt ?? mtime.capturedAt;

  // An offset qualifies the EXIF instant, so it only describes `capturedAt` when the two are the
  // same instant. See this module's header for why carrying it across otherwise is a guess.
  const tzOffsetMin =
    exif.tzOffsetMin !== null && exif.capturedAt === capturedAt ? exif.tzOffsetMin : null;

  return {
    capturedAt,
    capturedAtSource: chosen.source,
    tzOffsetMin,
    candidates,
    overruled: candidates
      .filter(
        (candidate) =>
          candidate.source !== chosen.source &&
          candidate.capturedAt !== null &&
          candidate.capturedAt !== capturedAt,
      )
      .map((candidate) => candidate.source),
  };
}

// ---------------------------------------------------------------------------
// Reading the sources off disk
// ---------------------------------------------------------------------------

/** Seams for the two readers, so a test can state inputs instead of materializing files. */
export interface ResolveTimestampsOptions {
  /** Defaults to {@link readExifCaptureFields}. Task 2.7 will supply a richer one. */
  readonly readExif?: ExifCaptureReader;
  /** Defaults to {@link readSidecarTimes}. */
  readonly readSidecar?: SidecarTimesReader;
}

/**
 * Resolves one media file's capture time, reading its sidecar and its EXIF.
 *
 * EXIF is read only for containers the reader understands (`canCarryReadableExif`). Probing a
 * `.mov` or a `.heic` would cost a read per file across an export that may be 2 TB and find
 * nothing, and the candidate records that EXIF was not read rather than that it was absent — a
 * distinction a later pass needs, because a richer reader could change the answer.
 */
export async function resolveMediaCapturedAt(
  media: TakeoutFile,
  sidecar: TakeoutFile | null,
  options: ResolveTimestampsOptions = {},
): Promise<CapturedAtResolution> {
  const readSidecar = options.readSidecar ?? readSidecarTimes;
  const readExif = options.readExif ?? readExifCaptureFields;

  return resolveCapturedAt({
    sidecar: sidecar === null ? null : await readSidecar(sidecar.absolutePath),
    exif: canCarryReadableExif(media.name) ? await readExif(media.absolutePath) : null,
    mtimeMs: media.mtimeMs,
  });
}

/**
 * Resolves every media file in a paired export, keyed by `TakeoutFile.sourcePath`.
 *
 * Paired and unpaired media both, because an unpaired file is imported with degraded provenance
 * rather than dropped (Requirement 1.10) and still needs a `captured_at`.
 *
 * Sidecars are read once each: a Live Photo's still and its motion component share one sidecar,
 * and they must resolve to the same instant, which is what makes the MOV sort with its still
 * instead of landing on the unpack mtime.
 *
 * Sequential on purpose. Concurrency and resumption belong to the job queue's `ExtractMeta` stage
 * (task 2.11); a bare `Promise.all` over a 500k-item export would open 500k file handles.
 */
export async function resolveExportTimestamps(
  pairing: PairingResult,
  options: ResolveTimestampsOptions = {},
): Promise<ReadonlyMap<string, CapturedAtResolution>> {
  const readSidecar = options.readSidecar ?? readSidecarTimes;
  const sidecarCache = new Map<string, SidecarTimes>();
  const cachingReader: SidecarTimesReader = async (absolutePath) => {
    const cached = sidecarCache.get(absolutePath);
    if (cached !== undefined) return cached;
    const times = await readSidecar(absolutePath);
    sidecarCache.set(absolutePath, times);
    return times;
  };
  const withCache: ResolveTimestampsOptions = { ...options, readSidecar: cachingReader };

  const resolved = new Map<string, CapturedAtResolution>();
  for (const pair of pairing.pairings) {
    resolved.set(
      pair.media.sourcePath,
      await resolveMediaCapturedAt(pair.media, pair.sidecar, withCache),
    );
  }
  for (const unpaired of pairing.unpaired) {
    resolved.set(
      unpaired.media.sourcePath,
      await resolveMediaCapturedAt(unpaired.media, null, withCache),
    );
  }
  return resolved;
}
