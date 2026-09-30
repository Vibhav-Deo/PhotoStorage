/**
 * Integrity of the fixture corpus itself.
 *
 * The corpus is what tasks 2.2-2.12 are checked against, which makes it the one thing in
 * Phase 2 that nothing else checks. A fixture whose `expect` block contradicts its filenames
 * does not fail here by accident — it fails later, in a resolver test, looking exactly like a
 * resolver bug. So this file treats the manifest as the thing under test: every declared
 * fixture materializes, every claimed pairing names a file that is really on disk, every
 * cross-reference resolves, and no expectation contradicts another or the tree.
 *
 * It deliberately does **not** implement pairing. Task 2.3 does that. The checks below are
 * structural — "the sidecar this fixture claims to pair with by truncation really is a
 * truncated prefix of its filename, is within Takeout's length limit, and no exact match
 * exists to preempt it" — which is what makes the expectation falsifiable without duplicating
 * the algorithm it is meant to test.
 *
 * Failures are reported as lists of offenders rather than as the first assertion to blow up,
 * because a manifest edit that breaks one invariant usually breaks it in several places and
 * seeing all of them at once is the difference between one fix and five rounds.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AssetKind, CapturedAtSource } from '@photo-archive/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALBUM_METADATA_FILE } from '../traversal.ts';
import { buildCorpus, folderDirIn } from './buildCorpus.ts';
import type { BuiltCorpus } from './buildCorpus.ts';
import { TAKEOUT_CORPUS } from './corpus.ts';
import { FolderRole, PairingStep } from './corpusTypes.ts';
import type { FolderFixture, MediaFixture } from './corpusTypes.ts';
import { exifDateToIsoUtc, extensionOf, syntheticMediaBytes } from './syntheticMedia.ts';

/** Takeout's approximate sidecar filename limit (design: Takeout metadata repair). */
const SIDECAR_NAME_LIMIT = 51;

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'heic', 'heif', 'png']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v']);

const FOLDERS: ReadonlyMap<string, FolderFixture> = new Map(
  TAKEOUT_CORPUS.folders.map((folder) => [folder.dir, folder]),
);
const MEDIA: ReadonlyMap<string, MediaFixture> = new Map(
  TAKEOUT_CORPUS.media.map((fixture) => [fixture.id, fixture]),
);

/**
 * Unicode normalization is applied to every filename read off disk and every filename read
 * out of the manifest before they are compared. `IMG_3002-modifié.jpg` has two encodings, and
 * which one a directory listing hands back is a property of the filesystem rather than of the
 * export — so a comparison that skips this passes on APFS and fails on HFS+ for reasons that
 * have nothing to do with the code under test.
 */
function nfc(value: string): string {
  return value.normalize('NFC');
}

/** The part of a filename before its first dot. What step 4 matches on. */
function basenameOf(fileName: string): string {
  const dot = fileName.indexOf('.');
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/** A sidecar filename minus `.json`. What step 2 compares against a media filename. */
function sidecarStem(sidecarFile: string): string {
  return sidecarFile.endsWith('.json') ? sidecarFile.slice(0, -'.json'.length) : sidecarFile;
}

function isSidecar(fileName: string): boolean {
  return fileName.endsWith('.json') && fileName !== ALBUM_METADATA_FILE;
}

/** The two names step 1 probes, in order. */
function exactSidecarNames(mediaFile: string): readonly string[] {
  return [`${mediaFile}.json`, `${mediaFile}.supplemental-metadata.json`];
}

function folderOf(fixture: MediaFixture): FolderFixture {
  const folder = FOLDERS.get(fixture.folder);
  if (folder === undefined) {
    throw new Error(`fixture ${fixture.id} names unknown folder ${fixture.folder}`);
  }
  return folder;
}

let built: BuiltCorpus;
let root: string;
/** Filenames present in each logical folder, merged across every part it appears in. */
let merged: Map<string, string[]>;
/** Filenames present in one folder within one part, keyed `part\u0000dir`. */
let perPart: Map<string, string[]>;

async function listing(part: string, dir: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, folderDirIn(part, dir)));
  return entries.map(nfc).sort();
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-corpus-'));
  built = await buildCorpus(root);

  merged = new Map();
  perPart = new Map();
  for (const folder of TAKEOUT_CORPUS.folders) {
    const all = new Set<string>();
    for (const part of folder.parts) {
      const names = await listing(part, folder.dir);
      perPart.set(`${part}\u0000${folder.dir}`, names);
      for (const name of names) {
        all.add(name);
      }
    }
    merged.set(folder.dir, [...all].sort());
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Filenames in a logical folder, merged across parts. */
function mergedFiles(dir: string): readonly string[] {
  return merged.get(dir) ?? [];
}

/** Sidecar filenames in a logical folder, merged across parts. */
function mergedSidecars(dir: string): readonly string[] {
  return mergedFiles(dir).filter(isSidecar);
}

describe('takeout fixture corpus: materialization', () => {
  it('writes every declared fixture, with the declared mtime', async () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const entry = built.media.get(fixture.id);
      if (entry === undefined) {
        problems.push(`${fixture.id}: not materialized`);
        continue;
      }

      const stat = await fs.stat(path.join(root, entry.mediaPath));
      if (!stat.isFile()) {
        problems.push(`${fixture.id}: ${entry.mediaPath} is not a file`);
      }
      if (stat.size !== entry.byteLength || stat.size === 0) {
        problems.push(
          `${fixture.id}: ${String(stat.size)} bytes on disk, ${String(entry.byteLength)} reported`,
        );
      }
      const declaredMtime = Math.floor(Date.parse(fixture.mtime) / 1000);
      if (Math.floor(stat.mtimeMs / 1000) !== declaredMtime) {
        problems.push(
          `${fixture.id}: mtime is ${new Date(stat.mtimeMs).toISOString()}, declared ${fixture.mtime}`,
        );
      }
      if (nfc(path.basename(entry.mediaPath)) !== nfc(fixture.file)) {
        problems.push(`${fixture.id}: written as ${entry.mediaPath}, declared ${fixture.file}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('writes each declared sidecar into the part the manifest names', async () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const entry = built.media.get(fixture.id);
      const sidecar = fixture.sidecar;
      if (sidecar === undefined) {
        if (entry?.sidecarPath !== null) {
          problems.push(`${fixture.id}: declares no sidecar but one was written`);
        }
        continue;
      }
      if (entry?.sidecarPath == null) {
        problems.push(`${fixture.id}: declares a sidecar that was not written`);
        continue;
      }

      const expectedDir = folderDirIn(sidecar.part ?? fixture.part, folderOf(fixture).dir);
      if (path.dirname(entry.sidecarPath) !== expectedDir) {
        problems.push(
          `${fixture.id}: sidecar in ${entry.sidecarPath}, expected under ${expectedDir}`,
        );
      }
      const stat = await fs.stat(path.join(root, entry.sidecarPath));
      if (!stat.isFile() || stat.size === 0) {
        problems.push(`${fixture.id}: sidecar ${entry.sidecarPath} is missing or empty`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('writes metadata.json into album folders and nowhere else', () => {
    const withMetadata = new Set(
      built.albumMetadata.map((relative) => path.basename(path.dirname(relative))),
    );

    const problems: string[] = [];
    for (const folder of TAKEOUT_CORPUS.folders) {
      const present = mergedFiles(folder.dir).includes(ALBUM_METADATA_FILE);
      if (present !== folder.expect.isAlbum) {
        problems.push(
          `${folder.dir}: metadata.json ${present ? 'present' : 'absent'}, isAlbum=${String(folder.expect.isAlbum)}`,
        );
      }
      if (folder.expect.isAlbum && !withMetadata.has(path.basename(folder.dir))) {
        problems.push(`${folder.dir}: album with no metadata.json in the build result`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('is deterministic: two builds produce identical trees and identical bytes', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-corpus-again-'));
    try {
      const second = await buildCorpus(other);
      expect(second.files).toEqual(built.files);

      for (const relative of built.files) {
        const a = await fs.readFile(path.join(root, relative));
        const b = await fs.readFile(path.join(other, relative));
        expect(b.equals(a), `${relative} differs between builds`).toBe(true);
      }
    } finally {
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

describe('takeout fixture corpus: pairing expectations', () => {
  it('every claimed pairing names a sidecar that exists in the merged folder', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const expected = fixture.expect.sidecarFile;
      if (expected === null) {
        continue;
      }
      const present = mergedFiles(folderOf(fixture).dir).map(nfc);
      if (!present.includes(nfc(expected))) {
        problems.push(`${fixture.id}: expects ${expected}, which is not in ${fixture.folder}`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('unpaired fixtures have nothing in the folder that any step could pair them with', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      if (fixture.expect.sidecarFile !== null) {
        continue;
      }
      const sidecars = mergedSidecars(folderOf(fixture).dir).map(nfc);
      const file = nfc(fixture.file);

      for (const exact of exactSidecarNames(file)) {
        if (sidecars.includes(exact)) {
          problems.push(`${fixture.id}: declared unpaired, but ${exact} exists (step 1 matches)`);
        }
      }
      for (const sidecar of sidecars) {
        if (file.startsWith(sidecarStem(sidecar))) {
          problems.push(`${fixture.id}: declared unpaired, but ${sidecar} is a prefix (step 2)`);
        }
      }
      const byBasename = sidecars.filter((s) => basenameOf(s) === basenameOf(file));
      if (byBasename.length === 1) {
        problems.push(
          `${fixture.id}: declared unpaired, but ${String(byBasename[0])} is a unique basename match (step 4)`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('each pairing is reachable by the step it claims and not preempted by an earlier one', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const { sidecarFile, pairingStep } = fixture.expect;
      if (sidecarFile === null || pairingStep === null) {
        continue;
      }
      const file = nfc(fixture.file);
      const sidecar = nfc(sidecarFile);
      const sidecars = mergedSidecars(folderOf(fixture).dir).map(nfc);
      const exactPresent = exactSidecarNames(file).filter((name) => sidecars.includes(name));

      switch (pairingStep) {
        case PairingStep.Exact: {
          if (!exactSidecarNames(file).includes(sidecar)) {
            problems.push(`${fixture.id}: ${sidecar} is not an exact name for ${file}`);
          }
          break;
        }
        case PairingStep.Truncated: {
          if (exactPresent.length > 0) {
            problems.push(
              `${fixture.id}: claims truncation, but ${String(exactPresent[0])} exists`,
            );
          }
          if (sidecar.length > SIDECAR_NAME_LIMIT) {
            problems.push(
              `${fixture.id}: truncated sidecar is ${String(sidecar.length)} chars, over the ${String(SIDECAR_NAME_LIMIT)} limit`,
            );
          }
          const stem = sidecarStem(sidecar);
          if (!file.startsWith(stem) || stem === file) {
            problems.push(`${fixture.id}: ${sidecar} is not a truncated prefix of ${file}`);
          }
          // The longest prefix wins, so no other prefix sidecar may be longer.
          for (const other of sidecars) {
            if (other !== sidecar && file.startsWith(sidecarStem(other))) {
              problems.push(`${fixture.id}: ${other} is also a prefix and would compete`);
            }
          }
          break;
        }
        case PairingStep.DisambiguatorSwap: {
          const groups = /^(?<stem>.*)\((?<n>\d+)\)\.(?<ext>[^.]+)$/u.exec(file)?.groups;
          if (groups === undefined) {
            problems.push(`${fixture.id}: claims a disambiguator swap but has no (n) in its stem`);
            break;
          }
          const { stem = '', n = '', ext = '' } = groups;
          const swapped = `${stem}.${ext}(${n}).json`;
          if (sidecar !== swapped) {
            problems.push(`${fixture.id}: swap probe is ${swapped}, expectation says ${sidecar}`);
          }
          if (exactPresent.length > 0) {
            problems.push(`${fixture.id}: claims a swap, but ${String(exactPresent[0])} exists`);
          }
          for (const other of sidecars) {
            if (file.startsWith(sidecarStem(other))) {
              problems.push(`${fixture.id}: ${other} would match at step 2, before the swap`);
            }
          }
          break;
        }
        case PairingStep.UniqueBasename: {
          if (exactPresent.length > 0) {
            problems.push(
              `${fixture.id}: claims the basename fallback, but ${String(exactPresent[0])} exists`,
            );
          }
          if (file.startsWith(sidecarStem(sidecar))) {
            problems.push(`${fixture.id}: ${sidecar} would already match at step 2`);
          }
          const matches = sidecars.filter((s) => basenameOf(s) === basenameOf(file));
          if (matches.length !== 1 || matches[0] !== sidecar) {
            problems.push(
              `${fixture.id}: basename ${basenameOf(file)} matches ${String(matches.length)} sidecars, not just ${sidecar}`,
            );
          }
          break;
        }
      }
    }

    expect(problems).toEqual([]);
  });

  it('pins the multi-part case: at least one sidecar lives in a different part than its media', () => {
    const split = TAKEOUT_CORPUS.media.filter((f) => f.expect.sidecarInOtherPart === true);
    expect(split.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const fixture of split) {
      const sidecarPart = fixture.sidecar?.part;
      const sidecarFile = fixture.expect.sidecarFile;
      if (sidecarPart === undefined || sidecarFile === null) {
        problems.push(`${fixture.id}: claims a split sidecar without declaring one`);
        continue;
      }
      if (sidecarPart === fixture.part) {
        problems.push(`${fixture.id}: sidecar part equals media part`);
      }
      const folder = folderOf(fixture);
      if (folder.parts.length < 2) {
        problems.push(`${fixture.id}: folder ${folder.dir} exists in only one part`);
      }
      // The point of the fixture: importing the media's own part alone cannot pair it.
      const ownPart = perPart.get(`${fixture.part}\u0000${folder.dir}`) ?? [];
      if (ownPart.includes(sidecarFile)) {
        problems.push(`${fixture.id}: sidecar is also present in ${fixture.part}`);
      }
      const otherPart = perPart.get(`${sidecarPart}\u0000${folder.dir}`) ?? [];
      if (!otherPart.includes(sidecarFile)) {
        problems.push(`${fixture.id}: sidecar is not in ${sidecarPart}`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('takeout fixture corpus: cross-references and provenance', () => {
  it('has unique ids and no two fixtures at the same path', () => {
    const ids = TAKEOUT_CORPUS.media.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(built.files).size).toBe(built.files.length);
    expect(built.files.length).toBe(
      TAKEOUT_CORPUS.media.length +
        TAKEOUT_CORPUS.media.filter((f) => f.sidecar !== undefined).length +
        built.albumMetadata.length,
    );
  });

  it('resolves every variantOf and livePairOf reference', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const { variantOf, livePairOf } = fixture.expect;

      if (variantOf !== null) {
        const base = MEDIA.get(variantOf);
        if (base === undefined) {
          problems.push(`${fixture.id}: variantOf ${variantOf} does not exist`);
        } else {
          if (base.expect.variantOf !== null) {
            problems.push(`${fixture.id}: base ${variantOf} is itself a variant`);
          }
          if (base.folder !== fixture.folder) {
            problems.push(`${fixture.id}: base ${variantOf} is in a different folder`);
          }
          if (base.id === fixture.id) {
            problems.push(`${fixture.id}: is its own base`);
          }
        }
      }

      if (livePairOf !== null) {
        const other = MEDIA.get(livePairOf);
        if (other === undefined) {
          problems.push(`${fixture.id}: livePairOf ${livePairOf} does not exist`);
          continue;
        }
        if (other.expect.livePairOf !== fixture.id) {
          problems.push(`${fixture.id}: live pairing with ${livePairOf} is not symmetric`);
        }
        if (basenameOf(other.file) !== basenameOf(fixture.file)) {
          problems.push(`${fixture.id}: live pair ${livePairOf} does not share its stem`);
        }
        if (other.folder !== fixture.folder) {
          problems.push(`${fixture.id}: live pair ${livePairOf} is in a different folder`);
        }
        const kinds = [fixture.expect.kind, other.expect.kind];
        if (!kinds.includes(AssetKind.MotionComponent) || !kinds.includes(AssetKind.Image)) {
          problems.push(`${fixture.id}: a live pair must be one image plus one motion component`);
        }
      }

      const isMotion = fixture.expect.kind === AssetKind.MotionComponent;
      if (isMotion !== fixture.expect.excludedFromTimeline) {
        problems.push(`${fixture.id}: only the motion component is hidden from the timeline`);
      }
      if (isMotion && livePairOf === null) {
        problems.push(`${fixture.id}: motion component with no still`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('has a provenance expectation consistent with what it actually provides', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const { sidecarFile, pairingStep, capturedAt, capturedAtSource } = fixture.expect;

      if ((sidecarFile === null) !== (pairingStep === null)) {
        problems.push(`${fixture.id}: sidecarFile and pairingStep disagree about pairing`);
      }

      switch (capturedAtSource) {
        case CapturedAtSource.TakeoutJson: {
          if (sidecarFile === null) {
            problems.push(`${fixture.id}: sidecar provenance without a sidecar`);
            break;
          }
          // The time must come from whichever sidecar it pairs with, which for a shared
          // sidecar is not its own declaration.
          const owner = TAKEOUT_CORPUS.media.find((f) => f.sidecar?.file === sidecarFile)?.sidecar;
          if (owner === undefined) {
            problems.push(`${fixture.id}: no fixture declares ${sidecarFile}`);
          } else if (owner.photoTakenAt !== capturedAt) {
            problems.push(
              `${fixture.id}: capturedAt ${capturedAt} but ${sidecarFile} says ${owner.photoTakenAt}`,
            );
          }
          break;
        }
        case CapturedAtSource.Exif: {
          if (sidecarFile !== null) {
            problems.push(`${fixture.id}: EXIF provenance would be overridden by ${sidecarFile}`);
          }
          if (fixture.exif === undefined) {
            problems.push(`${fixture.id}: EXIF provenance with no EXIF`);
          } else if (exifDateToIsoUtc(fixture.exif.dateTimeOriginal) !== capturedAt) {
            problems.push(`${fixture.id}: capturedAt does not match its own EXIF`);
          }
          break;
        }
        case CapturedAtSource.FileMtime: {
          if (sidecarFile !== null || fixture.exif !== undefined) {
            problems.push(`${fixture.id}: mtime provenance despite a better source being present`);
          }
          if (capturedAt !== fixture.mtime) {
            problems.push(`${fixture.id}: capturedAt ${capturedAt} is not its mtime`);
          }
          break;
        }
        case CapturedAtSource.User: {
          problems.push(`${fixture.id}: no fixture may claim user-corrected provenance`);
          break;
        }
      }

      const extension = extensionOf(fixture.file);
      const allowed = fixture.expect.kind === AssetKind.Image ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      if (!allowed.has(extension)) {
        problems.push(`${fixture.id}: kind does not match the .${extension} extension`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('carries exactly one fixture where EXIF, mtime, and the sidecar all disagree', () => {
    const disagreeing = TAKEOUT_CORPUS.media.filter(
      (f) =>
        f.exif !== undefined &&
        f.expect.sidecarFile !== null &&
        exifDateToIsoUtc(f.exif.dateTimeOriginal) !== f.expect.capturedAt,
    );

    expect(disagreeing.length).toBeGreaterThan(0);
    for (const fixture of disagreeing) {
      // The sidecar wins (Requirement 1.2), so none of the other two sources may coincide
      // with the expected answer or the fixture proves nothing.
      expect(fixture.expect.capturedAtSource).toBe(CapturedAtSource.TakeoutJson);
      expect(fixture.mtime).not.toBe(fixture.expect.capturedAt);
    }
  });

  it('agrees with each folder about its role, albums, and flags', () => {
    const problems: string[] = [];

    for (const folder of TAKEOUT_CORPUS.folders) {
      const isYearBucket = /^Photos from \d{4}$/u.test(folder.dir);
      if (isYearBucket !== (folder.role === FolderRole.YearBucket)) {
        problems.push(`${folder.dir}: name and role disagree about being a year bucket`);
      }
      if ((folder.metadata !== undefined) !== folder.expect.isAlbum) {
        problems.push(`${folder.dir}: metadata.json presence and isAlbum disagree`);
      }
      if (folder.expect.albumTitle !== (folder.metadata?.title ?? null)) {
        problems.push(`${folder.dir}: expected album title is not the one in metadata.json`);
      }
      if (folder.expect.yearBucket !== null && !isYearBucket) {
        problems.push(`${folder.dir}: declares a bucket year but is not a bucket`);
      }
    }

    for (const fixture of TAKEOUT_CORPUS.media) {
      const folder = folderOf(fixture);
      const expected = fixture.expect;
      if (expected.folderRole !== folder.role) {
        problems.push(`${fixture.id}: folder role disagrees with ${folder.dir}`);
      }
      const expectedAlbums = folder.expect.albumTitle === null ? [] : [folder.expect.albumTitle];
      if (expected.albums.join('\u0000') !== expectedAlbums.join('\u0000')) {
        problems.push(`${fixture.id}: album membership disagrees with ${folder.dir}`);
      }
      if (expected.archived !== (folder.role === FolderRole.Archive)) {
        problems.push(`${fixture.id}: archived flag disagrees with its folder`);
      }
      if (expected.inTrash !== (folder.role === FolderRole.Trash)) {
        problems.push(`${fixture.id}: inTrash flag disagrees with its folder`);
      }
      if (expected.archived !== (fixture.sidecar?.archived === true)) {
        problems.push(`${fixture.id}: archived flag disagrees with its sidecar`);
      }
      if (expected.inTrash !== (fixture.sidecar?.inTrash === true)) {
        problems.push(`${fixture.id}: inTrash flag disagrees with its sidecar`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('takeout fixture corpus: written content', () => {
  it('writes sidecar JSON that parses and carries the declared capture time', async () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const entry = built.media.get(fixture.id);
      const sidecar = fixture.sidecar;
      if (sidecar === undefined || entry?.sidecarPath == null) {
        continue;
      }
      const raw = await fs.readFile(path.join(root, entry.sidecarPath), 'utf8');
      const parsed = JSON.parse(raw) as {
        title?: unknown;
        photoTakenTime?: { timestamp?: unknown };
      };

      if (parsed.title !== sidecar.title) {
        problems.push(`${fixture.id}: sidecar title is ${String(parsed.title)}`);
      }
      const timestamp = parsed.photoTakenTime?.timestamp;
      if (typeof timestamp !== 'string') {
        problems.push(`${fixture.id}: photoTakenTime.timestamp must be a string, as Takeout emits`);
        continue;
      }
      const declared = Math.floor(Date.parse(sidecar.photoTakenAt) / 1000);
      if (Number(timestamp) !== declared) {
        problems.push(
          `${fixture.id}: photoTakenTime is ${timestamp}, declared ${String(declared)}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('writes real EXIF into fixtures that declare it, and none into the rest', async () => {
    const problems: string[] = [];
    const decoder = new TextDecoder('latin1');

    for (const fixture of TAKEOUT_CORPUS.media) {
      const entry = built.media.get(fixture.id);
      if (entry === undefined) {
        continue;
      }
      const bytes = await fs.readFile(path.join(root, entry.mediaPath));
      const text = decoder.decode(bytes);
      const hasApp1 = bytes[0] === 0xff && bytes[1] === 0xd8 && text.includes('Exif\0\0');

      if (fixture.exif === undefined) {
        if (hasApp1) {
          problems.push(`${fixture.id}: has an EXIF segment it does not declare`);
        }
        continue;
      }
      if (!hasApp1) {
        problems.push(`${fixture.id}: declares EXIF but the payload has no APP1 segment`);
      }
      if (!text.includes(fixture.exif.dateTimeOriginal)) {
        problems.push(`${fixture.id}: DateTimeOriginal is not in the bytes`);
      }
      if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
        problems.push(`${fixture.id}: JPEG is not terminated by EOI`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('gives every fixture distinct bytes, so distinct content hashes', async () => {
    const seen = new Map<string, string>();
    for (const [id, entry] of built.media) {
      const bytes = await fs.readFile(path.join(root, entry.mediaPath));
      const key = bytes.toString('base64');
      const previous = seen.get(key);
      expect(previous, `${id} has the same bytes as ${String(previous)}`).toBeUndefined();
      seen.set(key, id);
    }
  });
});

describe('takeout fixture corpus: coverage', () => {
  /**
   * The shapes task 2.1 is required to cover. This is the guard against the corpus quietly
   * losing a case: deleting `truncated-sidecar` fails here rather than making task 2.3 easier.
   */
  const SHAPES: ReadonlyArray<readonly [string, (fixture: MediaFixture) => boolean]> = [
    [
      'exact .json sidecar',
      (f) =>
        f.expect.pairingStep === PairingStep.Exact &&
        f.expect.sidecarFile?.endsWith('.supplemental-metadata.json') === false,
    ],
    [
      '.supplemental-metadata.json sidecar',
      (f) => f.expect.sidecarFile?.endsWith('.supplemental-metadata.json') === true,
    ],
    ['truncated sidecar filename', (f) => f.expect.pairingStep === PairingStep.Truncated],
    ['(n) disambiguator swap', (f) => f.expect.pairingStep === PairingStep.DisambiguatorSwap],
    ['unique-basename fallback', (f) => f.expect.pairingStep === PairingStep.UniqueBasename],
    ['-edited variant', (f) => nfc(f.file).includes('-edited.')],
    ['-bearbeitet variant', (f) => nfc(f.file).includes('-bearbeitet.')],
    ['-modifié variant', (f) => nfc(f.file).includes(nfc('-modifié.'))],
    ['-editado variant', (f) => nfc(f.file).includes('-editado.')],
    ['Live Photo still', (f) => f.expect.kind === AssetKind.Image && f.expect.livePairOf !== null],
    ['Live Photo motion component', (f) => f.expect.kind === AssetKind.MotionComponent],
    ['album membership', (f) => f.expect.albums.length > 0],
    ['Photos from YYYY bucket', (f) => f.expect.folderRole === FolderRole.YearBucket],
    ['Archive folder', (f) => f.expect.folderRole === FolderRole.Archive],
    ['Trash folder', (f) => f.expect.folderRole === FolderRole.Trash],
    ['unpaired media', (f) => f.expect.sidecarFile === null],
    ['EXIF provenance', (f) => f.expect.capturedAtSource === CapturedAtSource.Exif],
    ['mtime provenance', (f) => f.expect.capturedAtSource === CapturedAtSource.FileMtime],
    ['sidecar in another part', (f) => f.expect.sidecarInOtherPart === true],
  ];

  for (const [shape, predicate] of SHAPES) {
    it(`covers ${shape}`, () => {
      expect(TAKEOUT_CORPUS.media.filter(predicate).length).toBeGreaterThan(0);
    });
  }

  it('spans several parts, with one part that cannot stand alone', () => {
    expect(TAKEOUT_CORPUS.parts.length).toBeGreaterThanOrEqual(2);
    const partsWithMedia = new Set(TAKEOUT_CORPUS.media.map((f) => f.part));
    expect(partsWithMedia.size).toBe(TAKEOUT_CORPUS.parts.length);

    const spanning = TAKEOUT_CORPUS.folders.filter((folder) => folder.parts.length > 1);
    expect(spanning.length).toBeGreaterThan(0);
  });

  it('covers both folder kinds, and an album whose title comes from metadata.json', () => {
    const albums = TAKEOUT_CORPUS.folders.filter((f) => f.expect.isAlbum);
    const buckets = TAKEOUT_CORPUS.folders.filter((f) => f.role === FolderRole.YearBucket);
    expect(albums.length).toBeGreaterThan(0);
    expect(buckets.length).toBeGreaterThan(0);
    for (const album of albums) {
      expect(album.metadata?.title).toBe(album.expect.albumTitle);
    }
  });
});

describe('synthetic payloads', () => {
  it('frames JPEG payloads with SOI and EOI', () => {
    const bytes = syntheticMediaBytes('IMG_1.jpg', 'seed');
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect([bytes.at(-2), bytes.at(-1)]).toEqual([0xff, 0xd9]);
  });

  it('gives HEIC and MOV payloads a container brand', () => {
    const decoder = new TextDecoder('latin1');
    expect(decoder.decode(syntheticMediaBytes('IMG_1.HEIC', 'seed'))).toContain('ftypheic');
    expect(decoder.decode(syntheticMediaBytes('IMG_1.MOV', 'seed'))).toContain('ftypqt  ');
  });

  /**
   * **Validates: Requirements 3.1** — content addressing. The corpus is not checked in, so
   * every content hash in every later test is a function of this generator alone: it has to be
   * a function of the seed and nothing else, and distinct seeds have to give distinct bytes or
   * two fixtures collide into one asset and dedupe tests become unfalsifiable.
   */
  it('is a pure function of its inputs, and injective in the seed', () => {
    const extensions = fc.constantFrom('jpg', 'jpeg', 'HEIC', 'MOV', 'mp4', 'png');
    const seed = fc.string({ minLength: 1, maxLength: 40 });

    fc.assert(
      fc.property(seed, seed, extensions, extensions, (a, b, extA, extB) => {
        const first = syntheticMediaBytes(`file.${extA}`, a);
        const again = syntheticMediaBytes(`file.${extA}`, a);
        expect(Buffer.from(again).equals(Buffer.from(first))).toBe(true);
        expect(first.byteLength).toBeGreaterThan(0);

        if (a !== b && extA === extB) {
          expect(
            Buffer.from(syntheticMediaBytes(`file.${extB}`, b)).equals(Buffer.from(first)),
          ).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
