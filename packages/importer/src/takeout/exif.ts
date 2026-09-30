/**
 * The two EXIF tags timestamp provenance needs, read without a dependency (task 2.4,
 * Requirements 1.2 and 1.3).
 *
 * ## Why this is hand-rolled
 *
 * `packages/importer` has no runtime dependency but `@photo-archive/core`, and dependencies here
 * are pinned exactly because a silent bump can invalidate the compliance record (see
 * `licenses/README.md`). Timestamp resolution needs exactly two tags — `DateTimeOriginal` and
 * `OffsetTimeOriginal` — and reaching them is a little-endian-or-big-endian TIFF header, one IFD
 * entry lookup to find the Exif IFD, and two ASCII field reads. An EXIF library would be several
 * thousand lines and a supply-chain surface for sixty bytes of structure.
 *
 * It also has to read what the fixture corpus writes. `fixtures/syntheticMedia.ts` builds a real
 * APP1 segment by hand, and a reader that cannot parse that segment cannot prove anything about
 * the case task 2.4 exists for.
 *
 * ## Why it is a seam anyway
 *
 * {@link ExifCaptureReader} is a function type with {@link readExifCaptureFields} as the default,
 * so the resolver depends on the capability rather than on this implementation. Task 2.7 decodes
 * with `sharp` and task 9.2 writes corrected EXIF back into an exported copy, and both will want
 * dimensions, orientation, camera make and model, and a writer. When that arrives it replaces the
 * reader behind this type; nothing in `timestamps.ts` changes.
 *
 * ## What it deliberately does not read
 *
 * Only JPEG (`FFD8`, APP1 carrying `Exif\0\0`) and bare TIFF (`II*\0` / `MM\0*`) containers.
 * **HEIC, MOV, and MP4 carry EXIF inside ISO base media file boxes and are not parsed**, so an
 * unpaired HEIC resolves from mtime where a richer reader could do better. That is a real
 * limitation and it is recorded rather than hidden: {@link ExifCaptureFields.problem} says the
 * container was not one this reader understands. In a Takeout export the HEIC that matters is the
 * still half of a Live Photo, which pairs with a sidecar and so never reaches EXIF at all.
 *
 * Nothing here throws. An unreadable, truncated, or malformed file yields nulls plus a
 * {@link ExifCaptureFields.problem} line, because one corrupt JPEG in a 500k-item export must
 * cost that item its EXIF provenance and nothing else (Requirement 1.10).
 */

import * as fs from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Constants fixed by the JPEG and TIFF formats
// ---------------------------------------------------------------------------

/** JPEG start-of-image. */
const JPEG_SOI_0 = 0xff;
const JPEG_SOI_1 = 0xd8;
/** APP1, the segment EXIF lives in. */
const MARKER_APP1 = 0xe1;
/** Start-of-scan: image data follows and no more metadata segments will. */
const MARKER_SOS = 0xda;
/** End-of-image. */
const MARKER_EOI = 0xd9;
/** Marker with no length field: `SOI`, `TEM`, and the eight `RST` markers. */
const STANDALONE_MARKERS: ReadonlySet<number> = new Set([
  0x01,
  0xd0,
  0xd1,
  0xd2,
  0xd3,
  0xd4,
  0xd5,
  0xd6,
  0xd7,
  JPEG_SOI_1,
]);

/** `Exif\0\0`, the APP1 payload prefix that identifies the segment as EXIF. */
const EXIF_IDENTIFIER = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);

/** `II`, TIFF's little-endian byte-order mark. */
const TIFF_LITTLE_ENDIAN = 0x49;
/** `MM`, TIFF's big-endian byte-order mark. */
const TIFF_BIG_ENDIAN = 0x4d;
/** The 42 that follows the byte-order mark in every TIFF header. */
const TIFF_MAGIC = 0x002a;
/** Bytes in a TIFF header: byte order, magic, offset to IFD0. */
const TIFF_HEADER_LENGTH = 8;
/** Bytes in one IFD entry: tag, type, count, value-or-offset. */
const IFD_ENTRY_LENGTH = 12;

const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;

/**
 * `YYYY:MM:DD HH:MM:SS`, the only form an EXIF date tag takes. `T` is accepted in the separator
 * position because writers occasionally emit it; nothing else is, since a lenient date parser is
 * how a wrong timestamp gets into an archive.
 */
const EXIF_DATE_TIME_PATTERN =
  /^(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})[ T](?<hour>\d{2}):(?<minute>\d{2}):(?<second>\d{2})$/u;

/** `+HH:MM` or `-HH:MM`, the form EXIF 2.31 fixes for `OffsetTimeOriginal`. */
const EXIF_OFFSET_PATTERN = /^(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2})$/u;

/** Extensions this reader can find EXIF in. Lowercased, no dot. */
const EXIF_CAPABLE_EXTENSIONS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'tif', 'tiff']);

/**
 * Bytes read from the front of a file on the first attempt.
 *
 * EXIF sits in the first few segments of a JPEG, so this is generous. It matters because the
 * alternative is reading the head of every media file in an export that may be 2 TB.
 */
const HEAD_BYTES = 128 * 1024;

/**
 * Ceiling for the second attempt, made only when the first ran out of bytes mid-segment. A JPEG
 * whose metadata segments exceed this is not a photo anyone took.
 */
const MAX_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/** The EXIF capture fields, exactly as the tags spell them. */
export interface ExifCaptureFields {
  /** `DateTimeOriginal` verbatim, `YYYY:MM:DD HH:MM:SS`. Timezone-naive; the tag is. */
  readonly dateTimeOriginal: string | null;
  /**
   * `OffsetTimeOriginal` verbatim, `±HH:MM`. This is the **only** honest source of
   * `assets.tz_offset_min` in a Takeout import, and Takeout rarely preserves it, so it is
   * usually null — see `timestamps.ts`.
   */
  readonly offsetTimeOriginal: string | null;
  /**
   * True when the search ran off the end of the buffer before reaching EXIF or image data, so
   * absence of a tag is unproven. Callers that read a window retry with a larger one;
   * {@link readExifCaptureFields} does.
   */
  readonly truncated: boolean;
  /** One line saying why nothing was found. Null when {@link dateTimeOriginal} was read. */
  readonly problem: string | null;
}

/** Nothing found, for whatever reason. */
function nothing(problem: string, truncated = false): ExifCaptureFields {
  return { dateTimeOriginal: null, offsetTimeOriginal: null, truncated, problem };
}

/**
 * How `timestamps.ts` obtains EXIF, so the resolver depends on the capability rather than on
 * this module. Takes an absolute path, because `TakeoutFile.absolutePath` is the only path field
 * safe to open — the logical path is NFC-normalized for comparison and may not exist under that
 * spelling.
 *
 * Implementations must not throw: an unreadable file is a null result with a problem line.
 */
export type ExifCaptureReader = (absolutePath: string) => Promise<ExifCaptureFields>;

/** True when this reader could find EXIF in a file with this name. */
export function canCarryReadableExif(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  return dot !== -1 && EXIF_CAPABLE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

// ---------------------------------------------------------------------------
// Finding the TIFF header
// ---------------------------------------------------------------------------

interface TiffLocation {
  /** Offset of the TIFF byte-order mark within the buffer, or null when there is none. */
  readonly at: number | null;
  readonly truncated: boolean;
  readonly problem: string | null;
}

function startsWithExifIdentifier(bytes: Uint8Array, at: number): boolean {
  if (at + EXIF_IDENTIFIER.length > bytes.length) return false;
  return EXIF_IDENTIFIER.every((byte, index) => bytes[at + index] === byte);
}

function looksLikeTiff(bytes: Uint8Array): boolean {
  const first = bytes[0];
  if (first !== bytes[1]) return false;
  if (first !== TIFF_LITTLE_ENDIAN && first !== TIFF_BIG_ENDIAN) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < TIFF_HEADER_LENGTH) return false;
  return view.getUint16(2, first === TIFF_LITTLE_ENDIAN) === TIFF_MAGIC;
}

/**
 * Walks a JPEG's marker chain to the first APP1 segment carrying `Exif\0\0`.
 *
 * Stops at `SOS`, because everything after it is entropy-coded image data in which a byte pair
 * that looks like a marker means nothing. Segment lengths are big-endian regardless of the byte
 * order the TIFF block inside later declares — the two are unrelated formats.
 */
function findJpegExif(bytes: Uint8Array): TiffLocation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;

  while (at + 2 <= bytes.byteLength) {
    if (bytes[at] !== 0xff) {
      return { at: null, truncated: false, problem: `malformed JPEG marker chain at byte ${at}` };
    }
    // Fill bytes: a marker may be preceded by any number of extra 0xff.
    let markerAt = at + 1;
    while (bytes[markerAt] === 0xff) markerAt += 1;
    const marker = bytes[markerAt];
    if (marker === undefined) {
      return { at: null, truncated: true, problem: 'JPEG marker chain ends mid-marker' };
    }

    if (STANDALONE_MARKERS.has(marker)) {
      at = markerAt + 1;
      continue;
    }
    if (marker === MARKER_SOS || marker === MARKER_EOI) {
      return { at: null, truncated: false, problem: 'JPEG has no EXIF APP1 segment' };
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 2 > bytes.byteLength) {
      return { at: null, truncated: true, problem: 'JPEG segment length is past the end' };
    }
    const length = view.getUint16(lengthAt, false);
    if (length < 2) {
      return { at: null, truncated: false, problem: `JPEG segment declares length ${length}` };
    }
    const payloadAt = lengthAt + 2;
    const payloadEnd = payloadAt + length - 2;

    // Bounds before content: an EXIF segment that is only partly in the buffer must be reported
    // as unread rather than parsed, or a head-only read concludes "no DateTimeOriginal" from
    // having stopped too early and the file silently drops to mtime provenance.
    if (payloadEnd > bytes.byteLength) {
      return { at: null, truncated: true, problem: 'JPEG segment runs past the bytes read' };
    }
    if (marker === MARKER_APP1 && startsWithExifIdentifier(bytes, payloadAt)) {
      return { at: payloadAt + EXIF_IDENTIFIER.length, truncated: false, problem: null };
    }
    at = payloadEnd;
  }

  return { at: null, truncated: true, problem: 'JPEG marker chain runs past the bytes read' };
}

// ---------------------------------------------------------------------------
// Reading the TIFF block
// ---------------------------------------------------------------------------

interface Tiff {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  /** Offset of the byte-order mark. Every TIFF offset is relative to this. */
  readonly base: number;
  readonly littleEndian: boolean;
}

/** An ASCII field's value, NUL- and whitespace-trimmed, or null when it is unreadable. */
function readAsciiField(tiff: Tiff, count: number, valueFieldAt: number): string | null {
  // A value of four bytes or fewer is stored inline in the entry's value field; anything longer
  // is stored elsewhere in the block and the value field holds its offset.
  const at =
    count <= 4 ? valueFieldAt : tiff.base + tiff.view.getUint32(valueFieldAt, tiff.littleEndian);
  if (at < 0 || at + count > tiff.bytes.byteLength) return null;

  let text = '';
  for (let index = 0; index < count; index += 1) {
    const byte = tiff.bytes[at + index];
    if (byte === undefined || byte === 0) break;
    // EXIF ASCII is 7-bit. A byte above that is a writer bug, not text to guess at.
    if (byte > 0x7f) return null;
    text += String.fromCharCode(byte);
  }
  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** An unsigned integer field, for the Exif IFD pointer. */
function readIntegerField(tiff: Tiff, type: number, valueFieldAt: number): number | null {
  if (type === TIFF_TYPE_LONG) return tiff.view.getUint32(valueFieldAt, tiff.littleEndian);
  if (type === TIFF_TYPE_SHORT) return tiff.view.getUint16(valueFieldAt, tiff.littleEndian);
  return null;
}

/** One IFD entry, located rather than decoded: the value's meaning depends on its tag. */
interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Offset of the entry's 4-byte value-or-offset field. */
  readonly valueFieldAt: number;
}

/** The entries of the IFD at `ifdOffset`, which is relative to the TIFF base. */
function readIfd(tiff: Tiff, ifdOffset: number): readonly IfdEntry[] {
  const ifdAt = tiff.base + ifdOffset;
  if (ifdAt < 0 || ifdAt + 2 > tiff.bytes.byteLength) return [];
  const entryCount = tiff.view.getUint16(ifdAt, tiff.littleEndian);

  const entries: IfdEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    const entryAt = ifdAt + 2 + index * IFD_ENTRY_LENGTH;
    if (entryAt + IFD_ENTRY_LENGTH > tiff.bytes.byteLength) break;
    entries.push({
      tag: tiff.view.getUint16(entryAt, tiff.littleEndian),
      type: tiff.view.getUint16(entryAt + 2, tiff.littleEndian),
      count: tiff.view.getUint32(entryAt + 4, tiff.littleEndian),
      valueFieldAt: entryAt + 8,
    });
  }
  return entries;
}

/** The first entry with this tag, or undefined. Duplicate tags are a writer bug; the first wins. */
function entryWithTag(entries: readonly IfdEntry[], tag: number): IfdEntry | undefined {
  return entries.find((entry) => entry.tag === tag);
}

/** An ASCII entry's trimmed value, or null when the entry is absent or not ASCII. */
function asciiValue(tiff: Tiff, entries: readonly IfdEntry[], tag: number): string | null {
  const entry = entryWithTag(entries, tag);
  if (entry === undefined || entry.type !== TIFF_TYPE_ASCII) return null;
  return readAsciiField(tiff, entry.count, entry.valueFieldAt);
}

/**
 * The capture fields in the TIFF block whose byte-order mark is at `base`.
 *
 * Two IFDs are read and no next-IFD link is followed: IFD0 only to find the Exif IFD pointer,
 * then the Exif IFD for the two date tags. That bounds the walk without needing a cycle guard,
 * and IFD1 is the thumbnail's directory, which has no bearing on capture time.
 */
function readTiffCaptureFields(bytes: Uint8Array, base: number): ExifCaptureFields {
  if (base + TIFF_HEADER_LENGTH > bytes.byteLength) {
    return nothing('EXIF block is shorter than a TIFF header', true);
  }
  const order = bytes[base];
  if (order !== bytes[base + 1] || (order !== TIFF_LITTLE_ENDIAN && order !== TIFF_BIG_ENDIAN)) {
    return nothing('EXIF block has no TIFF byte-order mark');
  }
  const littleEndian = order === TIFF_LITTLE_ENDIAN;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(base + 2, littleEndian) !== TIFF_MAGIC) {
    return nothing('EXIF block has no TIFF magic');
  }

  const tiff: Tiff = { view, bytes, base, littleEndian };

  const ifd0 = readIfd(tiff, view.getUint32(base + 4, littleEndian));
  const pointer = entryWithTag(ifd0, TAG_EXIF_IFD_POINTER);
  const exifIfdOffset =
    pointer === undefined || pointer.count !== 1
      ? null
      : readIntegerField(tiff, pointer.type, pointer.valueFieldAt);
  if (exifIfdOffset === null) {
    return nothing('EXIF has no Exif IFD, so it records no DateTimeOriginal');
  }

  const exifIfd = readIfd(tiff, exifIfdOffset);
  const dateTimeOriginal = asciiValue(tiff, exifIfd, TAG_DATE_TIME_ORIGINAL);
  const offsetTimeOriginal = asciiValue(tiff, exifIfd, TAG_OFFSET_TIME_ORIGINAL);

  return {
    dateTimeOriginal,
    offsetTimeOriginal,
    truncated: false,
    problem: dateTimeOriginal === null ? 'EXIF records no DateTimeOriginal' : null,
  };
}

// ---------------------------------------------------------------------------
// Public parse and read
// ---------------------------------------------------------------------------

/**
 * The capture fields in a buffer holding the front of a JPEG or TIFF file.
 *
 * Pure and synchronous, so the whole EXIF path is testable from bytes — including the bytes
 * `fixtures/syntheticMedia.ts` writes, which is the point.
 */
export function parseExifCaptureFields(bytes: Uint8Array): ExifCaptureFields {
  if (bytes.byteLength < 4) return nothing('file is too short to hold a container header', true);

  if (looksLikeTiff(bytes)) return readTiffCaptureFields(bytes, 0);

  if (bytes[0] === JPEG_SOI_0 && bytes[1] === JPEG_SOI_1) {
    const located = findJpegExif(bytes);
    if (located.at === null) {
      return nothing(located.problem ?? 'no EXIF found', located.truncated);
    }
    return readTiffCaptureFields(bytes, located.at);
  }

  return nothing('not a JPEG or TIFF container, so this reader cannot find EXIF in it');
}

/** The first `length` bytes of a file, or fewer if the file is shorter. */
async function readHead(absolutePath: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const buffer = new Uint8Array(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The default {@link ExifCaptureReader}: reads the front of the file rather than all of it,
 * because a Takeout export is large and the metadata segments are not.
 *
 * One retry, and only when the first window ran out mid-segment, so absence of a tag is never
 * concluded from having stopped reading too early.
 */
export async function readExifCaptureFields(absolutePath: string): Promise<ExifCaptureFields> {
  let head: Uint8Array;
  try {
    head = await readHead(absolutePath, HEAD_BYTES);
  } catch (cause: unknown) {
    return nothing(
      `cannot read ${absolutePath} for EXIF: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const first = parseExifCaptureFields(head);
  if (!first.truncated || head.byteLength < HEAD_BYTES) return first;

  try {
    return parseExifCaptureFields(await readHead(absolutePath, MAX_BYTES));
  } catch (cause: unknown) {
    return nothing(
      `cannot re-read ${absolutePath} for EXIF: ${cause instanceof Error ? cause.message : String(cause)}`,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Interpreting the two fields
// ---------------------------------------------------------------------------

/**
 * `OffsetTimeOriginal` as minutes east of UTC, or null when the tag is absent or not the form
 * EXIF fixes.
 *
 * Cameras that have the tag but no offset to put in it write placeholders — spaces, colons,
 * `00:00` with no sign. Those are rejected rather than read as UTC, because `tz_offset_min` is
 * null when the original recorded no offset (design: schema) and a placeholder is not a record.
 */
export function parseExifOffsetMinutes(offsetTimeOriginal: string | null): number | null {
  if (offsetTimeOriginal === null) return null;
  const groups = EXIF_OFFSET_PATTERN.exec(offsetTimeOriginal.trim())?.groups;
  if (groups === undefined) return null;
  const hours = Number(groups.hours);
  const minutes = Number(groups.minutes);
  if (hours > 23 || minutes > 59) return null;
  const magnitude = hours * 60 + minutes;
  return groups.sign === '-' ? -magnitude : magnitude;
}

/**
 * `DateTimeOriginal` as an instant in epoch milliseconds, or null when it is absent or not a
 * real date.
 *
 * The tag is timezone-naive, so an offset has to come from somewhere:
 *
 * - `offsetMinutes` supplied — from `OffsetTimeOriginal` — and the naive reading is local time
 *   at capture, so the instant is the reading minus the offset.
 * - `offsetMinutes` null and the naive reading is taken as **UTC**. Something has to be assumed,
 *   the machine's own timezone is the one assumption that would make an import's output depend
 *   on where it ran, and `fixtures/syntheticMedia.ts` pins the same convention for the corpus.
 *   `captured_at_src` records that the timestamp came from EXIF, and `tz_offset_min` stays null,
 *   so a later correction pass can see that the offset was assumed rather than recorded.
 *
 * `0000:00:00 00:00:00` and other impossible dates are rejected. The check is a UTC round-trip,
 * which catches `2019:02:30` and `2019:13:01` that a range check per field would let through.
 */
export function parseExifDateTimeMs(
  dateTimeOriginal: string | null,
  offsetMinutes: number | null,
): number | null {
  if (dateTimeOriginal === null) return null;
  const groups = EXIF_DATE_TIME_PATTERN.exec(dateTimeOriginal.trim())?.groups;
  if (groups === undefined) return null;

  const year = Number(groups.year);
  const month = Number(groups.month);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second);

  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(naive)) return null;
  const back = new Date(naive);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return null;
  }

  return naive - (offsetMinutes ?? 0) * 60_000;
}
