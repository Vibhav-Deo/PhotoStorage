/**
 * Deterministic synthetic payloads for the fixture corpus.
 *
 * ## Why synthetic
 *
 * Every rule the corpus exists to test — sidecar pairing, `-edited` variants, Live Photo
 * linking, album reconstruction, timestamp precedence — reads filenames, sidecar JSON, and at
 * most the EXIF block. None of it decodes a pixel. Real HEIC and MOV samples would add
 * megabytes of unreviewable binary to the repository and buy nothing, so a payload here is a
 * few dozen bytes with the correct extension, the correct container magic where a container
 * has magic, and real EXIF where a fixture declares it.
 *
 * The payloads are **not decodable media** and are not meant to be. Tasks 2.7 and 2.8 run
 * `sharp` and `ffmpeg` and need genuinely decodable inputs; that is a separate, much smaller
 * fixture set, and it is a deliberate boundary rather than an oversight.
 *
 * ## Why deterministic
 *
 * The archive is content-addressed, so a fixture's bytes decide its content hash and every
 * object key derived from it. Bytes are derived from the fixture id alone: two builds of the
 * corpus produce byte-identical trees, distinct fixtures get distinct hashes, and a test can
 * assert a stable hash without the corpus being checked in. Nothing here uses randomness, a
 * clock, or the output path.
 */

const TEXT = new TextEncoder();

/** JPEG start-of-image. */
const SOI = Uint8Array.of(0xff, 0xd8);
/** JPEG end-of-image. */
const EOI = Uint8Array.of(0xff, 0xd9);
/** APP1, the segment EXIF lives in. */
const MARKER_APP1 = Uint8Array.of(0xff, 0xe1);
/** COM, a free-text comment segment. Carries the fixture banner. */
const MARKER_COM = Uint8Array.of(0xff, 0xfe);

/** `Exif\0\0`, the APP1 payload prefix that identifies the segment as EXIF. */
const EXIF_IDENTIFIER = Uint8Array.of(0x45, 0x78, 0x69, 0x66, 0x00, 0x00);

/** TIFF `ExifIFDPointer`. */
const TAG_EXIF_IFD_POINTER = 0x8769;
/** TIFF `DateTimeOriginal`. */
const TAG_DATE_TIME_ORIGINAL = 0x9003;
/** TIFF field type 2, `ASCII`. */
const TIFF_TYPE_ASCII = 2;
/** TIFF field type 4, `LONG`. */
const TIFF_TYPE_LONG = 4;

/** `YYYY:MM:DD HH:MM:SS` — the only form EXIF date tags take. */
const EXIF_DATE_PATTERN = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;

/** Thrown when a fixture declares EXIF that cannot be encoded. */
export class SyntheticMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticMediaError';
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * A real EXIF APP1 segment carrying `DateTimeOriginal` and nothing else.
 *
 * Hand-built because the alternative is a dependency that writes EXIF, and the segment needed
 * here is 64 bytes of TIFF: a little-endian header, an IFD0 holding only the pointer to the
 * Exif IFD, and an Exif IFD holding only the date. Every offset below is fixed by that
 * layout, which is why they are literals: IFD0 starts at 8 and is 18 bytes (a 2-byte count,
 * one 12-byte entry, a 4-byte next-IFD link), so the Exif IFD starts at 26, and its own
 * 18 bytes put the date string at 44.
 */
export function exifApp1Segment(dateTimeOriginal: string): Uint8Array {
  if (!EXIF_DATE_PATTERN.test(dateTimeOriginal)) {
    throw new SyntheticMediaError(
      `EXIF DateTimeOriginal must be "YYYY:MM:DD HH:MM:SS", got ${JSON.stringify(dateTimeOriginal)}`,
    );
  }

  const EXIF_IFD_OFFSET = 26;
  const DATE_VALUE_OFFSET = 44;
  /** 19 characters plus the NUL that EXIF ASCII fields count. */
  const DATE_FIELD_LENGTH = 20;
  const TIFF_LENGTH = DATE_VALUE_OFFSET + DATE_FIELD_LENGTH;

  const tiff = new Uint8Array(TIFF_LENGTH);
  const view = new DataView(tiff.buffer);
  const LE = true;

  tiff.set(TEXT.encode('II'), 0);
  view.setUint16(2, 0x002a, LE);
  view.setUint32(4, 8, LE);

  view.setUint16(8, 1, LE);
  view.setUint16(10, TAG_EXIF_IFD_POINTER, LE);
  view.setUint16(12, TIFF_TYPE_LONG, LE);
  view.setUint32(14, 1, LE);
  view.setUint32(18, EXIF_IFD_OFFSET, LE);
  view.setUint32(22, 0, LE);

  view.setUint16(EXIF_IFD_OFFSET, 1, LE);
  view.setUint16(EXIF_IFD_OFFSET + 2, TAG_DATE_TIME_ORIGINAL, LE);
  view.setUint16(EXIF_IFD_OFFSET + 4, TIFF_TYPE_ASCII, LE);
  view.setUint32(EXIF_IFD_OFFSET + 6, DATE_FIELD_LENGTH, LE);
  view.setUint32(EXIF_IFD_OFFSET + 10, DATE_VALUE_OFFSET, LE);
  view.setUint32(EXIF_IFD_OFFSET + 14, 0, LE);

  tiff.set(TEXT.encode(dateTimeOriginal), DATE_VALUE_OFFSET);

  return markerSegment(MARKER_APP1, concat([EXIF_IDENTIFIER, tiff]));
}

/** A JPEG marker segment: the marker, then a big-endian length that counts itself. */
function markerSegment(marker: Uint8Array, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength + 2;
  if (length > 0xffff) {
    throw new SyntheticMediaError(`JPEG segment payload too large: ${String(payload.byteLength)}`);
  }
  const header = new Uint8Array(2);
  new DataView(header.buffer).setUint16(0, length, false);
  return concat([marker, header, payload]);
}

/**
 * An ISO base media file `ftyp` box, which is what makes a file sniff as HEIC, MOV, or MP4.
 * The box is followed by nothing decodable, which is fine: the corpus tests metadata repair.
 */
function ftypBox(majorBrand: string, compatibleBrands: readonly string[]): Uint8Array {
  const brands = [majorBrand, ...compatibleBrands];
  for (const brand of brands) {
    if (brand.length !== 4) {
      throw new SyntheticMediaError(`Container brand must be 4 characters, got "${brand}"`);
    }
  }
  const size = 8 + 4 + 4 + compatibleBrands.length * 4;
  const box = new Uint8Array(size);
  new DataView(box.buffer).setUint32(0, size, false);
  box.set(TEXT.encode('ftyp'), 4);
  box.set(TEXT.encode(majorBrand), 8);
  // Minor version stays zero.
  let offset = 16;
  for (const brand of compatibleBrands) {
    box.set(TEXT.encode(brand), offset);
    offset += 4;
  }
  return box;
}

/** Human-readable marker, so a stray fixture file found anywhere explains itself. */
function banner(seed: string): Uint8Array {
  return TEXT.encode(`photo-archive takeout fixture; not decodable media; seed=${seed}\n`);
}

/** Container brands per extension, lowercased. Extensions absent here get bytes only. */
const CONTAINER_BRANDS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  heic: ['heic', ['mif1', 'heic']],
  heif: ['mif1', ['mif1', 'heic']],
  mov: ['qt  ', ['qt  ']],
  mp4: ['isom', ['isom', 'mp42']],
  m4v: ['isom', ['isom', 'mp42']],
};

/** Lowercased extension without the dot, or `''` when the name has none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * The bytes for one fixture: a valid-enough container for its extension, a fixture banner,
 * and a real EXIF segment when `dateTimeOriginal` is supplied.
 *
 * EXIF is only written for JPEG. A fixture that needs an EXIF date therefore has to be a
 * `.jpg`, which is not a constraint in practice — the case that matters is EXIF disagreeing
 * with a sidecar, and Takeout's JPEGs are where that happens.
 */
export function syntheticMediaBytes(
  fileName: string,
  seed: string,
  dateTimeOriginal?: string,
): Uint8Array {
  const extension = extensionOf(fileName);
  const comment = banner(seed);

  if (extension === 'jpg' || extension === 'jpeg') {
    const segments: Uint8Array[] = [SOI];
    if (dateTimeOriginal !== undefined) {
      segments.push(exifApp1Segment(dateTimeOriginal));
    }
    segments.push(markerSegment(MARKER_COM, comment), EOI);
    return concat(segments);
  }

  if (dateTimeOriginal !== undefined) {
    throw new SyntheticMediaError(
      `EXIF can only be written into a JPEG payload; ${fileName} is not one`,
    );
  }

  const brands = CONTAINER_BRANDS[extension];
  return brands === undefined ? comment : concat([ftypBox(brands[0], brands[1]), comment]);
}

/**
 * `YYYY:MM:DD HH:MM:SS` to an ISO 8601 instant, read as UTC.
 *
 * EXIF date tags carry no offset, and Takeout rarely preserves `OffsetTimeOriginal`, so
 * something has to be assumed. The corpus assumes UTC — stated here, in one place, rather
 * than implied by whichever timezone a test machine happens to be in, which is the classic
 * way a date-handling test suite becomes machine-dependent.
 */
export function exifDateToIsoUtc(dateTimeOriginal: string): string {
  if (!EXIF_DATE_PATTERN.test(dateTimeOriginal)) {
    throw new SyntheticMediaError(
      `EXIF DateTimeOriginal must be "YYYY:MM:DD HH:MM:SS", got ${JSON.stringify(dateTimeOriginal)}`,
    );
  }
  const [date, time] = dateTimeOriginal.split(' ');
  return `${(date ?? '').replaceAll(':', '-')}T${time ?? ''}Z`;
}
