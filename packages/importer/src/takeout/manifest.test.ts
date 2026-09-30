import { describe, expect, it } from 'vitest';
import type { ManifestEntry } from './manifest.ts';
import {
  formatManifestLine,
  groupManifestEntriesByMonth,
  ManifestError,
  monthOfCapturedAt,
  parseManifestLine,
  reconstructTimelineFromManifest,
} from './manifest.ts';

describe('manifest NDJSON & timeline reconstruction', () => {
  const sampleEntry: ManifestEntry = {
    hash: 'a3f1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1',
    file: 'IMG_1234.HEIC',
    kind: 'image',
    bytes: 3841204,
    capturedAt: '2019-07-04T18:22:31-07:00',
    capturedAtSource: 'takeout_json',
    lat: 37.7749,
    lon: -122.4194,
    camera: 'Apple iPhone 11 Pro',
    albums: ['Summer 2019', 'Vacation'],
    livePairHash: 'b7c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2',
  };

  it('formats manifest line as single-line NDJSON with newline', () => {
    const formatted = formatManifestLine(sampleEntry);
    expect(formatted.endsWith('\n')).toBe(true);
    expect(formatted.split('\n').length).toBe(2);

    const parsed = parseManifestLine(formatted);
    expect(parsed.hash).toBe(sampleEntry.hash);
    expect(parsed.file).toBe('IMG_1234.HEIC');
    expect(parsed.kind).toBe('image');
    expect(parsed.bytes).toBe(3841204);
    expect(parsed.capturedAt).toBe('2019-07-04T18:22:31-07:00');
    expect(parsed.lat).toBe(37.7749);
    expect(parsed.lon).toBe(-122.4194);
    expect(parsed.camera).toBe('Apple iPhone 11 Pro');
    expect(parsed.albums).toEqual(['Summer 2019', 'Vacation']);
    expect(parsed.livePairHash).toBe(sampleEntry.livePairHash);
  });

  it('extracts capture month yyyy-mm correctly', () => {
    expect(monthOfCapturedAt('2019-07-04T18:22:31-07:00')).toBe('2019-07');
    expect(monthOfCapturedAt('2023-12-31T23:59:59Z')).toBe('2023-12');
    expect(() => monthOfCapturedAt('invalid-date')).toThrow(ManifestError);
  });

  it('groups manifest entries by capture month', () => {
    const entries: ManifestEntry[] = [
      { ...sampleEntry, capturedAt: '2019-07-04T18:22:31Z', hash: 'hash1' },
      { ...sampleEntry, capturedAt: '2019-07-15T10:00:00Z', hash: 'hash2' },
      { ...sampleEntry, capturedAt: '2019-08-01T12:00:00Z', hash: 'hash3' },
    ];

    const groups = groupManifestEntriesByMonth(entries);
    expect(groups.size).toBe(2);
    expect(groups.get('2019-07')?.length).toBe(2);
    expect(groups.get('2019-08')?.length).toBe(1);
  });

  it('reconstructs timeline from manifest entries alone', () => {
    const entries: ManifestEntry[] = [
      {
        hash: 'hash-july',
        file: 'july.jpg',
        kind: 'image',
        bytes: 1000,
        capturedAt: '2019-07-04T18:22:31Z',
        capturedAtSource: 'takeout_json',
        lat: 37.7749,
        lon: -122.4194,
        albums: ['Summer 2019'],
      },
      {
        hash: 'hash-motion',
        file: 'july.mov',
        kind: 'motion_component',
        bytes: 5000,
        capturedAt: '2019-07-04T18:22:31Z',
        capturedAtSource: 'takeout_json',
      },
      {
        hash: 'hash-august',
        file: 'august.jpg',
        kind: 'image',
        bytes: 2000,
        capturedAt: '2019-08-10T12:00:00Z',
        capturedAtSource: 'exif',
        albums: ['Summer 2019', 'Trips'],
      },
    ];

    const timeline = reconstructTimelineFromManifest(entries);

    // Motion component excluded from main timeline
    expect(timeline.length).toBe(2);

    // Sorted descending by date (August first, then July)
    expect(timeline[0]?.hash).toBe('hash-august');
    expect(timeline[1]?.hash).toBe('hash-july');

    expect(timeline[1]?.location).toEqual({ lat: 37.7749, lon: -122.4194 });
    expect(timeline[1]?.albums).toEqual(['Summer 2019']);
  });
});
