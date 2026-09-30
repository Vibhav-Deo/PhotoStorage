/**
 * NDJSON manifest writer and timeline reconstruction.
 *
 * Requirements:
 * - One NDJSON line per asset, partitioned by capture month (`yyyy-mm`).
 * - Key format: `{prefix}/manifest/{yyyy-mm}.ndjson` (Requirement 10.3, 10.4).
 * - Manifest alone must be sufficient to reconstruct a timeline with dates, locations, and album membership.
 */

export interface ManifestEntry {
  readonly hash: string;
  readonly file: string;
  readonly kind: 'image' | 'video' | 'motion_component';
  readonly bytes: number;
  readonly capturedAt: string; // ISO 8601 date string
  readonly capturedAtSource: 'exif' | 'takeout_json' | 'file_mtime' | 'user';
  readonly lat?: number;
  readonly lon?: number;
  readonly camera?: string;
  readonly albums?: readonly string[];
  readonly livePairHash?: string;
  readonly variantOfHash?: string;
}

export class ManifestError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ManifestError';
    this.cause = cause;
  }
}

/**
 * Formats a single manifest entry as an NDJSON line (JSON object followed by newline).
 */
export function formatManifestLine(entry: ManifestEntry): string {
  const lineObj: Record<string, unknown> = {
    hash: entry.hash,
    file: entry.file,
    kind: entry.kind,
    bytes: entry.bytes,
    capturedAt: entry.capturedAt,
    capturedAtSource: entry.capturedAtSource,
  };

  if (entry.lat !== undefined) lineObj['lat'] = entry.lat;
  if (entry.lon !== undefined) lineObj['lon'] = entry.lon;
  if (entry.camera) lineObj['camera'] = entry.camera;
  if (entry.albums && entry.albums.length > 0) lineObj['albums'] = entry.albums;
  if (entry.livePairHash) lineObj['livePairHash'] = entry.livePairHash;
  if (entry.variantOfHash) lineObj['variantOfHash'] = entry.variantOfHash;

  return JSON.stringify(lineObj) + '\n';
}

/**
 * Parses an NDJSON line into a validated ManifestEntry object.
 */
export function parseManifestLine(line: string): ManifestEntry {
  const trimmed = line.trim();
  if (trimmed === '') {
    throw new ManifestError('Manifest line is empty');
  }

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj['hash'] !== 'string' || !obj['hash']) {
      throw new ManifestError('Missing hash field');
    }
    if (typeof obj['file'] !== 'string' || !obj['file']) {
      throw new ManifestError('Missing file field');
    }
    if (obj['kind'] !== 'image' && obj['kind'] !== 'video' && obj['kind'] !== 'motion_component') {
      throw new ManifestError(`Invalid kind field: ${String(obj['kind'])}`);
    }
    if (typeof obj['bytes'] !== 'number') {
      throw new ManifestError('Missing bytes field');
    }
    if (typeof obj['capturedAt'] !== 'string' || !obj['capturedAt']) {
      throw new ManifestError('Missing capturedAt field');
    }
    if (typeof obj['capturedAtSource'] !== 'string') {
      throw new ManifestError('Missing capturedAtSource field');
    }

    const entry: ManifestEntry = {
      hash: String(obj['hash']),
      file: String(obj['file']),
      kind: obj['kind'],
      bytes: Number(obj['bytes']),
      capturedAt: String(obj['capturedAt']),
      capturedAtSource: obj['capturedAtSource'] as ManifestEntry['capturedAtSource'],
      ...(typeof obj['lat'] === 'number' ? { lat: obj['lat'] } : {}),
      ...(typeof obj['lon'] === 'number' ? { lon: obj['lon'] } : {}),
      ...(typeof obj['camera'] === 'string' ? { camera: obj['camera'] } : {}),
      ...(Array.isArray(obj['albums'])
        ? {
            albums: obj['albums'].filter((a): a is string => typeof a === 'string'),
          }
        : {}),
      ...(typeof obj['livePairHash'] === 'string' ? { livePairHash: obj['livePairHash'] } : {}),
      ...(typeof obj['variantOfHash'] === 'string' ? { variantOfHash: obj['variantOfHash'] } : {}),
    };

    return entry;
  } catch (err) {
    if (err instanceof ManifestError) throw err;
    throw new ManifestError(`Failed to parse manifest line: ${trimmed}`, err);
  }
}

/**
 * Extracts capture month (`yyyy-mm`) from an ISO date string `capturedAt`.
 */
export function monthOfCapturedAt(capturedAt: string): string {
  const match = /^(\d{4}-\d{2})/.exec(capturedAt);
  if (!match || !match[1]) {
    throw new ManifestError(`Invalid ISO capturedAt date string: ${capturedAt}`);
  }
  return match[1];
}

/**
 * Groups manifest entries by capture month (`yyyy-mm`).
 */
export function groupManifestEntriesByMonth(
  entries: readonly ManifestEntry[],
): Map<string, ManifestEntry[]> {
  const groups = new Map<string, ManifestEntry[]>();
  for (const entry of entries) {
    const month = monthOfCapturedAt(entry.capturedAt);
    let list = groups.get(month);
    if (!list) {
      list = [];
      groups.set(month, list);
    }
    list.push(entry);
  }
  return groups;
}

/** Reconstructed Timeline item representation */
export interface TimelineItem {
  readonly hash: string;
  readonly fileName: string;
  readonly date: Date;
  readonly location?: { readonly lat: number; readonly lon: number } | undefined;
  readonly albums: readonly string[];
}

/**
 * Reconstructs a full timeline from a set of manifest entries (Requirement 10.4).
 */
export function reconstructTimelineFromManifest(entries: readonly ManifestEntry[]): TimelineItem[] {
  return entries
    .filter((e) => e.kind !== 'motion_component') // Exclude motion components from main timeline
    .map((e) => {
      const item: TimelineItem = {
        hash: e.hash,
        fileName: e.file,
        date: new Date(e.capturedAt),
        albums: e.albums ?? [],
        ...(e.lat !== undefined && e.lon !== undefined
          ? { location: { lat: e.lat, lon: e.lon } }
          : {}),
      };
      return item;
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}
