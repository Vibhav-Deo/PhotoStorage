/**
 * Album reconstruction (task 2.6, Requirements 1.7 and 3.5).
 *
 * This is the second half of `MetadataRepair` (design: Importer components) and the last of the
 * Takeout repair rules. It reads the design's folder table and produces three things:
 *
 * - the **albums** an export contains, with titles taken from `metadata.json`;
 * - **membership**, by reference, so an asset in many albums is stored once (Requirement 3.5);
 * - the **`Archive` / `Trash` flags**, and the decision not to import trashed items unless the
 *   caller opted in.
 *
 * The folder table is the whole specification, and it is four rows:
 *
 * | Folder | What it is |
 * |---|---|
 * | `Photos from YYYY/` | Not an album. A chronological bucket |
 * | Any other named folder with `metadata.json` | An album; title from the JSON, membership from the folder's contents |
 * | `Archive/`, `Trash/` | Imported but flagged; Trash is opt-in |
 *
 * ## Precedence, because the rows overlap
 *
 * Stated as a list of patterns the rows can match one file in more than one way, so
 * {@link folderRoleOf} applies them in a fixed order and each step is a decision with a reason:
 *
 * 1. **`Photos from YYYY` is a year bucket, whatever else is true of it.** Ahead of the
 *    `metadata.json` test on purpose: a bucket holds a whole year, and an album containing every
 *    photo from 2019 is worse than a missing album because it looks deliberate. Google does not
 *    write a `metadata.json` into a bucket, so one appearing there is someone else's file.
 * 2. **`metadata.json` makes an album.** This is above the `Archive` / `Trash` names rather than
 *    below them for a case that really happens: a user can name an album "Archive". Google's own
 *    Archive folder never carries a `metadata.json`, so the file is what tells the two apart.
 * 3. **`Archive` and `Trash` by name**, which is all there is to go on — those folders carry no
 *    metadata of their own.
 * 4. **Everything else is {@link FolderRole.Other}**: the export root, Google's furniture, and
 *    any folder shape this table has not seen. Its media is imported, unflagged, in no album.
 *
 * ## The names are English-only, and that is a real limitation
 *
 * `Archive` and `Trash` are localized per account, exactly as the `-edited` suffix is, and this
 * module takes the same position `variants.ts` takes on that table: a short list of names it can
 * actually verify, rather than a longer list of guesses. The consequence is worth stating plainly
 * because it is not symmetrical with the variant case. An unrecognized `-edited` suffix produces a
 * near-duplicate in the timeline, which is visible. An unrecognized *Trash* folder is imported
 * unflagged, which means a run that opted out of Trash imports the user's deleted photos anyway.
 *
 * So the mitigation is reporting rather than guessing: every folder is classified and returned in
 * {@link AlbumReconstruction.folders}, role included, so task 2.12 can surface a top-level folder
 * with no `metadata.json` that the table did not recognize. A user looking at "`Papierkorb`, role
 * other, 214 items" can see what happened; a silent import cannot be seen at all.
 *
 * ## Album identity: derived from the folder path, not the title
 *
 * `albums.id` is `TEXT` and has to be **stable across re-imports**, because a second import of the
 * same export must record the same albums rather than a second copy of them. So the id is a pure
 * function of something the export already contains, and {@link takeoutAlbumId} makes it the
 * album's **logical folder path**: `takeout-album:` plus the SHA-256 of the NFC path.
 *
 * Four decisions are packed into that, and each rules something out:
 *
 * - **Not the title.** Google Photos allows two albums with the same name, and the export
 *   distinguishes them by folder rather than by title. Hashing the title would merge two distinct
 *   albums into one and mix their contents, which is unrecoverable once the ids are shared.
 * - **Not a random id.** A UUID per run would duplicate every album on the second import, which is
 *   precisely the failure this derivation exists to prevent.
 * - **The logical path, so never the part.** Takeout splits on size, so an album folder can appear
 *   in several archive parts — the corpus's `Photos from 2021` spans two — and a per-part identity
 *   would split one album into two. Traversal has already merged the parts; this module works in
 *   its merged folders and nothing here sees a part name.
 * - **Nothing about the export itself.** No download date, no part set, no root directory: two
 *   downloads of the same library must produce the same ids, so the derivation deliberately has no
 *   input that distinguishes one download from another.
 *
 * The path is hashed rather than used as the id because it is unbounded in length and full of
 * spaces, slashes, and arbitrary Unicode, and this value goes on to be a DynamoDB attribute, a
 * manifest field, and eventually part of a URL. A fixed-length hex digest needs no escaping
 * anywhere. The `takeout-album:` prefix namespaces it, for the reason `sourceRefId` namespaces a
 * device source: an album created on a device later will derive its id from something else
 * entirely, and two derivations sharing one id space is the kind of collision nothing downstream
 * can detect.
 *
 * ## Membership is by source path here, and by hash one step later
 *
 * `album_members.hash` is a content hash, and no hash exists during metadata repair — hashing is
 * the `Hash` stage, and this runs from `ExtractMeta` over filenames and JSON. Task 2.5 hit the
 * same wall with `variant_of_hash` and settled it by keying relationships on
 * {@link TakeoutFile.sourcePath} and resolving them to hashes in a separate pure function; this
 * module follows that pattern rather than inventing a second one. {@link reconstructAlbums}
 * produces {@link TakeoutAlbum.memberSourcePaths}, and {@link resolveAlbumMembers} turns those
 * into `album_members` rows given a lookup from source path to hash.
 *
 * That split is also what makes Requirement 3.5 hold *by construction*. A member row is
 * `(album_id, hash, position)` and carries no bytes, no path, and no copy of anything: an asset in
 * five albums is five rows of about seventy bytes pointing at one object. Two consequences that
 * fall out of resolution rather than out of the rule:
 *
 * - **Two members of one album can be the same asset.** Byte-identical files under different names
 *   deduplicate to one hash, and `(album_id, hash)` is the primary key, so the second one is
 *   collapsed into the first rather than inserted — reported in
 *   {@link ResolvedAlbumMembers.duplicates}, since "42 items" becoming 41 needs an explanation.
 * - **A member may have no hash yet.** Its `Hash` job may have failed or be queued. The row is not
 *   invented; it is reported in {@link ResolvedAlbumMembers.unresolved}, because an album silently
 *   missing a photo is a wrong answer nobody would notice (Requirement 1.10).
 *
 * ## Trash is opt-in, and opting out means not importing
 *
 * {@link AlbumOptions.includeTrash} expresses it, and it defaults to **false**. The design says
 * Trash is opt-in, and Google's Trash holds what the user deleted, so importing it by default
 * would restore deletions the user made on purpose — the archive would disagree with the library
 * it was migrated from, in the one direction the user did not ask for.
 *
 * Opting out excludes the item from the import entirely rather than importing it flagged:
 * {@link MediaDisposition.imported} is false, {@link MediaDisposition.skipReason} says why, and
 * nothing hashes, uploads, or files it in an album. That is a reportable outcome rather than a
 * silent one, and re-running with `includeTrash: true` picks the items up, so the cheap error is
 * recoverable and the expensive one — an unasked-for restore — cannot happen by default.
 *
 * Both flag sources count. An item is in the trash if it sits in a `Trash` folder **or** its
 * sidecar says `trashed`, and archived likewise, with {@link MediaDisposition.inTrashBy} recording
 * which evidence spoke so a disagreement is visible. The union rather than the folder alone,
 * because Google Photos archives items in place: an archived photo stays in its `Photos from YYYY`
 * bucket and only the sidecar says so, and reading the folder alone would lose the flag for every
 * archived photo in the export.
 */

import { portableSha256 } from '@photo-archive/core';
import type { AlbumRecord } from '@photo-archive/core';

import type { PairingResult } from './pairing.ts';
import { readAlbumMetadata, readSidecarFlags } from './sidecar.ts';
import type {
  AlbumMetadata,
  AlbumMetadataReader,
  SidecarFlags,
  SidecarFlagsReader,
} from './sidecar.ts';
import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';
import type { ContentHashLookup } from './variants.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

/** Codepoint order. `localeCompare` would make this module's output depend on the machine's ICU. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Folder roles
// ---------------------------------------------------------------------------

/**
 * What a Takeout folder means, which its name alone does not settle — see this module's header
 * for the precedence between these (design: Takeout metadata repair).
 *
 * Strings rather than the numeric `const` objects in `states.ts`, and for the same reason
 * `TakeoutFileKind` is: a role lives for one import run. What persists is an `albums` row, a flag
 * on an asset, or a line in the reconciliation report.
 */
export const FolderRole = {
  /** A named folder with `metadata.json`. Becomes an album; title comes from the JSON. */
  Album: 'album',
  /** `Photos from YYYY`. Never an album, no matter what else is in it. */
  YearBucket: 'year-bucket',
  /** `Archive/`. Imported and flagged archived. */
  Archive: 'archive',
  /** `Trash/`. Imported and flagged, and importing it at all is opt-in. */
  Trash: 'trash',
  /**
   * Anything else: the export root, a folder shape this module has not seen, and a localized
   * `Archive` or `Trash` the name table does not carry. Media is imported, unflagged, in no album.
   */
  Other: 'other',
} as const;
export type FolderRole = (typeof FolderRole)[keyof typeof FolderRole];

/**
 * The chronological bucket Google names after a year, matched against a lowercased NFC folder
 * name. Four digits exactly, and nothing else in the name, so an album called
 * `Photos from 2019 (best of)` stays an album.
 */
const YEAR_BUCKET_PATTERN = /^photos from (\d{4})$/u;

/**
 * The year a folder is the bucket for, or null when it is not a bucket.
 *
 * Exported because it is also the answer to "which year does this hold", which the reconciliation
 * report wants, and because a rule this consequential is worth being able to test on a name alone.
 */
export function yearBucketOf(folderName: string): number | null {
  const match = YEAR_BUCKET_PATTERN.exec(nfc(folderName).toLowerCase());
  const year = match?.[1];
  return year === undefined ? null : Number(year);
}

/**
 * Folder names Google gives the two flagged folders, lowercased. English only, deliberately
 * incomplete, and the limitation is spelled out in this module's header.
 */
const FLAGGED_FOLDER_ROLES: ReadonlyMap<string, FolderRole> = new Map([
  ['archive', FolderRole.Archive],
  ['trash', FolderRole.Trash],
]);

/**
 * What a folder is, from its name and whether it holds a `metadata.json`.
 *
 * The whole of the design's folder table, in precedence order, in one pure function. Takes the two
 * facts it needs rather than a {@link TakeoutFolder} so the table is testable on a name.
 */
export function folderRoleOf(folderName: string, hasAlbumMetadata: boolean): FolderRole {
  if (yearBucketOf(folderName) !== null) return FolderRole.YearBucket;
  if (hasAlbumMetadata) return FolderRole.Album;
  return FLAGGED_FOLDER_ROLES.get(nfc(folderName).toLowerCase()) ?? FolderRole.Other;
}

// ---------------------------------------------------------------------------
// Album identity
// ---------------------------------------------------------------------------

/** Namespaces {@link takeoutAlbumId}, so a device-created album can never collide with one. */
export const TAKEOUT_ALBUM_ID_PREFIX = 'takeout-album:';

/**
 * The `albums.id` for the album at `folderPath`.
 *
 * Pure, and a function of the logical folder path alone: the same album in a re-download of the
 * same library gets the same id, so a second import updates its row instead of adding one. See
 * this module's header for why the path and not the title, and why it is hashed.
 */
export function takeoutAlbumId(folderPath: string): string {
  const hasher = portableSha256();
  hasher.update(new TextEncoder().encode(nfc(folderPath)));
  return `${TAKEOUT_ALBUM_ID_PREFIX}${hasher.digest()}`;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Which evidence said an item is archived or trashed. Both are recorded when both did. */
export const FlagSource = {
  /** The item's folder: `Archive/` or `Trash/`. */
  Folder: 'folder',
  /** The item's sidecar: `"archived": true` or `"trashed": true`. */
  Sidecar: 'sidecar',
} as const;
export type FlagSource = (typeof FlagSource)[keyof typeof FlagSource];

/** What one folder of an export turned out to be. One per merged folder, export root included. */
export interface FolderClassification {
  /** Logical folder path, `/`-separated and NFC. `''` is the export root. */
  readonly path: string;
  readonly name: string;
  readonly role: FolderRole;
  /** True exactly when {@link role} is {@link FolderRole.Album}. */
  readonly isAlbum: boolean;
  /** {@link takeoutAlbumId} of this folder, or null when it is not an album. */
  readonly albumId: string | null;
  /** The album's title, or null when the folder is not an album. */
  readonly albumTitle: string | null;
  /** The year, when this is a `Photos from YYYY` bucket. Null otherwise. */
  readonly yearBucket: number | null;
  /** Archive parts this folder appeared in. More than one is ordinary; see the header. */
  readonly parts: readonly string[];
}

/** One reconstructed album (Requirement 1.7). Membership is by reference; see the header. */
export interface TakeoutAlbum {
  /** `albums.id`. Stable across re-imports. */
  readonly id: string;
  /** The logical folder the album was reconstructed from, and the basis of {@link id}. */
  readonly folderPath: string;
  /** `albums.title`. From `metadata.json`, or the folder name as a stated fallback. */
  readonly title: string;
  /**
   * False when `metadata.json` supplied no usable title and {@link title} is the folder name.
   *
   * Worth a field rather than only a problem line: the title is what the user sees, so a fallback
   * is a visible degradation even when nothing else went wrong.
   */
  readonly titleFromMetadata: boolean;
  /** The album's own `date` in epoch milliseconds. Becomes `AlbumRecord.createdAt`. */
  readonly albumDate: number | null;
  readonly parts: readonly string[];
  /**
   * Members, in folder order, as {@link TakeoutFile.sourcePath}. Positions are these indices.
   *
   * Excludes anything the import is leaving behind — trashed items when Trash was not opted into —
   * because an album cannot have a member that was never imported.
   */
  readonly memberSourcePaths: readonly string[];
  /** Problems reading `metadata.json`. Empty for an ordinary album. */
  readonly problems: readonly string[];
}

/** What album reconstruction concluded about one media file. */
export interface MediaDisposition {
  readonly sourcePath: string;
  readonly folderPath: string;
  readonly folderRole: FolderRole;
  /** Albums this file belongs to, by id. Empty outside an album folder. */
  readonly albumIds: readonly string[];
  /** Album titles, in the same order as {@link albumIds}. For the report and the manifest. */
  readonly albumTitles: readonly string[];
  readonly archived: boolean;
  /** Evidence for {@link archived}, in a fixed order. Empty when it is false. */
  readonly archivedBy: readonly FlagSource[];
  readonly inTrash: boolean;
  /** Evidence for {@link inTrash}, in a fixed order. Empty when it is false. */
  readonly inTrashBy: readonly FlagSource[];
  /** False only for a trashed item when Trash was not opted into. */
  readonly imported: boolean;
  /** Why this file is not being imported, for the report. Null when {@link imported} is true. */
  readonly skipReason: string | null;
}

/** What album reconstruction concluded about an export. */
export interface AlbumReconstruction {
  /** Every album, sorted by folder path. */
  readonly albums: readonly TakeoutAlbum[];
  readonly albumById: ReadonlyMap<string, TakeoutAlbum>;
  /** Every folder, sorted by path, whatever its role. The report's view of the export's shape. */
  readonly folders: readonly FolderClassification[];
  readonly folderByPath: ReadonlyMap<string, FolderClassification>;
  /** Every media file, in export order, imported or not. */
  readonly media: readonly MediaDisposition[];
  readonly dispositionBySourcePath: ReadonlyMap<string, MediaDisposition>;
  /** The subset of {@link media} that is not being imported. Task 2.12's skipped list. */
  readonly skipped: readonly MediaDisposition[];
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** Policy, separate from the facts the rule reads. */
export interface AlbumOptions {
  /**
   * Import what Google put in the trash. **Defaults to false**; see this module's header for why
   * the default is the one that leaves a deletion alone.
   */
  readonly includeTrash?: boolean;
}

/**
 * The JSON the rule needs, already read. Stated rather than opened, so every rule below is
 * testable without a filesystem — the same seam `resolveCapturedAt` uses.
 */
export interface AlbumInputs {
  /** `metadata.json` per album folder path. A folder absent here has none. */
  readonly albumMetadata: ReadonlyMap<string, AlbumMetadata>;
  /** Sidecar flags per media {@link TakeoutFile.sourcePath}. Absent means no sidecar was read. */
  readonly sidecarFlags: ReadonlyMap<string, SidecarFlags>;
}

/** Nothing was read for this file, which is not the same as it having said no. */
const NO_FLAGS: SidecarFlags = { archived: false, inTrash: false, problems: [] };

/**
 * Reconstructs an export's albums, membership, and flags.
 *
 * Pure and synchronous. Folders arrive from traversal already merged across parts and sorted by
 * path, so the result is deterministic and independent of how Takeout split the export — which is
 * what makes the ids stable, since a re-download that splits differently produces the same
 * folders.
 */
export function reconstructAlbums(
  exportSet: TakeoutExport,
  inputs: AlbumInputs,
  options: AlbumOptions = {},
): AlbumReconstruction {
  const includeTrash = options.includeTrash ?? false;

  const folders: FolderClassification[] = [];
  const albums: TakeoutAlbum[] = [];
  const media: MediaDisposition[] = [];
  /** Members accumulated per album id as the folders are walked, in folder order. */
  const membersByAlbumId = new Map<string, string[]>();

  for (const folder of exportSet.folders) {
    const metadata = inputs.albumMetadata.get(folder.path);
    const role = folderRoleOf(folder.name, folder.albumMetadata !== null);
    const isAlbum = role === FolderRole.Album;
    const albumId = isAlbum ? takeoutAlbumId(folder.path) : null;

    // The title comes from metadata.json, never from the folder name — the corpus's
    // `Familienurlaub 2020` says so explicitly, and it is an album whose folder name and title
    // happen to match, so a reader that returns the folder name passes it by accident. The
    // fallback exists only for a metadata.json that is unreadable or has no usable title, since
    // refusing the album would lose its membership.
    const metadataTitle = metadata?.title ?? null;
    const title = metadataTitle ?? folder.name;

    if (albumId !== null) {
      const album: TakeoutAlbum = {
        id: albumId,
        folderPath: folder.path,
        title,
        titleFromMetadata: metadataTitle !== null,
        albumDate: metadata?.albumDate?.epochMs ?? null,
        parts: folder.parts,
        // Filled in below, once every member's disposition is known.
        memberSourcePaths: [],
        problems:
          metadata === undefined
            ? [`${folder.path}/metadata.json was not read, so the folder name is the title`]
            : metadata.problems,
      };
      albums.push(album);
      membersByAlbumId.set(albumId, []);
    }

    folders.push({
      path: folder.path,
      name: folder.name,
      role,
      isAlbum,
      albumId,
      albumTitle: isAlbum ? title : null,
      yearBucket: yearBucketOf(folder.name),
      parts: folder.parts,
    });

    for (const file of folder.media) {
      const disposition = dispose(file, folder, role, albumId, title, inputs, includeTrash);
      media.push(disposition);
      if (disposition.imported && albumId !== null) {
        membersByAlbumId.get(albumId)?.push(file.sourcePath);
      }
    }
  }

  const withMembers = albums
    .map((album): TakeoutAlbum => ({
      ...album,
      memberSourcePaths: membersByAlbumId.get(album.id) ?? [],
    }))
    .sort((a, b) => compareStrings(a.folderPath, b.folderPath));

  return {
    albums: withMembers,
    albumById: new Map(withMembers.map((album) => [album.id, album])),
    folders,
    folderByPath: new Map(folders.map((folder) => [folder.path, folder])),
    media,
    dispositionBySourcePath: new Map(media.map((entry) => [entry.sourcePath, entry])),
    skipped: media.filter((entry) => !entry.imported),
  };
}

/**
 * One media file's flags, album membership, and whether it is imported at all.
 *
 * The flags are the union of what the folder says and what the sidecar says, with both recorded;
 * see this module's header for why the folder alone is not enough.
 */
function dispose(
  file: TakeoutFile,
  folder: TakeoutFolder,
  role: FolderRole,
  albumId: string | null,
  albumTitle: string,
  inputs: AlbumInputs,
  includeTrash: boolean,
): MediaDisposition {
  const flags = inputs.sidecarFlags.get(file.sourcePath) ?? NO_FLAGS;

  const archivedBy: FlagSource[] = [];
  if (role === FolderRole.Archive) archivedBy.push(FlagSource.Folder);
  if (flags.archived) archivedBy.push(FlagSource.Sidecar);

  const inTrashBy: FlagSource[] = [];
  if (role === FolderRole.Trash) inTrashBy.push(FlagSource.Folder);
  if (flags.inTrash) inTrashBy.push(FlagSource.Sidecar);

  const inTrash = inTrashBy.length > 0;
  const imported = includeTrash || !inTrash;

  return {
    sourcePath: file.sourcePath,
    folderPath: folder.path,
    folderRole: role,
    albumIds: albumId !== null && imported ? [albumId] : [],
    albumTitles: albumId !== null && imported ? [albumTitle] : [],
    archived: archivedBy.length > 0,
    archivedBy,
    inTrash,
    inTrashBy,
    imported,
    skipReason: imported
      ? null
      : `Google put this file in the trash (${inTrashBy.join(' and ')}) and Trash was not ` +
        'opted into, so it is not imported. Re-run with Trash included to keep it.',
  };
}

// ---------------------------------------------------------------------------
// Reading the JSON off disk
// ---------------------------------------------------------------------------

/** Seams for the two readers, so a test can state inputs instead of materializing an export. */
export interface ReconstructAlbumsOptions extends AlbumOptions {
  /**
   * What pairing concluded, which is how a media file reaches its sidecar's flags. Omitted, the
   * flags come from folder names alone — which finds `Archive/` and `Trash/` but not an item
   * archived in place, so ordinary callers pass it.
   */
  readonly pairing?: PairingResult;
  /** Defaults to {@link readAlbumMetadata}. */
  readonly readAlbumMetadata?: AlbumMetadataReader;
  /** Defaults to {@link readSidecarFlags}. */
  readonly readSidecarFlags?: SidecarFlagsReader;
}

/**
 * Reconstructs an export's albums, reading every `metadata.json` and every paired sidecar.
 *
 * Sidecars are read once each and shared by the files that paired with them — a Live Photo's still
 * and its motion component pair with one sidecar, and they must be flagged alike or half a Live
 * Photo would be left in the trash.
 *
 * Sequential on purpose, as in `timestamps.ts`: concurrency and resumption belong to the job
 * queue's `ExtractMeta` stage (task 2.11), and a bare `Promise.all` over a 500k-item export would
 * open 500k file handles.
 */
export async function reconstructExportAlbums(
  exportSet: TakeoutExport,
  options: ReconstructAlbumsOptions = {},
): Promise<AlbumReconstruction> {
  const readMetadata = options.readAlbumMetadata ?? readAlbumMetadata;
  const readFlags = options.readSidecarFlags ?? readSidecarFlags;

  const albumMetadata = new Map<string, AlbumMetadata>();
  for (const folder of exportSet.folders) {
    const file = folder.albumMetadata;
    // Read for every folder that has one, including a `Photos from YYYY` that should not: the rule
    // ignores it, and the report is better off knowing the file was there.
    if (file !== null) albumMetadata.set(folder.path, await readMetadata(file.absolutePath));
  }

  const sidecarFlags = new Map<string, SidecarFlags>();
  const byAbsolutePath = new Map<string, SidecarFlags>();
  for (const pairing of options.pairing?.pairings ?? []) {
    const absolutePath = pairing.sidecar.absolutePath;
    let flags = byAbsolutePath.get(absolutePath);
    if (flags === undefined) {
      flags = await readFlags(absolutePath);
      byAbsolutePath.set(absolutePath, flags);
    }
    sidecarFlags.set(pairing.media.sourcePath, flags);
  }

  return reconstructAlbums(exportSet, { albumMetadata, sidecarFlags }, options);
}

// ---------------------------------------------------------------------------
// Turning albums into rows
// ---------------------------------------------------------------------------

export interface AlbumRecordOptions {
  /** Epoch milliseconds for `updated_at`. Injected so a test needs no clock. */
  readonly now?: number;
}

/**
 * The `albums` rows for a reconstruction, in {@link AlbumReconstruction.albums} order.
 *
 * `createdAt` is the album's own `date` from `metadata.json`, which is the only creation-time-like
 * value Takeout offers, and null when it offered none — never the import time, which would claim
 * every album was created the day it was imported. `updatedAt` *is* the import time, because that
 * is when this row was written and it is what per-field last-writer-wins compares. `version` is 0
 * until the sync relay assigns one.
 */
export function albumRecordsOf(
  reconstruction: AlbumReconstruction,
  options: AlbumRecordOptions = {},
): readonly AlbumRecord[] {
  const now = options.now ?? Date.now();
  return reconstruction.albums.map((album) => ({
    id: album.id,
    title: album.title,
    createdAt: album.albumDate,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  }));
}

// ---------------------------------------------------------------------------
// Turning membership into rows, once hashes exist
// ---------------------------------------------------------------------------

/** One `album_members` row. Carries a reference and nothing else (Requirement 3.5). */
export interface AlbumMemberRow {
  readonly albumId: string;
  readonly hash: string;
  /** `album_members.position`. Gapless within an album, in folder order. */
  readonly position: number;
}

/** A member that could not become a row, and why. One line in the reconciliation report. */
export interface UnresolvedAlbumMember {
  readonly albumId: string;
  readonly sourcePath: string;
  readonly reason: string;
}

/** Two members of one album that turned out to be the same asset, so one row was written. */
export interface DuplicateAlbumMember {
  readonly albumId: string;
  readonly hash: string;
  /** The member that was collapsed. */
  readonly sourcePath: string;
  /** The member already holding the row, which keeps its position. */
  readonly keptSourcePath: string;
}

/** `album_members` rows, plus the membership that did not survive into one. */
export interface ResolvedAlbumMembers {
  readonly members: readonly AlbumMemberRow[];
  readonly unresolved: readonly UnresolvedAlbumMember[];
  readonly duplicates: readonly DuplicateAlbumMember[];
}

/**
 * Resolves membership to `album_members` rows, which is the step this module cannot do itself.
 *
 * Pure and synchronous: the caller supplies the lookup, so the rules are testable with stated
 * hashes now and reusable by task 2.11 with `DedupeLedger.hashOf` behind them.
 *
 * The same asset in several albums produces one row per album and no second copy of anything,
 * which is Requirement 3.5. The two ways a member fails to become a row — no hash yet, or
 * deduplicated into a member that already has a row — are reported rather than dropped; see this
 * module's header.
 */
export function resolveAlbumMembers(
  reconstruction: AlbumReconstruction,
  hashOf: ContentHashLookup,
): ResolvedAlbumMembers {
  const members: AlbumMemberRow[] = [];
  const unresolved: UnresolvedAlbumMember[] = [];
  const duplicates: DuplicateAlbumMember[] = [];

  for (const album of reconstruction.albums) {
    /** Hashes already given a row in this album, and the member that got it. */
    const placed = new Map<string, string>();

    for (const sourcePath of album.memberSourcePaths) {
      const hash = hashOf(sourcePath) ?? null;
      if (hash === null) {
        unresolved.push({
          albumId: album.id,
          sourcePath,
          reason:
            `${sourcePath} has no content hash, so its membership of ${JSON.stringify(album.title)} ` +
            'cannot be recorded',
        });
        continue;
      }

      const keptSourcePath = placed.get(hash);
      if (keptSourcePath !== undefined) {
        duplicates.push({ albumId: album.id, hash, sourcePath, keptSourcePath });
        continue;
      }

      placed.set(hash, sourcePath);
      members.push({ albumId: album.id, hash, position: placed.size - 1 });
    }
  }

  return { members, unresolved, duplicates };
}
