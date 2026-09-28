/**
 * The minimal EXIF reader (task 2.4).
 *
 * Two things have to be true for the timestamp tests to prove anything. The reader must parse
 * what `fixtures/syntheticMedia.ts` writes, since that segment is the corpus's only real EXIF;
 * and it must read `OffsetTimeOriginal`, which the fixture writer does not emit, because that tag
 * is the only honest source of `tz_offset_min`. The second is exercised against TIFF blocks built
 * here in both byte orders — a silently broken big-endian branch would look like "this camera has
 * no EXIF date" rather than like a bug.
 */

import { describe, expect, it } from 'vitest';

import {
  canCarryReadableExif,
  parseExifCaptureFields,
  parseExifDateTimeMs,
  parseExifOffsetMinutes,
} from './exif.ts';
import { exifDateToIsoUtc, syntheticMediaBytes } from './fixtures/syntheticMedia.ts';

const TAG_DATE_TIME_ORIGINAL = 0x9003;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;

/**
 * A bare TIFF block — `II*\0` or `MM\0*` — holding `DateTimeOriginal` and optionally
 * `OffsetTimeOriginal` in an Exif IFD.
 *
 * Built here rather than by extending the fixture writer: the corpus's job is to state Takeout's
 * shapes, and a Takeout export is where `OffsetTimeOriginal` has already been stripped.
 */
function tiffBlock(littleEndian: boolean, dateTimeOriginal: string, offset?: string): Uint8Array {
  const fields = [
    { tag: TAG_DATE_TIME_ORIGINAL, text: dateTimeOriginal },
    ...(offset === undefined ? [] : [{ tag: TAG_OFFSET_TIME_ORIGINAL, text: offset }]),
  ];

  // IFD0 sits at 8 and is 18 bytes: a 2-byte count, one 12-byte entry, a 4-byte next-IFD link.
  const exifIfdAt = 26;
  const exifIfdSize = 2 + 12 * fields.length + 4;
  const valueBase = exifIfdAt + exifIfdSize;
  const valueBytes = fields.reduce((total, field) => total + field.text.length + 1, 0);

  const bytes = new Uint8Array(valueBase + valueBytes);
  const view = new DataView(bytes.buffer);
  const text = new TextEncoder();

  bytes.set(text.encode(littleEndian ? 'II' : 'MM'), 0);
  view.setUint16(2, 0x002a, littleEndian);
  view.setUint32(4, 8, littleEndian);

  view.setUint16(8, 1, littleEndian);
  view.setUint16(10, 0x8769, littleEndian);
  view.setUint16(12, 4, littleEndian); // LONG
  view.setUint32(14, 1, littleEndian);
  view.setUint32(18, exifIfdAt, littleEndian);
  view.setUint32(22, 0, littleEndian);

  view.setUint16(exifIfdAt, fields.length, littleEndian);
  let valueAt = valueBase;
  for (const [index, field] of fields.entries()) {
    const entryAt = exifIfdAt + 2 + index * 12;
    const count = field.text.length + 1;
    view.setUint16(entryAt, field.tag, littleEndian);
    view.setUint16(entryAt + 2, 2, littleEndian); // ASCII
    view.setUint32(entryAt + 4, count, littleEndian);
    view.setUint32(entryAt + 8, valueAt, littleEndian);
    bytes.set(text.encode(field.text), valueAt);
    valueAt += count;
  }
  view.setUint32(exifIfdAt + 2 + fields.length * 12, 0, littleEndian);

  return bytes;
}

describe('reading the two capture tags', () => {
  it('parses the APP1 segment the fixture corpus writes', () => {
    const jpeg = syntheticMediaBytes('IMG_1234.jpg', 'exact-sidecar', '2019:06:01 08:00:00');
    const fields = parseExifCaptureFields(jpeg);

    expect(fields.dateTimeOriginal).toBe('2019:06:01 08:00:00');
    expect(fields.offsetTimeOriginal).toBeNull();
    expect(fields.problem).toBeNull();
    expect(fields.truncated).toBe(false);

    // The corpus reads a naive EXIF date as UTC; the reader must land on the same instant.
    expect(parseExifDateTimeMs(fields.dateTimeOriginal, null)).toBe(
      Date.parse(exifDateToIsoUtc('2019:06:01 08:00:00')),
    );
  });

  it('reads OffsetTimeOriginal in both TIFF byte orders', () => {
    for (const littleEndian of [true, false]) {
      const fields = parseExifCaptureFields(
        tiffBlock(littleEndian, '2019:08:14 11:02:44', '+02:00'),
      );
      expect(fields.dateTimeOriginal).toBe('2019:08:14 11:02:44');
      expect(fields.offsetTimeOriginal).toBe('+02:00');
      expect(fields.problem).toBeNull();
    }
  });

  it('reports rather than guesses when the container is not one it understands', () => {
    const heic = syntheticMediaBytes('IMG_2001.HEIC', 'live-photo-still');
    const fields = parseExifCaptureFields(heic);

    expect(fields.dateTimeOriginal).toBeNull();
    expect(fields.truncated).toBe(false);
    expect(fields.problem).toMatch(/not a JPEG or TIFF/u);
  });

  it('reports a JPEG that carries no EXIF, distinctly from one it could not reach', () => {
    const jpeg = syntheticMediaBytes('IMG_2002-edited.jpg', 'no-exif');
    const fields = parseExifCaptureFields(jpeg);

    expect(fields.dateTimeOriginal).toBeNull();
    expect(fields.truncated).toBe(false);
    expect(fields.problem).toMatch(/no EXIF APP1 segment/u);
  });

  it('says it ran out of bytes rather than that the tag is absent', () => {
    const jpeg = syntheticMediaBytes('IMG_1234.jpg', 'seed', '2019:06:01 08:00:00');
    // Cut inside the APP1 segment: absence of the tag is now unproven, and saying otherwise is
    // how a head-only read silently downgrades a file to mtime provenance.
    const fields = parseExifCaptureFields(jpeg.subarray(0, 10));

    expect(fields.dateTimeOriginal).toBeNull();
    expect(fields.truncated).toBe(true);
  });

  it('only claims to find EXIF in containers it can parse', () => {
    expect(canCarryReadableExif('IMG_1.jpg')).toBe(true);
    expect(canCarryReadableExif('IMG_1.JPEG')).toBe(true);
    expect(canCarryReadableExif('scan.tiff')).toBe(true);
    expect(canCarryReadableExif('IMG_2001.HEIC')).toBe(false);
    expect(canCarryReadableExif('IMG_2001.MOV')).toBe(false);
    expect(canCarryReadableExif('noextension')).toBe(false);
  });
});

describe('interpreting the two tags', () => {
  it('reads a naive date as UTC when no offset was recorded', () => {
    expect(parseExifDateTimeMs('2019:06:08 14:22:31', null)).toBe(
      Date.parse('2019-06-08T14:22:31Z'),
    );
  });

  it('treats the date as local time when an offset was recorded', () => {
    expect(parseExifDateTimeMs('2019:06:08 16:22:31', 120)).toBe(
      Date.parse('2019-06-08T14:22:31Z'),
    );
    expect(parseExifDateTimeMs('2019:06:08 07:22:31', -420)).toBe(
      Date.parse('2019-06-08T14:22:31Z'),
    );
  });

  it('rejects dates that no camera can have taken', () => {
    // Takeout and several cameras write this when they have no date at all.
    expect(parseExifDateTimeMs('0000:00:00 00:00:00', null)).toBeNull();
    // A range check per field would let both of these through.
    expect(parseExifDateTimeMs('2019:02:30 12:00:00', null)).toBeNull();
    expect(parseExifDateTimeMs('2019:13:01 12:00:00', null)).toBeNull();
    expect(parseExifDateTimeMs('not a date', null)).toBeNull();
    expect(parseExifDateTimeMs(null, null)).toBeNull();
  });

  it('reads an offset only in the form EXIF fixes, so a placeholder stays null', () => {
    expect(parseExifOffsetMinutes('+02:00')).toBe(120);
    expect(parseExifOffsetMinutes('-07:30')).toBe(-450);
    expect(parseExifOffsetMinutes('+00:00')).toBe(0);
    // A camera with the tag and nothing to put in it. Null, not UTC.
    expect(parseExifOffsetMinutes('  :  ')).toBeNull();
    expect(parseExifOffsetMinutes('02:00')).toBeNull();
    expect(parseExifOffsetMinutes('+2:00')).toBeNull();
    expect(parseExifOffsetMinutes('+02:60')).toBeNull();
    expect(parseExifOffsetMinutes(null)).toBeNull();
  });
});
