/**
 * Reading Takeout's JSON: the sidecar fields the pipeline needs, and an album's `metadata.json`
 * (tasks 2.4 and 2.6, Requirements 1.2, 1.3, and 1.7).
 *
 * Pairing (task 2.3) decides *which* JSON describes which media file and never opens it. This is
 * the module that reads one. It began as the time fields alone (task 2.4) and task 2.6 added the
 * two things album reconstruction needs: {@link parseAlbumMetadata} for an album's title and date,
 * and {@link parseSidecarFlags} for the `archived` and `trashed` flags.
 *
 * Every reader here comes in two halves — a pure `parse*` over text and a `read*` that opens a
 * file — for the same reason: the rules are then testable from a string, and task 2.11 can read a
 * sidecar **once** and apply both parsers to the same text rather than opening every JSON in a
 * 2 TB export twice.
 *
 * `geoData` and `people` are still unread, and deliberately so. `assets.lat` / `.lon` are
 * populated by the `ExtractMeta` stage from EXIF *and* the sidecar together, which is task 2.11's
 * wiring rather than album reconstruction's, and there is no column anywhere for `people` until
 * face clustering leaves the deferred list. The one thing worth knowing before either is written
 * is already recorded below: Takeout writes `0, 0` for a photo with no location, so a reader that
 * does not treat zero as absent puts the photo in the Atlantic.
 *
 * ## Takeout's layout, and the trap in it
 *
 * ```json
 * "photoTakenTime": { "timestamp": "1560003751", "formatted": "8 Jun 2019, 14:22:31 UTC" },
 * "creationTime":   { "timestamp": "1560046260", "formatted": "9 Jun 2019, 02:11:00 UTC" }
 * ```
 *
 * **`timestamp` is seconds since the epoch as a string.** A reader that treats it as a number
 * gets `NaN`, and `NaN` flowing into a date is the kind of failure that produces a plausible-
 * looking empty timeline rather than an error. `fixtures/buildCorpus.ts` writes it as a string
 * on purpose so a parser that forgets to coerce cannot pass the corpus.
 *
 * `formatted` is rendered text and is never parsed. It is carried verbatim for diagnostics only:
 * it is a rendering of the same instant in whatever zone Google chose, so parsing it would be a
 * second, worse route to a number we already have exactly.
 *
 * ## `creationTime` is upload time
 *
 * It is when the file arrived in Google Photos, not when the shutter fired, and it is routinely
 * hours or years later — the corpus has both. It is read here so the reconciliation report can
 * show it, and `timestamps.ts` never considers it a capture-time candidate. That is deliberate
 * and load-bearing: the design's precedence is `photoTakenTime` → EXIF → mtime, and slotting
 * `creationTime` in anywhere would beat a real EXIF date with an upload timestamp.
 *
 * ## Zero means absent
 *
 * Takeout zero-fills rather than omits. `geoData` is written as `0, 0` for a photo with no
 * location — which a later task must read as absent rather than as a point in the Atlantic — and
 * a timestamp it does not have is written as `"0"`. So epoch zero is treated as no value here,
 * rather than as midnight on 1 January 1970. Negative timestamps are *not* rejected: a scanned
 * photo dated 1965 is a real thing an archive has to hold.
 *
 * Nothing here throws. A sidecar that is missing, unreadable, not JSON, or missing its time
 * fields yields nulls plus one {@link SidecarTimes.problems} line each, because pairing already
 * proved this sidecar belongs to this media file and losing the whole item over a malformed
 * field would contradict Requirement 1.10. The same holds for `metadata.json`: a folder is an
 * album because the file is *there*, so an unreadable one yields a null title and a problem line
 * rather than an error, and `albums.ts` falls back to the folder name. Refusing the album instead
 * would lose its membership, which is the one thing the file cannot be reconstructed from.
 */

import * as fs from 'node:fs/promises';

/** One of Takeout's `{ timestamp, formatted }` pairs, read. */
export interface TakeoutTime {
  /** The instant, in epoch milliseconds. Derived from `timestamp`, never from `formatted`. */
  readonly epochMs: number;
  /** `timestamp` verbatim, as Takeout wrote it. Seconds since the epoch, as a string. */
  readonly raw: string;
  /** `formatted` verbatim. Display and diagnostics only; never parsed. */
  readonly formatted: string | null;
}

/** The time fields of one sidecar. */
export interface SidecarTimes {
  /**
   * `photoTakenTime`. Authoritative for capture time, even when EXIF disagrees
   * (Requirement 1.2).
   */
  readonly photoTakenAt: TakeoutTime | null;
  /**
   * `creationTime`. Upload time. Read for the reconciliation report and **never** a capture-time
   * candidate.
   */
  readonly creationAt: TakeoutTime | null;
  /** One line per field that could not be read. Empty for an ordinary sidecar. */
  readonly problems: readonly string[];
}

/**
 * How `timestamps.ts` obtains a sidecar's times, so the resolver can be driven from stated
 * inputs in a test without a filesystem. Takes an absolute path, because that is the only path
 * field on a `TakeoutFile` that is safe to open.
 *
 * Implementations must not throw.
 */
export type SidecarTimesReader = (absolutePath: string) => Promise<SidecarTimes>;

function empty(problem: string): SidecarTimes {
  return { photoTakenAt: null, creationAt: null, problems: [problem] };
}

/** True for a JSON object, which is what every field this module reads is nested in. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Takeout JSON as an object, or the one reason it is not usable.
 *
 * Shared by all three parsers so that "not JSON" and "not an object" read identically whichever
 * file they came from, and so a malformed file yields one problem line rather than one per field.
 */
function parseJsonObject(text: string): {
  readonly body: Record<string, unknown> | null;
  readonly problem: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: unknown) {
    return { body: null, problem: `not valid JSON: ${describeCause(cause)}` };
  }
  return isRecord(parsed)
    ? { body: parsed, problem: '' }
    : { body: null, problem: 'JSON is not an object' };
}

interface FieldResult {
  readonly time: TakeoutTime | null;
  readonly problem: string | null;
}

/**
 * One `{ timestamp, formatted }` field.
 *
 * `timestamp` is accepted as a string, which is what Takeout writes, or as a number, which some
 * third-party re-exports write. Anything else — an object, a decimal, a value that does not
 * coerce — is a problem rather than a guess, because the alternative to refusing is inventing a
 * capture time.
 */
function readTimeField(body: Record<string, unknown>, field: string): FieldResult {
  const raw = body[field];
  if (raw === undefined) {
    return { time: null, problem: `${field} is absent` };
  }
  if (!isRecord(raw)) {
    return { time: null, problem: `${field} is not a { timestamp, formatted } object` };
  }

  const timestamp = raw.timestamp;
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') {
    return { time: null, problem: `${field}.timestamp is not a string or a number` };
  }
  const text = String(timestamp).trim();
  const seconds = text.length === 0 ? Number.NaN : Number(text);
  if (!Number.isInteger(seconds)) {
    return {
      time: null,
      problem: `${field}.timestamp is ${JSON.stringify(text)}, which is not epoch seconds`,
    };
  }
  if (seconds === 0) {
    // Takeout zero-fills a value it does not have, exactly as it does for geoData.
    return { time: null, problem: `${field}.timestamp is 0, which Takeout writes for no value` };
  }

  const formatted = raw.formatted;
  return {
    time: {
      epochMs: seconds * 1000,
      raw: text,
      formatted: typeof formatted === 'string' ? formatted : null,
    },
    problem: null,
  };
}

/** The time fields in sidecar JSON text. Pure, so the whole path is testable from a string. */
export function parseSidecarTimes(text: string): SidecarTimes {
  const parsed = parseJsonObject(text);
  if (parsed.body === null) {
    return empty(`sidecar ${parsed.problem}`);
  }

  const taken = readTimeField(parsed.body, 'photoTakenTime');
  const created = readTimeField(parsed.body, 'creationTime');
  const problems = [taken.problem, created.problem].filter(
    (problem): problem is string => problem !== null,
  );

  return { photoTakenAt: taken.time, creationAt: created.time, problems };
}

/** The default {@link SidecarTimesReader}. */
export async function readSidecarTimes(absolutePath: string): Promise<SidecarTimes> {
  try {
    return parseSidecarTimes(await fs.readFile(absolutePath, 'utf8'));
  } catch (cause: unknown) {
    return empty(`cannot read sidecar ${absolutePath}: ${describeCause(cause)}`);
  }
}

// ---------------------------------------------------------------------------
// The archived / trashed flags (task 2.6)
// ---------------------------------------------------------------------------

/**
 * The two state flags a sidecar carries, for the design's `Archive/`, `Trash/` row.
 *
 * Both are omitted by Takeout when false rather than written as `false`, so absence is the
 * ordinary case and produces no {@link problems} line. A field present but not boolean does
 * produce one: it means this export does not have the shape this reader was written against, and
 * an unnoticed `"trashed": "true"` read as false would silently import items the user deleted.
 *
 * `favorited` is not here. `assets.favorite` is a real column and reading the flag is three
 * lines, but nothing in tasks 2.6 or earlier writes that column and a field read into a value
 * nobody persists is untested by construction. It belongs with the `ExtractMeta` wiring.
 */
export interface SidecarFlags {
  /** Google Photos' Archive. The item is hidden from the main grid but is not deleted. */
  readonly archived: boolean;
  /**
   * Pending deletion. Takeout spells the field `trashed`; this is spelled `inTrash` to match
   * the fixture corpus and to keep the past participle from reading as an action.
   */
  readonly inTrash: boolean;
  /** One line per field that was present but unreadable. Empty for an ordinary sidecar. */
  readonly problems: readonly string[];
}

/** How `albums.ts` obtains a sidecar's flags, so the rules are drivable without a filesystem. */
export type SidecarFlagsReader = (absolutePath: string) => Promise<SidecarFlags>;

/**
 * One boolean field. Absent is false and silent; present-but-not-boolean is false and loud.
 *
 * `"true"` as a string is rejected rather than coerced, on the same grounds as a non-numeric
 * timestamp: coercion here would be a guess about an export shape nobody has seen, and the
 * guess that matters — a trashed item read as not trashed — imports what the user deleted.
 */
function readBooleanField(
  body: Record<string, unknown>,
  field: string,
): { readonly value: boolean; readonly problem: string | null } {
  const raw = body[field];
  if (raw === undefined || raw === null) return { value: false, problem: null };
  if (typeof raw !== 'boolean') {
    return {
      value: false,
      problem: `${field} is ${JSON.stringify(raw)}, which is not a boolean, so it is read as false`,
    };
  }
  return { value: raw, problem: null };
}

/** The flag fields in sidecar JSON text. Pure, so the whole path is testable from a string. */
export function parseSidecarFlags(text: string): SidecarFlags {
  const parsed = parseJsonObject(text);
  if (parsed.body === null) {
    return { archived: false, inTrash: false, problems: [parsed.problem] };
  }

  const archived = readBooleanField(parsed.body, 'archived');
  const trashed = readBooleanField(parsed.body, 'trashed');
  return {
    archived: archived.value,
    inTrash: trashed.value,
    problems: [archived.problem, trashed.problem].filter(
      (problem): problem is string => problem !== null,
    ),
  };
}

/** The default {@link SidecarFlagsReader}. */
export async function readSidecarFlags(absolutePath: string): Promise<SidecarFlags> {
  try {
    return parseSidecarFlags(await fs.readFile(absolutePath, 'utf8'));
  } catch (cause: unknown) {
    return {
      archived: false,
      inTrash: false,
      problems: [`cannot read sidecar ${absolutePath}: ${describeCause(cause)}`],
    };
  }
}

// ---------------------------------------------------------------------------
// An album's metadata.json (task 2.6)
// ---------------------------------------------------------------------------

/**
 * What an album's `metadata.json` says, read.
 *
 * Takeout writes it as:
 *
 * ```json
 * { "title": "Iceland 2019", "description": "Ring road, August 2019", "access": "protected",
 *   "date": { "timestamp": "1565740800", "formatted": "14 Aug 2019, 00:00:00 UTC" },
 *   "geoData": { … }, "enrichments": [] }
 * ```
 *
 * `title` and `date` are read; `description`, `access`, `geoData`, and `enrichments` are not.
 * The `albums` table has columns for an id, a title, and three timestamps and nothing else, so
 * the unread fields have nowhere to go — and adding a column for a value no view renders is a
 * schema change that a later task should make on its own evidence rather than inherit from a
 * parser that happened to read the field.
 *
 * `date` is the **album's** own date, not a member's capture time; the corpus's `Iceland 2019`
 * fixture states that explicitly. It is the only creation-time-like value the export offers, so
 * `albums.ts` maps it to `AlbumRecord.createdAt`, and — like `creationTime` on a sidecar — it is
 * never a candidate for any asset's `captured_at`.
 */
export interface AlbumMetadata {
  /**
   * `title`, trimmed. Null when absent, not a string, or blank.
   *
   * This is the album's name (Requirement 1.7) and it is **not** the folder name, even where the
   * two match. Blank counts as absent: an album whose title is `""` cannot be shown or searched
   * for, so the caller's folder-name fallback is a better answer than an empty column.
   */
  readonly title: string | null;
  /** `date`. The album's own date. Null when absent or zero-filled. */
  readonly albumDate: TakeoutTime | null;
  /** One line per field that could not be read. Empty for an ordinary `metadata.json`. */
  readonly problems: readonly string[];
}

/** How `albums.ts` obtains a folder's album metadata, so it can be stated in a test. */
export type AlbumMetadataReader = (absolutePath: string) => Promise<AlbumMetadata>;

/** The fields of an album's `metadata.json`. Pure, so it is testable from a string. */
export function parseAlbumMetadata(text: string): AlbumMetadata {
  const parsed = parseJsonObject(text);
  if (parsed.body === null) {
    return { title: null, albumDate: null, problems: [parsed.problem] };
  }

  const problems: string[] = [];
  const rawTitle = parsed.body.title;
  let title: string | null = null;
  if (rawTitle === undefined) {
    problems.push('title is absent');
  } else if (typeof rawTitle !== 'string') {
    problems.push('title is not a string');
  } else if (rawTitle.trim().length === 0) {
    problems.push('title is blank');
  } else {
    title = rawTitle.trim();
  }

  const date = readTimeField(parsed.body, 'date');
  if (date.problem !== null) problems.push(date.problem);

  return { title, albumDate: date.time, problems };
}

/** The default {@link AlbumMetadataReader}. */
export async function readAlbumMetadata(absolutePath: string): Promise<AlbumMetadata> {
  try {
    return parseAlbumMetadata(await fs.readFile(absolutePath, 'utf8'));
  } catch (cause: unknown) {
    return {
      title: null,
      albumDate: null,
      problems: [`cannot read album metadata ${absolutePath}: ${describeCause(cause)}`],
    };
  }
}
