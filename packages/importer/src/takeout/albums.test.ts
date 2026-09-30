/**
 * Album reconstruction against the fixture corpus (task 2.6, Requirements 1.7 and 3.5).
 *
 * The corpus is the input and its declared expectations are the oracle. Every folder states
 * `isAlbum`, `albumTitle`, and `yearBucket`; every media fixture states `albums`, `folderRole`,
 * `archived`, and `inTrash`. Four of those fixtures are shaped so that a reconstruction that gets
 * the right answer for the wrong reason still fails:
 *
 * - `Familienurlaub 2020` is an album whose `metadata.json` title and folder name are identical, so
 *   returning the folder name passes it by accident. The synthetic case below separates them.
 * - `Photos from 2021` spans two archive parts, so an identity taken per part splits one folder in
 *   two — and if a bucket is ever mistaken for an album that would be a year in an album.
 * - `Archive` and `Trash` are named folders with no `metadata.json`, so a rule that says "any named
 *   folder is an album" turns both into albums.
 * - `trashed-photo` is what a run that opted out of Trash must leave alone and a run that opted in
 *   must flag, which is the only fixture whose *presence* in the import is conditional.
 *
 * Membership is keyed on source paths, because no hash exists during metadata repair.
 * `resolveAlbumMembers` is the seam that turns it into `album_members` rows, and it gets its own
 * group with a stated lookup — including the two cases the corpus cannot express: a member that was
 * never hashed, and two members that deduplicated into one asset.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FlagSource,
  FolderRole,
  TAKEOUT_ALBUM_ID_PREFIX,
  albumRecordsOf,
  folderRoleOf,
  reconstructAlbums,
  reconstructExportAlbums,
  resolveAlbumMembers,
  takeoutAlbumId,
  yearBucketOf,
} from './albums.ts';
import type { AlbumInputs, AlbumReconstruction } from './albums.ts';
import { buildCorpus } from './fixtures/buildCorpus.ts';
import { PART_001, PART_002, PART_003, TAKEOUT_CORPUS } from './fixtures/corpus.ts';
import type { MediaFixture } from './fixtures/corpusTypes.ts';
import { pairExport } from './pairing.ts';
import type { PairingResult } from './pairing.ts';
import { parseAlbumMetadata, parseSidecarFlags } from './sidecar.ts';
import type { AlbumMetadata, SidecarFlags } from './sidecar.ts';
import {
  ALBUM_METADATA_FILE,
  TakeoutFileKind,
  classifyFileName,
  traverseExport,
} from './traversal.ts';
import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

const PARTS = [PART_001, PART_002, PART_003] as const;

let root: string;
let full: TakeoutExport;
let paired: PairingResult;
/** The whole corpus, with Trash left out — the default, and what the design specifies. */
let reconstructed: AlbumReconstruction;
/** The same corpus with Trash opted into. */
let withTrash: AlbumReconstruction;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-albums-'));
  await buildCorpus(root);
  full = await traverseExport(PARTS.map((part) => path.join(root, part)));
  paired = pairExport(full);
  reconstructed = await reconstructExportAlbums(full, { pairing: paired });
  withTrash = await reconstructExportAlbums(full, { pairing: paired, includeTrash: true });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The logical path a fixture's media occupies, which is also its source path. */
function logicalPath(fixture: MediaFixture): string {
  return nfc(`${fixture.folder}/${fixture.file}`);
}

function dispositionOf(reconstruction: AlbumReconstruction, fixture: MediaFixture) {
  const disposition = reconstruction.dispositionBySourcePath.get(logicalPath(fixture));
  if (disposition === undefined) throw new Error(`no disposition for ${fixture.id}`);
  return disposition;
}

// ---------------------------------------------------------------------------
// Synthetic exports, for shapes the corpus deliberately does not contain
// ---------------------------------------------------------------------------

const SYNTHETIC_PART = 'takeout-a-001';

function syntheticFile(dir: string, name: string): TakeoutFile {
  const logical = dir === '' ? nfc(name) : `${dir}/${nfc(name)}`;
  const classified = classifyFileName(name);
  return {
    path: logical,
    dir,
    name: nfc(name),
    kind: classified.kind,
    mediaKind: classified.mediaKind,
    part: SYNTHETIC_PART,
    absolutePath: `/nowhere/${SYNTHETIC_PART}/${logical}`,
    byteSize: 1,
    mtimeMs: 0,
    outsideExport: false,
    sourcePath: logical,
  };
}

interface FolderSpec {
  readonly dir: string;
  /** Whether a `metadata.json` sits in the folder, which is what makes it an album. */
  readonly hasMetadata?: boolean;
  readonly media?: readonly string[];
}

function syntheticFolder(spec: FolderSpec): TakeoutFolder {
  const media = [...(spec.media ?? [])]
    .map((name) => syntheticFile(spec.dir, name))
    .filter((file) => file.kind === TakeoutFileKind.Media)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    path: spec.dir,
    name: spec.dir === '' ? '' : spec.dir.slice(spec.dir.lastIndexOf('/') + 1),
    parts: [SYNTHETIC_PART],
    media,
    sidecars: [],
    albumMetadata: spec.hasMetadata === true ? syntheticFile(spec.dir, ALBUM_METADATA_FILE) : null,
    ignored: [],
    fileNames: media.map((file) => file.name),
    sidecarNames: [],
  };
}

/**
 * An export whose folders are stated rather than materialized. Reconstruction reads folder names,
 * the presence of a `metadata.json`, and the folder's media, so nothing needs to exist on disk —
 * which is what lets the property tests below run hundreds of arrangements.
 */
function syntheticExport(specs: readonly FolderSpec[]): TakeoutExport {
  const folders = specs.map(syntheticFolder);
  const files = folders.flatMap((folder) => folder.media);
  return {
    parts: [{ name: SYNTHETIC_PART, root: '/nowhere', exportRoot: '/nowhere', fileCount: 0 }],
    folders,
    folderByPath: new Map(folders.map((folder) => [folder.path, folder])),
    files,
    media: files,
    sidecars: [],
    ignored: [],
    duplicates: [],
    conflicts: [],
  };
}

function inputs(
  albumMetadata: Readonly<Record<string, AlbumMetadata>> = {},
  sidecarFlags: Readonly<Record<string, SidecarFlags>> = {},
): AlbumInputs {
  return {
    albumMetadata: new Map(Object.entries(albumMetadata)),
    sidecarFlags: new Map(Object.entries(sidecarFlags)),
  };
}

function metadata(title: string | null, albumDateMs?: number): AlbumMetadata {
  return {
    title,
    albumDate:
      albumDateMs === undefined
        ? null
        : { epochMs: albumDateMs, raw: String(albumDateMs / 1000), formatted: null },
    problems: title === null ? ['title is absent'] : [],
  };
}

function flags(partial: Partial<SidecarFlags>): SidecarFlags {
  return { archived: false, inTrash: false, problems: [], ...partial };
}

// ---------------------------------------------------------------------------
// The design's folder table
// ---------------------------------------------------------------------------

describe("the design's folder table", () => {
  it('classifies every folder in the corpus the way the fixture says', () => {
    for (const fixture of TAKEOUT_CORPUS.folders) {
      const classified = reconstructed.folderByPath.get(fixture.dir);
      expect(classified, fixture.dir).toBeDefined();
      expect(classified?.role, fixture.dir).toBe(fixture.role);
      expect(classified?.isAlbum, fixture.dir).toBe(fixture.expect.isAlbum);
      expect(classified?.albumTitle, fixture.dir).toBe(fixture.expect.albumTitle);
      expect(classified?.yearBucket, fixture.dir).toBe(fixture.expect.yearBucket);
    }
  });

  it('makes an album of every folder with metadata.json, and of nothing else', () => {
    expect(reconstructed.albums.map((album) => album.title).sort()).toEqual([
      'Familienurlaub 2020',
      'Iceland 2019',
    ]);
    // Named folders without one. `Archive` and `Trash` are the trap: a rule reading only the
    // folder name would turn both into albums holding everything the user hid or deleted.
    for (const dir of ['Photos from 2019', 'Photos from 2021', 'Archive', 'Trash']) {
      expect(reconstructed.folderByPath.get(dir)?.isAlbum, dir).toBe(false);
    }
  });

  it('treats a folder spanning several parts as one album, not one per part', () => {
    // The bucket is the fixture that spans parts, so it is what proves the identity is logical.
    const bucket = reconstructed.folderByPath.get('Photos from 2021');
    expect(bucket?.parts).toEqual([PART_002, PART_003]);
    expect(bucket?.role).toBe(FolderRole.YearBucket);

    // One classification per logical folder, so nothing is counted twice.
    const paths = reconstructed.folders.map((folder) => folder.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('never makes an album of a year bucket, whatever is in it', () => {
    // Google does not put a metadata.json in a bucket. If one appears, the bucket wins: an album
    // holding a whole year is worse than a missing album, because it looks deliberate.
    expect(folderRoleOf('Photos from 2019', true)).toBe(FolderRole.YearBucket);
    expect(folderRoleOf('Photos from 2019', false)).toBe(FolderRole.YearBucket);
  });

  it('lets a user album be called Archive, because metadata.json is the discriminator', () => {
    expect(folderRoleOf('Archive', false)).toBe(FolderRole.Archive);
    expect(folderRoleOf('Archive', true)).toBe(FolderRole.Album);
    expect(folderRoleOf('trash', false)).toBe(FolderRole.Trash);
  });

  it('puts an unrecognized folder in no album and flags nothing', () => {
    // The export root, and the localization gap this module reports rather than guesses at.
    expect(folderRoleOf('', false)).toBe(FolderRole.Other);
    expect(folderRoleOf('Papierkorb', false)).toBe(FolderRole.Other);
  });

  it('recognizes a year bucket by its exact shape only', () => {
    expect(yearBucketOf('Photos from 2019')).toBe(2019);
    expect(yearBucketOf('photos from 1998')).toBe(1998);
    expect(yearBucketOf('Photos from 19')).toBeNull();
    expect(yearBucketOf('Photos from 2019 (best of)')).toBeNull();
    expect(yearBucketOf('Iceland 2019')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

describe('album titles', () => {
  it('takes the title from metadata.json for every album in the corpus', () => {
    for (const fixture of TAKEOUT_CORPUS.folders) {
      if (fixture.metadata === undefined) continue;
      const album = reconstructed.albums.find((entry) => entry.folderPath === fixture.dir);
      expect(album?.title, fixture.dir).toBe(fixture.metadata.title);
      expect(album?.titleFromMetadata, fixture.dir).toBe(true);
      expect(album?.problems, fixture.dir).toEqual([]);
      expect(album?.albumDate, fixture.dir).toBe(Date.parse(fixture.metadata.albumDate));
    }
  });

  it('prefers the JSON title over the folder name when they differ', () => {
    // The corpus cannot establish this: its album titles equal their folder names, which is what
    // Takeout normally writes and exactly why the fixture notes the distinction.
    const result = reconstructAlbums(
      syntheticExport([{ dir: 'Trip', hasMetadata: true, media: ['IMG_1.jpg'] }]),
      inputs({ Trip: metadata('Ring road, August 2019') }),
    );
    expect(result.albums[0]?.title).toBe('Ring road, August 2019');
    expect(result.folderByPath.get('Trip')?.albumTitle).toBe('Ring road, August 2019');
  });

  it('falls back to the folder name rather than losing the album', () => {
    const result = reconstructAlbums(
      syntheticExport([{ dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg'] }]),
      inputs({ Iceland: metadata(null) }),
    );
    const album = result.albums[0];
    expect(album?.title).toBe('Iceland');
    expect(album?.titleFromMetadata).toBe(false);
    expect(album?.problems).toEqual(['title is absent']);
    // The membership is the part that cannot be reconstructed later, so it survives.
    expect(album?.memberSourcePaths).toEqual(['Iceland/IMG_1.jpg']);
  });

  it('reads the title and date out of the metadata.json Takeout actually writes', () => {
    const parsed = parseAlbumMetadata(
      JSON.stringify({
        title: 'Iceland 2019',
        description: 'Ring road, August 2019',
        access: 'protected',
        date: { timestamp: '1565740800', formatted: '14 Aug 2019, 00:00:00 UTC' },
        enrichments: [],
      }),
    );
    expect(parsed.title).toBe('Iceland 2019');
    expect(parsed.albumDate?.epochMs).toBe(1565740800000);
    expect(parsed.problems).toEqual([]);
  });

  it('treats a blank title as absent and survives an unreadable metadata.json', () => {
    expect(parseAlbumMetadata('{"title":"   "}').title).toBeNull();
    expect(parseAlbumMetadata('{"title":"   "}').problems).toContain('title is blank');
    expect(parseAlbumMetadata('{ truncated').problems[0]).toMatch(/not valid JSON/u);
    expect(parseAlbumMetadata('[]').problems[0]).toMatch(/not an object/u);
  });
});

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

describe('album ids', () => {
  it('is a namespaced digest of the folder path', () => {
    const id = takeoutAlbumId('Iceland 2019');
    expect(id.startsWith(TAKEOUT_ALBUM_ID_PREFIX)).toBe(true);
    expect(id.slice(TAKEOUT_ALBUM_ID_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/u);
    expect(reconstructed.albums.map((album) => album.id)).toEqual(
      reconstructed.albums.map((album) => takeoutAlbumId(album.folderPath)),
    );
  });

  it('is the same on a second import of the same export', async () => {
    // The whole point: re-importing must update the album rows, not add a second set of them.
    const again = await reconstructExportAlbums(full, { pairing: paired });
    expect(again.albums.map((album) => album.id)).toEqual(
      reconstructed.albums.map((album) => album.id),
    );
  });

  it('does not depend on which parts the export was assembled from', async () => {
    // Iceland 2019 lives in part 001 alone, so importing that part by itself must produce the same
    // album — otherwise a resumed or re-split download would duplicate it.
    const onePart = await traverseExport([path.join(root, PART_001)]);
    const partial = await reconstructExportAlbums(onePart, { pairing: pairExport(onePart) });
    const iceland = partial.albums.find((album) => album.title === 'Iceland 2019');
    expect(iceland?.id).toBe(
      reconstructed.albums.find((album) => album.title === 'Iceland 2019')?.id,
    );
  });

  it('keeps two albums with the same title apart', () => {
    // Google Photos allows duplicate album names, and the export distinguishes them by folder. An
    // id derived from the title would merge them and mix their contents.
    const result = reconstructAlbums(
      syntheticExport([
        { dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg'] },
        { dir: 'Iceland(1)', hasMetadata: true, media: ['IMG_2.jpg'] },
      ]),
      inputs({ Iceland: metadata('Iceland'), 'Iceland(1)': metadata('Iceland') }),
    );
    expect(result.albums).toHaveLength(2);
    expect(result.albums[0]?.title).toBe(result.albums[1]?.title);
    expect(result.albums[0]?.id).not.toBe(result.albums[1]?.id);
  });

  it('writes album rows whose created_at is the album date, not the import time', () => {
    const records = albumRecordsOf(reconstructed, { now: 1_700_000_000_000 });
    const iceland = records.find((record) => record.title === 'Iceland 2019');
    expect(iceland?.createdAt).toBe(Date.parse('2019-08-14T00:00:00Z'));
    expect(iceland?.updatedAt).toBe(1_700_000_000_000);
    expect(iceland?.deletedAt).toBeNull();
    expect(iceland?.version).toBe(0);
    expect(records.map((record) => record.id)).toEqual(
      reconstructed.albums.map((album) => album.id),
    );
  });
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

describe('membership', () => {
  it('gives every media fixture exactly the albums it declares', () => {
    for (const fixture of TAKEOUT_CORPUS.media) {
      const disposition = dispositionOf(withTrash, fixture);
      expect([...disposition.albumTitles].sort(), fixture.id).toEqual(
        [...fixture.expect.albums].sort(),
      );
      expect(disposition.folderRole, fixture.id).toBe(fixture.expect.folderRole);
      expect(disposition.albumIds.length, fixture.id).toBe(fixture.expect.albums.length);
    }
  });

  it('includes a Live Photo motion component, which the album shows through its still', () => {
    // A motion component is a real asset with its own hash, hidden from the timeline by its kind
    // rather than by being left out of the album (task 2.5). Leaving it out of the membership
    // would make the album disagree with the folder it came from.
    const album = reconstructed.albums.find((entry) => entry.title === 'Iceland 2019');
    expect(album?.memberSourcePaths).toContain('Iceland 2019/IMG_2001.MOV');
    expect(album?.memberSourcePaths).toContain('Iceland 2019/IMG_2001.HEIC');
  });

  it('records one row per album for an asset in several, and no copy of anything', () => {
    const result = reconstructAlbums(
      syntheticExport([
        { dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg'] },
        { dir: 'Best of', hasMetadata: true, media: ['IMG_1.jpg'] },
        { dir: 'Trip', hasMetadata: true, media: ['IMG_1.jpg'] },
      ]),
      inputs({
        Iceland: metadata('Iceland'),
        'Best of': metadata('Best of'),
        Trip: metadata('Trip'),
      }),
    );
    // Three folders, one photo: the same bytes filed three times, so one hash for all of them.
    const resolved = resolveAlbumMembers(result, () => 'a'.repeat(64));

    expect(resolved.members).toHaveLength(3);
    expect(new Set(resolved.members.map((member) => member.hash)).size).toBe(1);
    expect(new Set(resolved.members.map((member) => member.albumId)).size).toBe(3);
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.duplicates).toEqual([]);
  });

  it('numbers positions from zero within each album, in folder order', () => {
    const result = reconstructAlbums(
      syntheticExport([
        { dir: 'Iceland', hasMetadata: true, media: ['IMG_3.jpg', 'IMG_1.jpg', 'IMG_2.jpg'] },
      ]),
      inputs({ Iceland: metadata('Iceland') }),
    );
    const resolved = resolveAlbumMembers(result, (sourcePath) =>
      sourcePath.slice(-5, -4).repeat(64),
    );
    expect(resolved.members.map((member) => member.position)).toEqual([0, 1, 2]);
    // Folder order, which traversal sorted by name, so the answer does not depend on the part.
    expect(resolved.members.map((member) => member.hash[0])).toEqual(['1', '2', '3']);
  });

  it('reports a member with no hash instead of dropping it from the album', () => {
    const result = reconstructAlbums(
      syntheticExport([{ dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg', 'IMG_2.jpg'] }]),
      inputs({ Iceland: metadata('Iceland') }),
    );
    const resolved = resolveAlbumMembers(result, (sourcePath) =>
      sourcePath.endsWith('IMG_1.jpg') ? 'a'.repeat(64) : null,
    );
    expect(resolved.members).toHaveLength(1);
    expect(resolved.unresolved).toHaveLength(1);
    expect(resolved.unresolved[0]?.sourcePath).toBe('Iceland/IMG_2.jpg');
    expect(resolved.unresolved[0]?.reason).toMatch(/no content hash/u);
  });

  it('collapses two members that deduplicated into one asset, and says so', () => {
    const result = reconstructAlbums(
      syntheticExport([{ dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg', 'IMG_2.jpg'] }]),
      inputs({ Iceland: metadata('Iceland') }),
    );
    // Byte-identical files under two names are one asset, and (album_id, hash) is the primary key.
    const resolved = resolveAlbumMembers(result, () => 'b'.repeat(64));
    expect(resolved.members).toHaveLength(1);
    expect(resolved.duplicates).toEqual([
      {
        albumId: result.albums[0]?.id,
        hash: 'b'.repeat(64),
        sourcePath: 'Iceland/IMG_2.jpg',
        keptSourcePath: 'Iceland/IMG_1.jpg',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Archive and Trash
// ---------------------------------------------------------------------------

describe('Archive and Trash', () => {
  it('imports an archived photo and flags it', () => {
    const fixture = TAKEOUT_CORPUS.media.find((entry) => entry.id === 'archived-photo');
    if (fixture === undefined) throw new Error('the corpus has no archived-photo fixture');
    const disposition = dispositionOf(reconstructed, fixture);

    expect(disposition.imported).toBe(true);
    expect(disposition.archived).toBe(true);
    expect(disposition.inTrash).toBe(false);
    // Both the folder and the sidecar say so, and both are recorded.
    expect(disposition.archivedBy).toEqual([FlagSource.Folder, FlagSource.Sidecar]);
    expect(disposition.albumIds).toEqual([]);
  });

  it('flags a photo archived in place, which no folder name reveals', () => {
    // Google Photos archives items where they are: an archived photo stays in its year bucket and
    // only the sidecar says so. Reading the folder alone loses the flag for most of them.
    const result = reconstructAlbums(
      syntheticExport([{ dir: 'Photos from 2019', media: ['IMG_1.jpg'] }]),
      inputs({}, { 'Photos from 2019/IMG_1.jpg': flags({ archived: true }) }),
    );
    const disposition = result.dispositionBySourcePath.get('Photos from 2019/IMG_1.jpg');
    expect(disposition?.archived).toBe(true);
    expect(disposition?.archivedBy).toEqual([FlagSource.Sidecar]);
    expect(disposition?.folderRole).toBe(FolderRole.YearBucket);
  });

  it('leaves the trash alone by default, with a reason', () => {
    const fixture = TAKEOUT_CORPUS.media.find((entry) => entry.id === 'trashed-photo');
    if (fixture === undefined) throw new Error('the corpus has no trashed-photo fixture');
    const disposition = dispositionOf(reconstructed, fixture);

    expect(disposition.imported).toBe(false);
    expect(disposition.inTrash).toBe(true);
    expect(disposition.skipReason).toMatch(/trash/iu);
    expect(reconstructed.skipped).toContain(disposition);
    // And it is the only thing left behind, so nothing else was swept up with it.
    expect(reconstructed.skipped).toHaveLength(1);
  });

  it('imports and flags the trash when the caller opts in', () => {
    const fixture = TAKEOUT_CORPUS.media.find((entry) => entry.id === 'trashed-photo');
    if (fixture === undefined) throw new Error('the corpus has no trashed-photo fixture');
    const disposition = dispositionOf(withTrash, fixture);

    expect(disposition.imported).toBe(true);
    expect(disposition.inTrash).toBe(true);
    expect(disposition.inTrashBy).toEqual([FlagSource.Folder, FlagSource.Sidecar]);
    expect(disposition.skipReason).toBeNull();
    expect(withTrash.skipped).toEqual([]);
  });

  it('keeps a skipped item out of the albums it would have joined', () => {
    // A trashed item can sit inside an album folder. An album cannot have a member that was never
    // imported, so the membership has to follow the skip.
    const specs = [{ dir: 'Iceland', hasMetadata: true, media: ['IMG_1.jpg', 'IMG_2.jpg'] }];
    const trashed = inputs(
      { Iceland: metadata('Iceland') },
      { 'Iceland/IMG_2.jpg': flags({ inTrash: true }) },
    );

    const excluded = reconstructAlbums(syntheticExport(specs), trashed);
    expect(excluded.albums[0]?.memberSourcePaths).toEqual(['Iceland/IMG_1.jpg']);
    expect(excluded.dispositionBySourcePath.get('Iceland/IMG_2.jpg')?.albumIds).toEqual([]);

    const included = reconstructAlbums(syntheticExport(specs), trashed, { includeTrash: true });
    expect(included.albums[0]?.memberSourcePaths).toEqual([
      'Iceland/IMG_1.jpg',
      'Iceland/IMG_2.jpg',
    ]);
  });

  it('reads the flags Takeout writes, and refuses to coerce ones it does not', () => {
    expect(parseSidecarFlags('{"archived":true,"trashed":true}')).toEqual({
      archived: true,
      inTrash: true,
      problems: [],
    });
    // Omitted is the ordinary case for false, and silent.
    expect(parseSidecarFlags('{"title":"IMG_1.jpg"}')).toEqual({
      archived: false,
      inTrash: false,
      problems: [],
    });
    // A string is not a boolean. Coercing `"true"` would be a guess; reading it as false without
    // saying so would import what the user deleted.
    const coerced = parseSidecarFlags('{"trashed":"true"}');
    expect(coerced.inTrash).toBe(false);
    expect(coerced.problems).toHaveLength(1);
    expect(coerced.problems[0]).toMatch(/not a boolean/u);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** Folder names whose *combinations* are the interesting part, as in the corpus. */
const FOLDER_NAMES: readonly string[] = [
  'Photos from 2019',
  'Photos from 2021',
  'Iceland 2019',
  'Archive',
  'Trash',
  'Papierkorb',
  '',
];

const MEDIA_NAMES: readonly string[] = ['IMG_1.jpg', 'IMG_2.HEIC', 'IMG_3.MOV', 'VID_1.mp4'];

describe('reconstruction invariants', () => {
  /**
   * **Validates: Requirements 1.7** — the folder table is a total function of a folder's name and
   * whether it holds a `metadata.json`, and album identity follows the folder rather than anything
   * that varies between two downloads of the same library.
   *
   * A fixed example cannot establish these, because the failures come from combinations: a bucket
   * that also has a metadata.json, an `Archive` that is really an album, two folders with one
   * title. Four clauses, each of which a plausible wrong reconstruction violates.
   */
  it('classifies any set of folders consistently, and identifies albums by path', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            dir: fc.constantFrom(...FOLDER_NAMES),
            hasMetadata: fc.boolean(),
            media: fc.uniqueArray(fc.constantFrom(...MEDIA_NAMES), { maxLength: 3 }),
          }),
          { minLength: 1, maxLength: 5, selector: (spec) => spec.dir },
        ),
        (specs) => {
          const result = reconstructAlbums(syntheticExport(specs), inputs());

          // Every folder is classified exactly once, and nothing is invented.
          expect(result.folders.map((folder) => folder.path).sort()).toEqual(
            specs.map((spec) => spec.dir).sort(),
          );

          for (const folder of result.folders) {
            const spec = specs.find((candidate) => candidate.dir === folder.path);
            const isBucket = yearBucketOf(folder.path) !== null;

            // An album is a folder with metadata.json that is not a year bucket. Nothing else.
            expect(folder.isAlbum).toBe(spec?.hasMetadata === true && !isBucket);
            expect(folder.isAlbum).toBe(folder.role === FolderRole.Album);
            expect(folder.albumId).toBe(folder.isAlbum ? takeoutAlbumId(folder.path) : null);
            expect(folder.yearBucket !== null).toBe(isBucket);
          }

          // Only album folders contribute members, and every member is one of that folder's files.
          for (const album of result.albums) {
            const folder = result.folderByPath.get(album.folderPath);
            expect(folder?.isAlbum).toBe(true);
            for (const member of album.memberSourcePaths) {
              expect(member.startsWith(album.folderPath)).toBe(true);
            }
          }

          // One disposition per media file, imported or not: nothing dropped, nothing doubled.
          const mediaCount = specs.reduce(
            (total, spec) =>
              total +
              spec.media.filter((name) => classifyFileName(name).kind === TakeoutFileKind.Media)
                .length,
            0,
          );
          expect(result.media).toHaveLength(mediaCount);
          expect(result.dispositionBySourcePath.size).toBe(mediaCount);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 3.5** — album membership is recorded as references without
   * duplicating stored bytes.
   *
   * The generator is what makes this a test of the property rather than of one arrangement: media
   * names repeat across albums, and the hash lookup deliberately collapses several source paths
   * onto one digest, which is what dedupe does to byte-identical files. Four clauses:
   *
   * - a member row carries an album id, a hash, and a position — never a path or a copy;
   * - `(album_id, hash)` never repeats, since it is the primary key;
   * - the distinct hashes across every album never exceed the distinct hashes in the library, so
   *   filing one asset in five albums stores it once;
   * - every member is accounted for exactly once, as a row, an unresolved report, or a collapse.
   */
  it('records membership by reference for any arrangement of albums', () => {
    const albumDirs = ['Iceland', 'Best of', 'Trip', 'Familienurlaub'] as const;

    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            dir: fc.constantFrom(...albumDirs),
            media: fc.uniqueArray(fc.constantFrom(...MEDIA_NAMES), {
              minLength: 1,
              maxLength: 4,
            }),
          }),
          { minLength: 1, maxLength: 4, selector: (spec) => spec.dir },
        ),
        // Which filenames share one digest, so the same bytes appear in several albums.
        fc.dictionary(fc.constantFrom(...MEDIA_NAMES), fc.integer({ min: 0, max: 2 })),
        fc.uniqueArray(fc.constantFrom(...MEDIA_NAMES), { maxLength: 2 }),
        (specs, digestByName, unhashed) => {
          const result = reconstructAlbums(
            syntheticExport(specs.map((spec) => ({ ...spec, hasMetadata: true }))),
            inputs(Object.fromEntries(specs.map((spec) => [spec.dir, metadata(spec.dir)]))),
          );

          const nameOf = (sourcePath: string): string =>
            sourcePath.slice(sourcePath.lastIndexOf('/') + 1);
          const resolved = resolveAlbumMembers(result, (sourcePath) => {
            const name = nameOf(sourcePath);
            if (unhashed.includes(name)) return null;
            return String(digestByName[name] ?? 0).repeat(64);
          });

          const keys = resolved.members.map((member) => `${member.albumId}\u0000${member.hash}`);
          expect(new Set(keys).size).toBe(keys.length);

          const libraryHashes = new Set(
            result.albums
              .flatMap((album) => album.memberSourcePaths)
              .filter((sourcePath) => !unhashed.includes(nameOf(sourcePath)))
              .map((sourcePath) => String(digestByName[nameOf(sourcePath)] ?? 0).repeat(64)),
          );
          expect(new Set(resolved.members.map((member) => member.hash)).size).toBe(
            libraryHashes.size,
          );

          for (const member of resolved.members) {
            expect(member.hash).toMatch(/^[0-9a-f]{64}$/u);
            expect(result.albumById.has(member.albumId)).toBe(true);
          }

          const declared = result.albums.reduce(
            (total, album) => total + album.memberSourcePaths.length,
            0,
          );
          expect(
            resolved.members.length + resolved.unresolved.length + resolved.duplicates.length,
          ).toBe(declared);
        },
      ),
      { numRuns: 300 },
    );
  });
});
