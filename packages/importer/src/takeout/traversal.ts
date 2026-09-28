/**
 * Multi-archive traversal: several Takeout parts read as one logical export (task 2.2,
 * Requirement 1.1).
 *
 * This is the first half of `TakeoutReader` (design: Importer components). It walks the parts,
 * classifies every file it finds, and hands pairing a **merged per-folder view**. It does not
 * pair sidecars, resolve timestamps, link variants, or decide what an album is — those are
 * tasks 2.3 to 2.6, and they all consume the output of this module.
 *
 * ## Why merging has to happen here, before anything else
 *
 * Takeout splits an export on size alone and has no idea what belongs with what, so an asset's
 * bytes and its sidecar routinely land in different zips. `corpus.ts` has a fixture for exactly
 * this — `cross-part-sidecar`, media in part 003 and sidecar in part 002 — and the reason it is
 * worth a fixture is the shape of the failure: import part 003 on its own and the photo is
 * unpaired with a 2024 timestamp, which reads as a pairing bug and is a traversal bug.
 *
 * So pairing cannot be run per part and then unioned. It has to run against a folder whose
 * filenames are already merged, which is what {@link TakeoutFolder.sidecarNames} is for.
 *
 * ## Paths are relative to the logical export, not to a part
 *
 * `TakeoutSource` in `@photo-archive/core` already fixes the contract: a path relative to the
 * root of the *logical* export, `/`-separated, so a multi-part set yields one flat namespace and
 * the same file cannot be counted once per part. Every part expands to its own
 * `Takeout/Google Photos` prefix, so that prefix is found and stripped per part rather than
 * assumed — see {@link findExportRoot}.
 *
 * ## Overlapping paths, and the one genuinely ambiguous case
 *
 * A path present in more than one part is normally the same file: Google repeated it, and
 * counting it twice would inflate every number in the reconciliation report and hash the same
 * bytes twice. Those are deduplicated, first part in the supplied order winning, and recorded in
 * {@link TakeoutExport.duplicates}.
 *
 * A path present in more than one part with **different byte sizes** is a different matter, and
 * it is a real Takeout situation — a partially downloaded part, or two distinct photos that both
 * ended up as `IMG_0001.jpg` in the same folder in different archives. Silently keeping one
 * would destroy the other, permanently and invisibly, so this module refuses to choose:
 *
 * - every copy is kept and reaches the pipeline, so no bytes are dropped;
 * - the first copy keeps the logical path as its {@link TakeoutFile.sourcePath}, and each later
 *   copy is qualified with its part name, because when the logical namespace is genuinely
 *   ambiguous a path relative to the logical export cannot identify a file;
 * - the collision is recorded in {@link TakeoutExport.conflicts} for the reconciliation report
 *   (task 2.12), because the user is entitled to know their export contradicts itself.
 *
 * Byte size is the discriminator rather than a digest **on purpose**. Traversal is a directory
 * walk over an export that may be 2 TB; reading every file here to compare content would double
 * the I/O of the whole import and duplicate the `Hash` stage. Size comes free with the `stat`
 * already needed for mtime, and a size difference proves a content difference. Equal size does
 * not prove equal content, so equal-size copies at one path are treated as the same file — with
 * content addressing and `DedupeLedger` as the backstop, since two files that differ hash
 * differently and become two assets regardless of what traversal concluded.
 *
 * ## Non-media files are classified, not skipped
 *
 * Skipping everything that is not media would throw away the sidecars task 2.3 pairs and the
 * `metadata.json` task 2.6 reconstructs albums from. Everything found gets a
 * {@link TakeoutFileKind}, including Google's own furniture (`archive_browser.html`,
 * `print-subscriptions.json`) and stray OS junk, so that "not imported" always comes with a
 * reason rather than a silence (Requirement 1.10).
 *
 * ## Unicode
 *
 * Every logical path and filename is NFC-normalized, because `IMG_3002-modifié.jpg` has two
 * encodings and which one a directory listing returns is a property of the filesystem rather
 * than of the export. A suffix table or a sidecar probe matched against the other form silently
 * stops matching. {@link TakeoutFile.absolutePath} keeps the filesystem's own bytes and is the
 * only field safe to open, since normalizing a name that is stored decomposed produces a path
 * that does not exist on Linux.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { AssetKind } from '@photo-archive/core';
import type { TakeoutSource } from '@photo-archive/core';

// ---------------------------------------------------------------------------
// Names Takeout uses
// ---------------------------------------------------------------------------

/** The filename whose presence makes a folder an album (design: Takeout metadata repair). */
export const ALBUM_METADATA_FILE = 'metadata.json';

/** The directory every Takeout zip expands to, inside which the per-product folders sit. */
export const TAKEOUT_DIR_NAME = 'Takeout';

/** Google's HTML index of the export. Present once per part, above the product folder. */
export const ARCHIVE_BROWSER_FILE = 'archive_browser.html';

/**
 * Account-level JSON that Google Photos writes beside the folders. These end in `.json` and are
 * emphatically not sidecars: treating them as such would offer pairing a metadata file with no
 * media, and step 4 of the resolution order matches on basename alone.
 */
const ACCOUNT_METADATA_FILES: ReadonlySet<string> = new Set([
  'print-subscriptions.json',
  'shared_album_comments.json',
  'user-generated-memory-titles.json',
]);

/**
 * Extensions treated as still images. Lowercased, no dot.
 *
 * The list is what Google Photos actually stores rather than everything decodable, because an
 * extension absent here is reported as {@link TakeoutFileKind.Unknown} and looked at, which is
 * the failure mode to prefer over importing an unexpected file as if it were a photo.
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'heic',
  'heif',
  'png',
  'gif',
  'webp',
  'tif',
  'tiff',
  'bmp',
  'dng',
]);

/** Extensions treated as video. Lowercased, no dot. */
const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4',
  'mov',
  'm4v',
  'avi',
  'mkv',
  '3gp',
  'mpg',
  'mpeg',
  'wmv',
  'webm',
]);

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * What a file found in an export is.
 *
 * Strings rather than the numeric `const` objects in `states.ts` because none of this is
 * persisted: a traversal result lives for the duration of an import run, and the durable form of
 * anything here is an `assets` row or a line in the reconciliation report.
 */
export const TakeoutFileKind = {
  /** Media bytes. The only kind that becomes an asset. */
  Media: 'media',
  /** A per-media JSON sidecar. Task 2.3's input. */
  Sidecar: 'sidecar',
  /** `metadata.json`. Task 2.6's input, and what makes its folder an album. */
  AlbumMetadata: 'album-metadata',
  /** `archive_browser.html`. Google's own index of the export. */
  ArchiveBrowser: 'archive-browser',
  /** Account-level JSON beside the folders: print subscriptions, memory titles, comments. */
  AccountMetadata: 'account-metadata',
  /** Anything else: OS junk, unknown extensions, entries that are neither file nor directory. */
  Unknown: 'unknown',
} as const;
export type TakeoutFileKind = (typeof TakeoutFileKind)[keyof typeof TakeoutFileKind];

/** Kinds that carry no asset and no metadata, and are reported rather than imported. */
const IGNORED_KINDS: ReadonlySet<TakeoutFileKind> = new Set([
  TakeoutFileKind.ArchiveBrowser,
  TakeoutFileKind.AccountMetadata,
  TakeoutFileKind.Unknown,
]);

/** The asset kinds traversal can decide from a filename alone. */
export type TraversalMediaKind = typeof AssetKind.Image | typeof AssetKind.Video;

/** Lowercased extension without the dot, or `''` when the name has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function nfc(value: string): string {
  return value.normalize('NFC');
}

/**
 * What one filename is, decided on the name alone.
 *
 * `MotionComponent` never appears: the MOV half of a Live Photo is indistinguishable from an
 * ordinary video until a same-stem still is known to exist, which is a fact about the merged
 * folder rather than about the file, and task 2.5 owns it.
 */
export function classifyFileName(fileName: string): {
  kind: TakeoutFileKind;
  mediaKind: TraversalMediaKind | null;
} {
  const lower = nfc(fileName).toLowerCase();

  if (lower === ALBUM_METADATA_FILE)
    return { kind: TakeoutFileKind.AlbumMetadata, mediaKind: null };
  if (lower === ARCHIVE_BROWSER_FILE) {
    return { kind: TakeoutFileKind.ArchiveBrowser, mediaKind: null };
  }
  if (ACCOUNT_METADATA_FILES.has(lower)) {
    return { kind: TakeoutFileKind.AccountMetadata, mediaKind: null };
  }

  const extension = extensionOf(lower);
  if (extension === 'json') return { kind: TakeoutFileKind.Sidecar, mediaKind: null };
  if (IMAGE_EXTENSIONS.has(extension)) {
    return { kind: TakeoutFileKind.Media, mediaKind: AssetKind.Image };
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return { kind: TakeoutFileKind.Media, mediaKind: AssetKind.Video };
  }
  return { kind: TakeoutFileKind.Unknown, mediaKind: null };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** One file found in one part. */
export interface TakeoutFile {
  /**
   * Path relative to the root of the logical export, `/`-separated and NFC-normalized. The
   * `Takeout/Google Photos` prefix and the part directory are both gone, which is what makes
   * this comparable across parts.
   *
   * For a file above the export root — `Takeout/archive_browser.html` — this is relative to the
   * part root instead, since no path relative to the export root could reach it.
   */
  readonly path: string;
  /** Directory portion of {@link path}. `''` at the export root. */
  readonly dir: string;
  /** Filename portion of {@link path}, NFC-normalized. */
  readonly name: string;
  readonly kind: TakeoutFileKind;
  /** Set exactly when {@link kind} is {@link TakeoutFileKind.Media}. */
  readonly mediaKind: TraversalMediaKind | null;
  /** Name of the part directory the bytes were read from. */
  readonly part: string;
  /**
   * Absolute path on disk, carrying the filesystem's own Unicode normalization. **The only
   * field safe to open**: {@link path} and {@link name} are normalized for comparison and may
   * not exist under that spelling.
   */
  readonly absolutePath: string;
  readonly byteSize: number;
  readonly mtimeMs: number;
  /** True for files above the export root, which belong to no folder in the merged view. */
  readonly outsideExport: boolean;
  /**
   * The identity this file carries into {@link TakeoutSource}, and so into dedupe bookkeeping
   * and the reconciliation report.
   *
   * Equal to {@link path} in every ordinary case. It is qualified with the part name only when
   * the logical namespace is genuinely ambiguous — a path claimed by copies of differing size in
   * two parts, or a file above the export root — because a path relative to the logical export
   * then does not identify one file, and letting two distinct files share one source reference
   * is precisely the mistake dedupe bookkeeping cannot notice.
   */
  readonly sourcePath: string;
}

/**
 * One logical folder, merged across every part it appears in.
 *
 * This is the unit tasks 2.3 to 2.6 work in: pairing probes {@link sidecarNames}, the
 * unique-basename fallback counts matches within it, and album reconstruction reads
 * {@link albumMetadata} and takes membership from {@link media}.
 */
export interface TakeoutFolder {
  /** Path relative to the export root, `/`-separated and NFC. `''` is the export root itself. */
  readonly path: string;
  /** Last segment of {@link path}. `''` for the export root. */
  readonly name: string;
  /** Parts this folder has a directory in, in the order the parts were supplied. */
  readonly parts: readonly string[];
  /** Media files, deduplicated across parts, sorted by name. */
  readonly media: readonly TakeoutFile[];
  /** Sidecars, deduplicated across parts, sorted by name. */
  readonly sidecars: readonly TakeoutFile[];
  /** `metadata.json`, from the first part that has one. `null` when the folder is not an album. */
  readonly albumMetadata: TakeoutFile | null;
  /** Everything found here that is neither media nor metadata. Reported, never imported. */
  readonly ignored: readonly TakeoutFile[];
  /** Every filename in this folder, merged across parts, NFC, sorted. */
  readonly fileNames: readonly string[];
  /**
   * Sidecar filenames only, merged across parts, NFC, sorted. Exactly the set the four-step
   * resolution order probes against, and the reason it is merged rather than per-part.
   */
  readonly sidecarNames: readonly string[];
}

/** One archive part, and where its export root turned out to be. */
export interface TakeoutPart {
  /** Directory name, e.g. `takeout-20240115T101530Z-001`. Unique within one traversal. */
  readonly name: string;
  /** Absolute path to the part directory. */
  readonly root: string;
  /** Absolute path to this part's export root, usually `{root}/Takeout/Google Photos`. */
  readonly exportRoot: string;
  /** Files found in this part, of every kind, before cross-part deduplication. */
  readonly fileCount: number;
}

/** One logical path held by several parts with identical size, deduplicated to one file. */
export interface DuplicatePath {
  readonly path: string;
  /** The part whose copy was kept: the earliest in the supplied order. */
  readonly keptPart: string;
  /** Parts whose copies were dropped as redundant. */
  readonly droppedParts: readonly string[];
  readonly byteSize: number;
}

/** One copy of a conflicting path. */
export interface ConflictingCopy {
  readonly part: string;
  readonly byteSize: number;
  /** {@link TakeoutFile.sourcePath} this copy was given, which is unique across the conflict. */
  readonly sourcePath: string;
}

/**
 * One logical path held by several parts with **differing** sizes, so the copies cannot be the
 * same file. Every copy is kept; see this module's header for why nothing is chosen here.
 */
export interface PathConflict {
  readonly path: string;
  /** Two or more copies, in part order, one per distinct size. */
  readonly copies: readonly ConflictingCopy[];
}

/** Several archive parts read as one logical export. */
export interface TakeoutExport {
  /** The parts, in the order supplied, which is the order that breaks duplicate ties. */
  readonly parts: readonly TakeoutPart[];
  /** Every logical folder, merged across parts, sorted by path. Includes the export root. */
  readonly folders: readonly TakeoutFolder[];
  /** {@link folders} keyed by {@link TakeoutFolder.path}. */
  readonly folderByPath: ReadonlyMap<string, TakeoutFolder>;
  /** Every retained file of every kind, sorted by path then part. */
  readonly files: readonly TakeoutFile[];
  /** The subset of {@link files} that is media. */
  readonly media: readonly TakeoutFile[];
  /** The subset of {@link files} that is sidecars. */
  readonly sidecars: readonly TakeoutFile[];
  /** The subset of {@link files} carrying no asset and no metadata, with its kind as the reason. */
  readonly ignored: readonly TakeoutFile[];
  /** Paths that appeared in several parts and were collapsed, sorted by path. */
  readonly duplicates: readonly DuplicatePath[];
  /** Paths whose copies contradict each other. Nothing was dropped; nothing was chosen. */
  readonly conflicts: readonly PathConflict[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Traversal cannot proceed: the parts supplied do not describe a readable export. */
export class TakeoutTraversalError extends Error {
  override readonly name = 'TakeoutTraversalError';
}

// ---------------------------------------------------------------------------
// Locating the export root inside a part
// ---------------------------------------------------------------------------

/**
 * How every localization of the Photos product folder begins, lowercased — `Google Photos`,
 * `Google Fotos`, `Google Fotky`. A prefix rather than a table of locale names, because a table
 * would be a list of guesses that silently stops matching for the locale nobody tested.
 */
const PRODUCT_FOLDER_PREFIX = 'google ';

export interface FindExportRootOptions {
  /**
   * The product folder to descend into, when a part holds several — an export covering Photos
   * and Drive at once. Matched NFC-normalized and case-insensitively. Without it, a part with
   * more than one candidate is an error rather than a guess.
   */
  readonly productFolderName?: string;
}

async function readDirectoryNames(dir: string): Promise<readonly string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/**
 * The directory within `partRoot` that the logical export's paths are relative to.
 *
 * A Takeout zip expands to `Takeout/<product folder>/...`, so that prefix repeats in every part
 * and has to be looked through rather than treated as part of a path — otherwise every path
 * would carry a prefix that is identical across parts and the merge would still work, but the
 * paths would not match `TakeoutSource`'s contract and a re-exported set with a different prefix
 * would not deduplicate against the first.
 *
 * Resolution: descend into `Takeout` if it exists, then into the named product folder if the
 * caller gave one, then into the only child directory if there is exactly one, then into the only
 * `Google …` directory if there is exactly one. A part with several candidates and no instruction
 * fails loudly, because picking one would silently import a fraction of the export.
 *
 * A part with no `Takeout` directory is taken to already be an export root, which is what a
 * caller pointing straight at a `Google Photos` folder means.
 */
export async function findExportRoot(
  partRoot: string,
  options: FindExportRootOptions = {},
): Promise<string> {
  const topLevel = await readDirectoryNames(partRoot);
  const takeoutDir = topLevel.find(
    (name) => nfc(name).toLowerCase() === TAKEOUT_DIR_NAME.toLowerCase(),
  );

  const requested = options.productFolderName;
  const base = takeoutDir === undefined ? partRoot : path.join(partRoot, takeoutDir);
  const children = takeoutDir === undefined ? topLevel : await readDirectoryNames(base);

  if (requested !== undefined) {
    const wanted = nfc(requested).toLowerCase();
    const match = children.find((name) => nfc(name).toLowerCase() === wanted);
    if (match === undefined) {
      throw new TakeoutTraversalError(
        `${partRoot} has no ${JSON.stringify(requested)} folder under ` +
          `${path.relative(partRoot, base) || '.'}; it holds ${describeNames(children)}`,
      );
    }
    return path.join(base, match);
  }

  // No `Takeout` directory: the caller pointed at an export root, or at a product folder.
  if (takeoutDir === undefined) return partRoot;

  if (children.length === 1) return path.join(base, children[0] as string);

  const candidates = children.filter((name) =>
    nfc(name).toLowerCase().startsWith(PRODUCT_FOLDER_PREFIX),
  );
  if (candidates.length === 1) return path.join(base, candidates[0] as string);

  throw new TakeoutTraversalError(
    children.length === 0
      ? `${partRoot} has a ${TAKEOUT_DIR_NAME} directory with no product folder in it, so there ` +
          'is nothing to import from this part'
      : `${partRoot} holds several product folders — ${describeNames(children)} — so the export ` +
          'root is ambiguous. Pass productFolderName to say which one to import, rather than ' +
          'having a fraction of the export chosen silently.',
  );
}

function describeNames(names: readonly string[]): string {
  return names.length === 0 ? 'nothing' : names.map((name) => JSON.stringify(name)).join(', ');
}

// ---------------------------------------------------------------------------
// Part discovery
// ---------------------------------------------------------------------------

/** A directory name Google gives an expanded part, e.g. `takeout-20240115T101530Z-001`. */
const PART_DIR_PATTERN = /^takeout[-_]/iu;
/** The numeric suffix parts are numbered with, which is what they must be ordered by. */
const PART_NUMBER_PATTERN = /(\d+)\s*$/u;

/**
 * The Takeout parts inside `directory`, in numbered order.
 *
 * This is what "without requiring manual concatenation" means in practice (Requirement 1.1): the
 * user points at the folder they unzipped into and the parts are found, rather than being listed
 * by hand in the right order — and the order matters, because it is what breaks duplicate ties.
 *
 * A child directory qualifies if its name looks like a part, or if it contains a `Takeout`
 * directory. The second test is what makes renamed parts work, which is common: people rename
 * `takeout-…-001` to something they can read.
 *
 * @throws {TakeoutTraversalError} if nothing in `directory` looks like a part.
 */
export async function discoverParts(directory: string): Promise<readonly string[]> {
  const absolute = path.resolve(directory);
  const names = await readDirectoryNames(absolute).catch((cause: unknown): never => {
    throw new TakeoutTraversalError(
      `cannot read ${absolute} to look for Takeout parts: ${describeCause(cause)}`,
    );
  });

  const parts: string[] = [];
  for (const name of names) {
    if (PART_DIR_PATTERN.test(nfc(name))) {
      parts.push(name);
      continue;
    }
    const children = await readDirectoryNames(path.join(absolute, name)).catch(
      (): readonly string[] => [],
    );
    if (children.some((child) => nfc(child).toLowerCase() === TAKEOUT_DIR_NAME.toLowerCase())) {
      parts.push(name);
    }
  }

  if (parts.length === 0) {
    throw new TakeoutTraversalError(
      `${absolute} holds no Takeout parts: no child directory is named takeout-… or contains a ` +
        `${TAKEOUT_DIR_NAME} directory. Point at the directory the archives were unzipped into, ` +
        'or pass the part directories explicitly.',
    );
  }

  parts.sort(comparePartNames);
  return parts.map((name) => path.join(absolute, name));
}

/**
 * Orders parts by their trailing number, so `…-002` precedes `…-010`. Lexical order would put
 * `-010` first, which would silently invert duplicate precedence.
 */
function comparePartNames(a: string, b: string): number {
  const numberA = PART_NUMBER_PATTERN.exec(a)?.[1];
  const numberB = PART_NUMBER_PATTERN.exec(b)?.[1];
  if (numberA !== undefined && numberB !== undefined && numberA !== numberB) {
    return Number(numberA) - Number(numberB);
  }
  return compareStrings(a, b);
}

/** Codepoint order. `localeCompare` would make traversal output depend on the machine's ICU. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

export interface TraverseOptions extends FindExportRootOptions {
  /**
   * Export root for each part, bypassing {@link findExportRoot}. Absolute, or relative to the
   * part. Escape hatch for an export shape this module has not seen; ordinary callers pass
   * nothing.
   */
  readonly exportRoots?: readonly string[];
}

interface ScannedEntry {
  readonly absolutePath: string;
  readonly isFile: boolean;
}

interface PartScan {
  readonly directories: readonly string[];
  readonly entries: readonly ScannedEntry[];
}

/**
 * Every directory and non-directory entry under `root`, breadth-first.
 *
 * Symlinks are recorded but never followed. A Takeout expansion contains none, and following
 * them would let a cycle hang the walk and let a link escape the part and pull in paths that are
 * not part of the export at all.
 */
async function scanTree(root: string): Promise<PartScan> {
  const directories: string[] = [root];
  const entries: ScannedEntry[] = [];
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift();
    if (dir === undefined) break;

    const listing = await fs
      .readdir(dir, { withFileTypes: true })
      .catch((cause: unknown): never => {
        throw new TakeoutTraversalError(`cannot read ${dir}: ${describeCause(cause)}`);
      });

    for (const entry of listing) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(absolutePath);
        queue.push(absolutePath);
      } else {
        entries.push({ absolutePath, isFile: entry.isFile() });
      }
    }
  }

  return { directories, entries };
}

/** `path.relative`, plus whether it left `from` behind. */
function relativeWithin(from: string, to: string): { relative: string; outside: boolean } {
  const relative = path.relative(from, to);
  const outside =
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return { relative, outside };
}

/** A native path as a logical one: `/`-separated and NFC. */
function toLogicalPath(relative: string): string {
  return nfc(relative.split(path.sep).join('/'));
}

/** A file as traversal found it, before cross-part deduplication has had a say. */
interface Candidate extends Omit<TakeoutFile, 'sourcePath'> {
  readonly partIndex: number;
}

async function scanPart(
  partRoot: string,
  partName: string,
  partIndex: number,
  options: TraverseOptions,
): Promise<{
  part: TakeoutPart;
  candidates: readonly Candidate[];
  directories: readonly string[];
}> {
  const override = options.exportRoots?.[partIndex];
  const exportRoot =
    override === undefined
      ? await findExportRoot(partRoot, options)
      : path.resolve(partRoot, override);

  const scan = await scanTree(partRoot);
  const candidates: Candidate[] = [];

  for (const entry of scan.entries) {
    const within = relativeWithin(exportRoot, entry.absolutePath);
    const outsideExport = within.outside;
    const logical = toLogicalPath(
      outsideExport ? relativeWithin(partRoot, entry.absolutePath).relative : within.relative,
    );
    const name = logical.slice(logical.lastIndexOf('/') + 1);
    const dir = logical.includes('/') ? logical.slice(0, logical.lastIndexOf('/')) : '';

    // Neither a file nor a directory — a symlink, a socket, a device node. Reported as junk
    // rather than stat'ed through, since stat on a broken link throws and a stray node in an
    // export is a thing to look at, not a thing to import.
    const classified = entry.isFile
      ? classifyFileName(name)
      : { kind: TakeoutFileKind.Unknown, mediaKind: null };

    let byteSize = 0;
    let mtimeMs = 0;
    if (entry.isFile) {
      const stat = await fs.stat(entry.absolutePath);
      byteSize = stat.size;
      mtimeMs = stat.mtimeMs;
    }

    candidates.push({
      path: logical,
      dir,
      name,
      kind: classified.kind,
      mediaKind: classified.mediaKind,
      part: partName,
      absolutePath: entry.absolutePath,
      byteSize,
      mtimeMs,
      outsideExport,
      partIndex,
    });
  }

  // Directories above the export root — the part root itself, and `Takeout` — are not folders of
  // the logical export and must not become empty entries in the merged view.
  const directories: string[] = [];
  for (const directory of scan.directories) {
    const within = relativeWithin(exportRoot, directory);
    if (within.outside) continue;
    directories.push(toLogicalPath(within.relative));
  }

  return {
    part: { name: partName, root: partRoot, exportRoot, fileCount: scan.entries.length },
    candidates,
    directories,
  };
}

/**
 * Walks several archive parts as one logical export.
 *
 * Parts are supplied in precedence order — {@link discoverParts} produces that order — and the
 * order is load-bearing: it decides which copy of a repeated path is kept, and which copy keeps
 * the unqualified source path when copies conflict.
 *
 * @throws {TakeoutTraversalError} if no parts are given, if two parts have the same directory
 *   name, if a part is missing or is not a directory, or if a part's export root cannot be
 *   identified.
 */
export async function traverseExport(
  partRoots: readonly string[],
  options: TraverseOptions = {},
): Promise<TakeoutExport> {
  if (partRoots.length === 0) {
    throw new TakeoutTraversalError(
      'no archive parts supplied. A Takeout export is one or more part directories read as one ' +
        'logical export; use discoverParts() to find them under a download directory.',
    );
  }

  const resolved = partRoots.map((root) => path.resolve(root));
  const partNames = resolved.map((root) => path.basename(root));

  const seenNames = new Map<string, number>();
  for (const [index, name] of partNames.entries()) {
    const first = seenNames.get(name);
    if (first !== undefined) {
      throw new TakeoutTraversalError(
        `parts ${String(first + 1)} and ${String(index + 1)} are both named ${JSON.stringify(name)} ` +
          `(${resolved[first] ?? ''} and ${resolved[index] ?? ''}). Part names identify which ` +
          'archive a file came from, so two parts sharing one name would make an overlapping ' +
          'path impossible to attribute.',
      );
    }
    seenNames.set(name, index);
  }

  const parts: TakeoutPart[] = [];
  const candidates: Candidate[] = [];
  /** Logical directory path to the indices of the parts it appears in. */
  const partsByDirectory = new Map<string, Set<number>>();

  for (const [index, root] of resolved.entries()) {
    const stat = await fs.stat(root).catch((cause: unknown): never => {
      throw new TakeoutTraversalError(
        `archive part ${root} cannot be read: ${describeCause(cause)}`,
      );
    });
    if (!stat.isDirectory()) {
      throw new TakeoutTraversalError(
        `archive part ${root} is not a directory. Parts must be unzipped first; this module reads ` +
          'expanded archives, not zip files.',
      );
    }

    const scanned = await scanPart(root, partNames[index] as string, index, options);
    parts.push(scanned.part);
    candidates.push(...scanned.candidates);
    for (const directory of scanned.directories) {
      const set = partsByDirectory.get(directory) ?? new Set<number>();
      set.add(index);
      partsByDirectory.set(directory, set);
    }
  }

  const { files, duplicates, conflicts } = mergeCandidates(candidates);
  const folders = buildFolders(files, partsByDirectory, partNames);

  return {
    parts,
    folders,
    folderByPath: new Map(folders.map((folder) => [folder.path, folder])),
    files,
    media: files.filter((file) => file.kind === TakeoutFileKind.Media),
    sidecars: files.filter((file) => file.kind === TakeoutFileKind.Sidecar),
    ignored: files.filter((file) => IGNORED_KINDS.has(file.kind)),
    duplicates,
    conflicts,
  };
}

/**
 * Collapses copies of one logical path across parts into the files that survive, plus the record
 * of what was collapsed and what refused to collapse.
 *
 * Copies are grouped by byte size, in part order. One group means one file and the later copies
 * are redundant. More than one group means the parts disagree about what lives at this path, so
 * every group's first copy survives with a source path that names its part — see this module's
 * header.
 */
function mergeCandidates(candidates: readonly Candidate[]): {
  files: readonly TakeoutFile[];
  duplicates: readonly DuplicatePath[];
  conflicts: readonly PathConflict[];
} {
  const byPath = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    // A file above the export root has no logical path, so it is keyed by part as well: the same
    // `Takeout/archive_browser.html` exists in every part and they are not one file.
    const key = candidate.outsideExport ? `${candidate.part}/${candidate.path}` : candidate.path;
    const group = byPath.get(key) ?? [];
    group.push(candidate);
    byPath.set(key, group);
  }

  const files: TakeoutFile[] = [];
  const duplicates: DuplicatePath[] = [];
  const conflicts: PathConflict[] = [];

  for (const group of byPath.values()) {
    const ordered = [...group].sort((a, b) => a.partIndex - b.partIndex);

    /** First copy of each distinct size, in part order, plus the copies it subsumes. */
    const bySize = new Map<number, { keeper: Candidate; subsumed: Candidate[] }>();
    for (const candidate of ordered) {
      const existing = bySize.get(candidate.byteSize);
      if (existing === undefined) {
        bySize.set(candidate.byteSize, { keeper: candidate, subsumed: [] });
      } else {
        existing.subsumed.push(candidate);
      }
    }

    const groups = [...bySize.values()];
    const conflicting = groups.length > 1;

    for (const [groupIndex, { keeper, subsumed }] of groups.entries()) {
      // The first surviving copy keeps the logical path. Later ones cannot: two files that are
      // demonstrably different must not share one source reference.
      const qualify = keeper.outsideExport || (conflicting && groupIndex > 0);
      const { partIndex: _partIndex, ...file } = keeper;
      files.push({
        ...file,
        sourcePath: qualify ? `${keeper.part}/${keeper.path}` : keeper.path,
      });

      if (subsumed.length > 0) {
        duplicates.push({
          path: keeper.path,
          keptPart: keeper.part,
          droppedParts: subsumed.map((candidate) => candidate.part),
          byteSize: keeper.byteSize,
        });
      }
    }

    if (conflicting) {
      const first = groups[0]?.keeper;
      conflicts.push({
        path: first?.path ?? '',
        copies: groups.map(({ keeper }, groupIndex) => ({
          part: keeper.part,
          byteSize: keeper.byteSize,
          sourcePath:
            keeper.outsideExport || groupIndex > 0 ? `${keeper.part}/${keeper.path}` : keeper.path,
        })),
      });
    }
  }

  files.sort((a, b) => compareStrings(a.path, b.path) || compareStrings(a.part, b.part));
  duplicates.sort((a, b) => compareStrings(a.path, b.path));
  conflicts.sort((a, b) => compareStrings(a.path, b.path));

  return { files, duplicates, conflicts };
}

/** Groups the surviving files into per-folder views, merged across parts. */
function buildFolders(
  files: readonly TakeoutFile[],
  partsByDirectory: ReadonlyMap<string, Set<number>>,
  partNames: readonly string[],
): readonly TakeoutFolder[] {
  interface Accumulator {
    media: TakeoutFile[];
    sidecars: TakeoutFile[];
    albumMetadata: TakeoutFile | null;
    ignored: TakeoutFile[];
    names: Set<string>;
  }

  const accumulators = new Map<string, Accumulator>();
  const accumulatorFor = (dir: string): Accumulator => {
    const existing = accumulators.get(dir);
    if (existing !== undefined) return existing;
    const created: Accumulator = {
      media: [],
      sidecars: [],
      albumMetadata: null,
      ignored: [],
      names: new Set<string>(),
    };
    accumulators.set(dir, created);
    return created;
  };

  // Every directory found in any part gets a view, even an empty one: a folder that exists in
  // an export and holds nothing is a fact about the export, and dropping it would make the
  // merged view disagree with the tree.
  for (const directory of partsByDirectory.keys()) {
    accumulatorFor(directory);
  }

  for (const file of files) {
    if (file.outsideExport) continue;
    const accumulator = accumulatorFor(file.dir);
    accumulator.names.add(file.name);
    switch (file.kind) {
      case TakeoutFileKind.Media:
        accumulator.media.push(file);
        break;
      case TakeoutFileKind.Sidecar:
        accumulator.sidecars.push(file);
        break;
      case TakeoutFileKind.AlbumMetadata:
        // Every part of an album folder carries the same metadata.json; the first wins, and the
        // duplicate is already recorded in TakeoutExport.duplicates or conflicts.
        accumulator.albumMetadata ??= file;
        accumulator.names.add(file.name);
        break;
      default:
        accumulator.ignored.push(file);
        break;
    }
  }

  const byName = (a: TakeoutFile, b: TakeoutFile): number =>
    compareStrings(a.name, b.name) || compareStrings(a.part, b.part);

  const folders = [...accumulators.entries()].map(([dir, accumulator]): TakeoutFolder => {
    const partIndices = [...(partsByDirectory.get(dir) ?? new Set<number>())].sort((a, b) => a - b);
    return {
      path: dir,
      name: dir === '' ? '' : dir.slice(dir.lastIndexOf('/') + 1),
      parts: partIndices.map((index) => partNames[index] as string),
      media: [...accumulator.media].sort(byName),
      sidecars: [...accumulator.sidecars].sort(byName),
      albumMetadata: accumulator.albumMetadata,
      ignored: [...accumulator.ignored].sort(byName),
      fileNames: [...accumulator.names].sort(compareStrings),
      sidecarNames: [...accumulator.sidecars]
        .map((sidecar) => sidecar.name)
        .sort(compareStrings)
        .filter((name, index, all) => all[index - 1] !== name),
    };
  });

  folders.sort((a, b) => compareStrings(a.path, b.path));
  return folders;
}

// ---------------------------------------------------------------------------
// Handing files to the rest of the pipeline
// ---------------------------------------------------------------------------

/**
 * The dedupe source reference for a file found by traversal.
 *
 * Uses {@link TakeoutFile.sourcePath} rather than {@link TakeoutFile.path}, which is the whole
 * reason those are two fields: `sourceRefId` turns this into the key the ledger dedupes on, and
 * two demonstrably different files sharing one key would make one of them invisible.
 */
export function takeoutSourceOf(file: TakeoutFile): TakeoutSource {
  return { kind: 'takeout', path: file.sourcePath };
}
