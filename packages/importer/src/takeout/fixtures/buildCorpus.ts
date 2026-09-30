/**
 * Materializes {@link TAKEOUT_CORPUS} into a directory.
 *
 * Nothing binary is committed and no fixture tree is checked in: a test asks for a temporary
 * directory, gets a full multi-part Takeout export in it, and the tree is the manifest's
 * shadow rather than a second copy of the truth that can drift from it. `materialize.ts`
 * writes the same tree somewhere durable so a human debugging a pairing failure can `ls` it.
 *
 * ## Why the JSON is written out in full
 *
 * The sidecars here carry Takeout's real field layout — `photoTakenTime` and `creationTime` as
 * `{ timestamp, formatted }` string pairs, `geoData` alongside `geoDataExif`, `people` as
 * objects rather than strings — because parsing that layout is part of what tasks 2.4 and 2.6
 * have to get right. A simplified sidecar would make the fixtures pass against a parser that
 * cannot read a real export.
 *
 * Two details are faithful in a way that matters. Timestamps are seconds-since-epoch *as
 * strings*, so a reader that forgets to coerce gets `NaN` rather than a plausible date. And a
 * fixture with no location still gets a `geoData` block of zeros, exactly as Takeout emits,
 * so `0, 0` has to be read as absent rather than as a point in the Atlantic.
 *
 * ## Validation happens here
 *
 * A manifest that references an undeclared part, an unknown folder, or a folder that does not
 * exist in the part it claims fails the build rather than producing a tree that quietly
 * disagrees with the expectations. `corpus.test.ts` covers the rest.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { ALBUM_METADATA_FILE } from '../traversal.ts';
import { TAKEOUT_CORPUS, TAKEOUT_MEDIA_ROOT } from './corpus.ts';
import type {
  AlbumMetadataFixture,
  FolderFixture,
  GeoFixture,
  SidecarFixture,
  TakeoutCorpus,
} from './corpusTypes.ts';
import { syntheticMediaBytes } from './syntheticMedia.ts';

/** Thrown when the manifest is internally inconsistent, before anything is written. */
export class CorpusBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorpusBuildError';
  }
}

/** Where one fixture's files landed, with paths relative to the corpus root. */
export interface MaterializedMedia {
  readonly id: string;
  readonly mediaPath: string;
  /** `null` for fixtures with no sidecar of their own — including ones that pair by
   * sharing another fixture's sidecar, which pairing has to discover rather than be told. */
  readonly sidecarPath: string | null;
  readonly byteLength: number;
}

/** The result of a build: what was written, and where each fixture went. */
export interface BuiltCorpus {
  /** Absolute path the corpus was written to. */
  readonly root: string;
  /** Every file written, relative to {@link root}, sorted. */
  readonly files: readonly string[];
  /** Keyed by {@link MediaFixture.id}. */
  readonly media: ReadonlyMap<string, MaterializedMedia>;
  /** Every `metadata.json` written, relative to {@link root}. */
  readonly albumMetadata: readonly string[];
}

/**
 * The directory one folder occupies inside one part, relative to the corpus root.
 *
 * The `Takeout/Google Photos` prefix repeats in every part because that is what each zip
 * expands to, and the same logical folder can therefore have a directory under several parts.
 */
export function folderDirIn(part: string, folderDir: string): string {
  return path.join(part, TAKEOUT_MEDIA_ROOT, folderDir);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function epochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new CorpusBuildError(`Not a parseable timestamp: ${JSON.stringify(iso)}`);
  }
  return Math.floor(ms / 1000);
}

/**
 * Takeout's `formatted` companion to a timestamp, e.g. `8 Jun 2019, 14:22:31 UTC`.
 *
 * Built by hand rather than through `Intl`, because the output would then depend on the
 * machine's locale and ICU build and two developers would materialize different corpora.
 */
function formattedUtc(iso: string): string {
  const date = new Date(epochSeconds(iso) * 1000);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return (
    `${String(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}, ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

/** Takeout's `{ timestamp, formatted }` pair. The timestamp is a string, deliberately. */
function takeoutTime(iso: string): { timestamp: string; formatted: string } {
  return { timestamp: String(epochSeconds(iso)), formatted: formattedUtc(iso) };
}

/** Takeout's `geoData`. Absent coordinates are written as zeros, as Takeout does. */
function geoBlock(geo: GeoFixture | undefined): Record<string, number> {
  return {
    latitude: geo?.latitude ?? 0,
    longitude: geo?.longitude ?? 0,
    altitude: geo?.altitude ?? 0,
    latitudeSpan: 0,
    longitudeSpan: 0,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** A sidecar in Takeout's own field layout. */
function sidecarJson(sidecar: SidecarFixture): Uint8Array {
  const geo = geoBlock(sidecar.geo);
  const body: Record<string, unknown> = {
    title: sidecar.title,
    description: '',
    imageViews: '0',
    creationTime: takeoutTime(sidecar.creationAt),
    photoTakenTime: takeoutTime(sidecar.photoTakenAt),
    geoData: geo,
    geoDataExif: geo,
    url: `https://photos.google.com/photo/fixture-${encodeURIComponent(sidecar.title)}`,
    googlePhotosOrigin: { mobileUpload: { deviceType: 'IOS_PHONE' } },
  };
  if (sidecar.people !== undefined) {
    body.people = sidecar.people.map((name) => ({ name }));
  }
  if (sidecar.favorited === true) {
    body.favorited = true;
  }
  if (sidecar.archived === true) {
    body.archived = true;
  }
  if (sidecar.inTrash === true) {
    // Takeout's own spelling for the Trash flag.
    body.trashed = true;
  }
  return jsonBytes(body);
}

/** An album's `metadata.json`. */
function albumMetadataJson(metadata: AlbumMetadataFixture): Uint8Array {
  return jsonBytes({
    title: metadata.title,
    description: metadata.description,
    access: 'protected',
    date: takeoutTime(metadata.albumDate),
    geoData: geoBlock(metadata.geo),
    enrichments: [],
  });
}

/**
 * Rejects a manifest that cannot describe a real export, before writing anything, and
 * returns the folder lookup the write pass needs.
 */
function validate(corpus: TakeoutCorpus): ReadonlyMap<string, FolderFixture> {
  const parts = new Set<string>();
  for (const part of corpus.parts) {
    if (parts.has(part.name)) {
      throw new CorpusBuildError(`Duplicate part: ${part.name}`);
    }
    parts.add(part.name);
  }

  const folders = new Map<string, FolderFixture>();
  for (const folder of corpus.folders) {
    if (folders.has(folder.dir)) {
      throw new CorpusBuildError(`Duplicate folder: ${folder.dir}`);
    }
    if (folder.parts.length === 0) {
      throw new CorpusBuildError(`Folder ${folder.dir} appears in no part`);
    }
    for (const part of folder.parts) {
      if (!parts.has(part)) {
        throw new CorpusBuildError(`Folder ${folder.dir} names an undeclared part: ${part}`);
      }
    }
    folders.set(folder.dir, folder);
  }

  const ids = new Set<string>();
  const occupied = new Set<string>();
  for (const fixture of corpus.media) {
    if (ids.has(fixture.id)) {
      throw new CorpusBuildError(`Duplicate fixture id: ${fixture.id}`);
    }
    ids.add(fixture.id);

    const folder = folders.get(fixture.folder);
    if (folder === undefined) {
      throw new CorpusBuildError(
        `Fixture ${fixture.id} names an unknown folder: ${fixture.folder}`,
      );
    }
    if (!folder.parts.includes(fixture.part)) {
      throw new CorpusBuildError(
        `Fixture ${fixture.id} sits in ${fixture.part}, where folder ${folder.dir} does not exist`,
      );
    }

    const sidecarPart = fixture.sidecar?.part;
    if (sidecarPart !== undefined && !folder.parts.includes(sidecarPart)) {
      throw new CorpusBuildError(
        `Fixture ${fixture.id} puts its sidecar in ${sidecarPart}, where folder ${folder.dir} does not exist`,
      );
    }

    for (const [part, file] of [
      [fixture.part, fixture.file] as const,
      ...(fixture.sidecar === undefined
        ? []
        : [[sidecarPart ?? fixture.part, fixture.sidecar.file] as const]),
    ]) {
      const at = `${folderDirIn(part, folder.dir)}/${file}`;
      if (occupied.has(at)) {
        throw new CorpusBuildError(`Two fixtures write the same path: ${at}`);
      }
      occupied.add(at);
    }
  }

  return folders;
}

/**
 * Writes the corpus into `root`, creating it if needed, and returns what was written.
 *
 * Existing files at the same paths are overwritten. The corpus is deterministic, so building
 * twice into the same directory is a no-op in content; building into a directory that holds
 * something else leaves that something else alone, which is why callers pass a temporary
 * directory rather than trusting this function to clean one.
 */
export async function buildCorpus(
  root: string,
  corpus: TakeoutCorpus = TAKEOUT_CORPUS,
): Promise<BuiltCorpus> {
  const folders = validate(corpus);
  const absoluteRoot = path.resolve(root);

  const files: string[] = [];
  const albumMetadata: string[] = [];
  const media = new Map<string, MaterializedMedia>();

  const write = async (relativePath: string, bytes: Uint8Array): Promise<void> => {
    const absolute = path.join(absoluteRoot, relativePath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
    files.push(relativePath);
  };

  for (const folder of corpus.folders) {
    for (const part of folder.parts) {
      const dir = folderDirIn(part, folder.dir);
      await fs.mkdir(path.join(absoluteRoot, dir), { recursive: true });
      if (folder.metadata !== undefined) {
        const at = path.join(dir, ALBUM_METADATA_FILE);
        await write(at, albumMetadataJson(folder.metadata));
        albumMetadata.push(at);
      }
    }
  }

  for (const fixture of corpus.media) {
    // `validate` proved this lookup resolves.
    const folder = folders.get(fixture.folder) as FolderFixture;

    const bytes = syntheticMediaBytes(fixture.file, fixture.id, fixture.exif?.dateTimeOriginal);
    const mediaPath = path.join(folderDirIn(fixture.part, folder.dir), fixture.file);
    await write(mediaPath, bytes);

    let sidecarPath: string | null = null;
    if (fixture.sidecar !== undefined) {
      sidecarPath = path.join(
        folderDirIn(fixture.sidecar.part ?? fixture.part, folder.dir),
        fixture.sidecar.file,
      );
      await write(sidecarPath, sidecarJson(fixture.sidecar));
    }

    // After the write, or the write would reset it. mtime is the last-resort timestamp
    // source, so a fixture whose expectation depends on it depends on this line.
    const mtime = new Date(epochSeconds(fixture.mtime) * 1000);
    await fs.utimes(path.join(absoluteRoot, mediaPath), mtime, mtime);

    media.set(fixture.id, {
      id: fixture.id,
      mediaPath,
      sidecarPath,
      byteLength: bytes.byteLength,
    });
  }

  files.sort();
  albumMetadata.sort();

  return { root: absoluteRoot, files, media, albumMetadata };
}

/** The fixture whose media or sidecar is at `relativePath`, if any. Used by diagnostics. */
export function fixtureAtPath(
  built: BuiltCorpus,
  relativePath: string,
): MaterializedMedia | undefined {
  for (const entry of built.media.values()) {
    if (entry.mediaPath === relativePath || entry.sidecarPath === relativePath) {
      return entry;
    }
  }
  return undefined;
}
