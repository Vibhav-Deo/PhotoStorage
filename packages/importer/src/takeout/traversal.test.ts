/**
 * Multi-archive traversal against the fixture corpus (task 2.2, Requirement 1.1).
 *
 * The corpus is the input on purpose: it has three parts, a `Photos from 2021` folder split
 * across parts 002 and 003, and `cross-part-sidecar`, whose media is in 003 while its sidecar is
 * in 002. That last fixture is what makes the central claim falsifiable — traversing 003 alone
 * must leave it unpaired, and traversing the set must make it pairable — so both directions are
 * asserted rather than only the one that passes.
 *
 * Cases the corpus deliberately does not cover, because they are not shapes a *correct* export
 * has, are built on top of it in temporary directories: overlapping paths across parts, both
 * benign and contradictory, and the export furniture (`archive_browser.html`, account JSON, OS
 * junk) that has to be classified rather than skipped.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AssetKind, sourceRefId } from '@photo-archive/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCorpus, folderDirIn } from './fixtures/buildCorpus.ts';
import type { BuiltCorpus } from './fixtures/buildCorpus.ts';
import {
  PART_001,
  PART_002,
  PART_003,
  TAKEOUT_CORPUS,
  TAKEOUT_MEDIA_ROOT,
} from './fixtures/corpus.ts';
import {
  ALBUM_METADATA_FILE,
  TakeoutFileKind,
  TakeoutTraversalError,
  classifyFileName,
  discoverParts,
  findExportRoot,
  takeoutSourceOf,
  traverseExport,
} from './traversal.ts';
import type { TakeoutExport, TakeoutFolder } from './traversal.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

const PARTS = [PART_001, PART_002, PART_003] as const;

let root: string;
let built: BuiltCorpus;
/** The whole corpus, all three parts, in numbered order. */
let full: TakeoutExport;

function partPath(part: string): string {
  return path.join(root, part);
}

async function temporaryDirectory(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `takeout-${label}-`));
}

/** Writes a file into a part's export root, creating directories as needed. */
async function writeInto(partRoot: string, relativePath: string, contents: string): Promise<void> {
  const absolute = path.join(partRoot, TAKEOUT_MEDIA_ROOT, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents);
}

/** A throwaway export with `parts` empty part directories, each with the Takeout prefix. */
async function emptyExport(label: string, parts: readonly string[]): Promise<string> {
  const directory = await temporaryDirectory(label);
  for (const part of parts) {
    await fs.mkdir(path.join(directory, part, TAKEOUT_MEDIA_ROOT), { recursive: true });
  }
  return directory;
}

function folder(result: TakeoutExport, dir: string): TakeoutFolder {
  const found = result.folderByPath.get(dir);
  if (found === undefined) {
    throw new Error(
      `no folder view for ${JSON.stringify(dir)}; got ${result.folders
        .map((entry) => JSON.stringify(entry.path))
        .join(', ')}`,
    );
  }
  return found;
}

beforeAll(async () => {
  root = await temporaryDirectory('traversal-corpus');
  built = await buildCorpus(root);
  full = await traverseExport(PARTS.map(partPath));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('classification', () => {
  it('separates media, sidecars, album metadata, and export furniture', () => {
    expect(classifyFileName('IMG_1234.jpg')).toEqual({
      kind: TakeoutFileKind.Media,
      mediaKind: AssetKind.Image,
    });
    expect(classifyFileName('IMG_2001.HEIC').mediaKind).toBe(AssetKind.Image);
    expect(classifyFileName('IMG_2001.MOV').mediaKind).toBe(AssetKind.Video);
    expect(classifyFileName('VID_20210704_121314.mp4').mediaKind).toBe(AssetKind.Video);

    expect(classifyFileName('IMG_1234.jpg.json').kind).toBe(TakeoutFileKind.Sidecar);
    expect(classifyFileName('IMG_1234.jpg.supplemental-metadata.json').kind).toBe(
      TakeoutFileKind.Sidecar,
    );
    expect(classifyFileName(ALBUM_METADATA_FILE).kind).toBe(TakeoutFileKind.AlbumMetadata);
    expect(classifyFileName('archive_browser.html').kind).toBe(TakeoutFileKind.ArchiveBrowser);
    expect(classifyFileName('print-subscriptions.json').kind).toBe(TakeoutFileKind.AccountMetadata);
    expect(classifyFileName('.DS_Store').kind).toBe(TakeoutFileKind.Unknown);
  });

  /**
   * The MOV half of a Live Photo is an ordinary video here. Deciding it is a motion component
   * needs a same-stem still in the merged folder, which is a fact about the folder rather than
   * the filename, and it belongs to task 2.5.
   */
  it('never decides a file is a motion component', () => {
    const kinds = TAKEOUT_CORPUS.media.map((fixture) => classifyFileName(fixture.file).mediaKind);
    expect(kinds).not.toContain(AssetKind.MotionComponent);
  });

  it('reads the account-level JSON beside the folders as furniture, not as a sidecar', () => {
    // A sidecar with no media would be offered to step 4 of the resolution order, which matches
    // on basename alone, and could then attach account metadata to a photo.
    for (const name of [
      'print-subscriptions.json',
      'shared_album_comments.json',
      'user-generated-memory-titles.json',
    ]) {
      expect(classifyFileName(name).kind).not.toBe(TakeoutFileKind.Sidecar);
    }
  });
});

describe('export root', () => {
  it('looks through the Takeout/Google Photos prefix that repeats in every part', async () => {
    for (const part of PARTS) {
      const exportRoot = await findExportRoot(partPath(part));
      expect(exportRoot).toBe(path.join(partPath(part), TAKEOUT_MEDIA_ROOT));
    }
  });

  it('treats a directory with no Takeout folder as an export root already', async () => {
    const alreadyFlat = path.join(partPath(PART_001), TAKEOUT_MEDIA_ROOT);
    expect(await findExportRoot(alreadyFlat)).toBe(alreadyFlat);
  });

  it('refuses to guess when a part holds several product folders', async () => {
    const directory = await emptyExport('several-products', ['part-a']);
    try {
      await fs.mkdir(path.join(directory, 'part-a', 'Takeout', 'Google Drive'), {
        recursive: true,
      });
      await expect(findExportRoot(path.join(directory, 'part-a'))).rejects.toThrow(
        TakeoutTraversalError,
      );
      // Naming the folder resolves it, rather than a fraction of the export being imported.
      expect(
        await findExportRoot(path.join(directory, 'part-a'), {
          productFolderName: 'google photos',
        }),
      ).toBe(path.join(directory, 'part-a', TAKEOUT_MEDIA_ROOT));
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('part discovery', () => {
  it('finds the corpus parts in numbered order', async () => {
    expect(await discoverParts(root)).toEqual(PARTS.map(partPath));
  });

  it('orders by number rather than lexically, so 002 precedes 010', async () => {
    const directory = await emptyExport('numbering', [
      'takeout-x-010',
      'takeout-x-002',
      'takeout-x-001',
    ]);
    try {
      expect((await discoverParts(directory)).map((part) => path.basename(part))).toEqual([
        'takeout-x-001',
        'takeout-x-002',
        'takeout-x-010',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('recognizes a renamed part by the Takeout directory inside it', async () => {
    const directory = await emptyExport('renamed', ['photos-from-google']);
    try {
      expect((await discoverParts(directory)).map((part) => path.basename(part))).toEqual([
        'photos-from-google',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('fails with a directory that holds no parts rather than importing nothing', async () => {
    const directory = await temporaryDirectory('no-parts');
    try {
      await fs.mkdir(path.join(directory, 'holiday snaps'));
      await expect(discoverParts(directory)).rejects.toThrow(TakeoutTraversalError);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('one logical export from several parts', () => {
  it('finds every media fixture exactly once, at a path relative to the logical export', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const expected = nfc(`${fixture.folder}/${fixture.file}`);
      const found = full.media.filter((file) => file.path === expected);
      if (found.length !== 1) {
        problems.push(`${fixture.id}: ${String(found.length)} media entries at ${expected}`);
        continue;
      }
      const file = found[0];
      if (file?.part !== fixture.part) {
        problems.push(`${fixture.id}: read from ${String(file?.part)}, declared ${fixture.part}`);
      }
      if (file?.dir !== nfc(fixture.folder)) {
        problems.push(`${fixture.id}: dir is ${String(file?.dir)}, expected ${fixture.folder}`);
      }
      if (file?.sourcePath !== expected) {
        problems.push(`${fixture.id}: sourcePath is ${String(file?.sourcePath)}`);
      }
    }

    expect(problems).toEqual([]);
    expect(full.media.length).toBe(TAKEOUT_CORPUS.media.length);
  });

  it('strips the part directory and the Takeout prefix from every logical path', () => {
    const leaked = full.files
      .filter((file) => !file.outsideExport)
      .filter(
        (file) =>
          file.path.startsWith('Takeout/') ||
          file.path.includes('/Takeout/') ||
          PARTS.some((part) => file.path.startsWith(`${part}/`)),
      );
    expect(leaked.map((file) => file.path)).toEqual([]);
  });

  it('keeps an openable absolute path alongside the normalized logical one', async () => {
    // The `é` in IMG_3002-modifié.jpg has two encodings and the filesystem chooses; a path
    // normalized for comparison is not necessarily a path that opens.
    const problems: string[] = [];
    for (const file of full.files) {
      const stat = await fs.stat(file.absolutePath).catch(() => null);
      if (stat === null) {
        problems.push(`${file.path}: absolutePath does not exist`);
      } else if (stat.size !== file.byteSize) {
        problems.push(`${file.path}: byteSize disagrees with the file on disk`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('finds the NFC-composed variant filename whichever form the filesystem stores', () => {
    const composed = nfc('Familienurlaub 2020/IMG_3002-modifié.jpg');
    expect(full.media.map((file) => file.path)).toContain(composed);
    expect(folder(full, 'Familienurlaub 2020').fileNames).toContain(nfc('IMG_3002-modifié.jpg'));
  });

  it('reports each part with the export root it resolved to', () => {
    expect(full.parts.map((part) => part.name)).toEqual([...PARTS]);
    for (const part of full.parts) {
      expect(part.exportRoot).toBe(path.join(part.root, TAKEOUT_MEDIA_ROOT));
      expect(part.fileCount).toBeGreaterThan(0);
    }
    // Every file written by the corpus is accounted for in some part.
    const total = full.parts.reduce((sum, part) => sum + part.fileCount, 0);
    expect(total).toBe(built.files.length);
  });
});

describe('merged folder view', () => {
  it('produces one folder per logical folder, listing the parts it spans', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.folders) {
      const view = full.folderByPath.get(nfc(fixture.dir));
      if (view === undefined) {
        problems.push(`${fixture.dir}: no folder view`);
        continue;
      }
      if (view.parts.join(',') !== [...fixture.parts].sort().join(',')) {
        problems.push(
          `${fixture.dir}: spans ${view.parts.join(', ')}, declared ${fixture.parts.join(', ')}`,
        );
      }
    }

    expect(problems).toEqual([]);
    // The declared folders plus the export root itself, which holds Google's account JSON.
    expect(full.folders.length).toBe(TAKEOUT_CORPUS.folders.length + 1);
    expect(full.folderByPath.has('')).toBe(true);
  });

  it('merges Photos from 2021 across parts 002 and 003 into one view', () => {
    const view = folder(full, 'Photos from 2021');
    expect(view.parts).toEqual([PART_002, PART_003]);
    expect(view.fileNames).toEqual([
      'IMG_0042.JPG',
      'IMG_0042.jpg.json',
      'IMG_7777.jpg',
      'IMG_7777.jpg.json',
      'VID_20210704_121314.mp4',
    ]);
    // The media and its sidecar are in the same view and came from different archives.
    const media = view.media.find((file) => file.name === 'IMG_7777.jpg');
    const sidecar = view.sidecars.find((file) => file.name === 'IMG_7777.jpg.json');
    expect(media?.part).toBe(PART_003);
    expect(sidecar?.part).toBe(PART_002);
  });

  it('offers pairing the merged sidecar names, which is what it probes against', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const expected = fixture.expect.sidecarFile;
      if (expected === null) continue;
      const view = folder(full, nfc(fixture.folder));
      if (!view.sidecarNames.includes(nfc(expected))) {
        problems.push(`${fixture.id}: ${expected} is not among ${fixture.folder}'s sidecar names`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('surfaces metadata.json in album folders and nowhere else', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.folders) {
      const view = folder(full, nfc(fixture.dir));
      const present = view.albumMetadata !== null;
      if (present !== fixture.expect.isAlbum) {
        problems.push(
          `${fixture.dir}: metadata.json ${present ? 'present' : 'absent'}, isAlbum=${String(fixture.expect.isAlbum)}`,
        );
      }
      if (view.albumMetadata !== null && view.albumMetadata.name !== ALBUM_METADATA_FILE) {
        problems.push(`${fixture.dir}: album metadata is ${view.albumMetadata.name}`);
      }
      // metadata.json must never reach pairing as a sidecar.
      if (view.sidecarNames.includes(ALBUM_METADATA_FILE)) {
        problems.push(`${fixture.dir}: metadata.json offered to pairing as a sidecar`);
      }
    }

    expect(problems).toEqual([]);
  });

  it('gives a nested folder its own view rather than folding it into its parent', async () => {
    const directory = await emptyExport('nested', ['takeout-nested-001']);
    try {
      const part = path.join(directory, 'takeout-nested-001');
      await writeInto(part, 'Trip/IMG_1.jpg', 'one');
      await writeInto(part, 'Trip/Day 2/IMG_2.jpg', 'two');
      await writeInto(part, 'Trip/Day 2/Evening/IMG_3.jpg', 'three');

      const result = await traverseExport([part]);
      expect(result.folders.map((view) => view.path)).toEqual([
        '',
        'Trip',
        'Trip/Day 2',
        'Trip/Day 2/Evening',
      ]);
      expect(folder(result, 'Trip').media.map((file) => file.name)).toEqual(['IMG_1.jpg']);
      expect(folder(result, 'Trip/Day 2').media.map((file) => file.name)).toEqual(['IMG_2.jpg']);
      expect(folder(result, 'Trip/Day 2/Evening').media.map((file) => file.name)).toEqual([
        'IMG_3.jpg',
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('the cross-part fixture in both directions', () => {
  it('leaves IMG_7777.jpg unpaired when only part 003 is traversed', async () => {
    const alone = await traverseExport([partPath(PART_003)]);
    const view = folder(alone, 'Photos from 2021');

    expect(view.parts).toEqual([PART_003]);
    expect(view.media.map((file) => file.name)).toEqual(['IMG_7777.jpg']);
    // The sidecar is in part 002 and so is genuinely absent. Every pairing step probes
    // sidecarNames, so all four fail and the photo falls back to its 2024 mtime.
    expect(view.sidecarNames).toEqual([]);
    expect(alone.sidecars.map((file) => file.name)).not.toContain('IMG_7777.jpg.json');
  });

  it('makes it pairable as soon as parts 002 and 003 are read together', async () => {
    const together = await traverseExport([partPath(PART_002), partPath(PART_003)]);
    const view = folder(together, 'Photos from 2021');
    expect(view.sidecarNames).toContain('IMG_7777.jpg.json');
  });

  it('does not depend on the order the two parts are supplied in', async () => {
    const forward = await traverseExport([partPath(PART_002), partPath(PART_003)]);
    const reverse = await traverseExport([partPath(PART_003), partPath(PART_002)]);
    expect(folder(reverse, 'Photos from 2021').fileNames).toEqual(
      folder(forward, 'Photos from 2021').fileNames,
    );
  });
});

describe('overlapping paths across parts', () => {
  it('counts a path repeated with the same bytes once, keeping the earliest part', async () => {
    const directory = await emptyExport('repeated', ['takeout-r-001', 'takeout-r-002']);
    try {
      const first = path.join(directory, 'takeout-r-001');
      const second = path.join(directory, 'takeout-r-002');
      await writeInto(first, 'Photos from 2020/IMG_1.jpg', 'identical bytes');
      await writeInto(second, 'Photos from 2020/IMG_1.jpg', 'identical bytes');

      const result = await traverseExport([first, second]);

      expect(result.media.map((file) => file.path)).toEqual(['Photos from 2020/IMG_1.jpg']);
      expect(result.media[0]?.part).toBe('takeout-r-001');
      expect(result.conflicts).toEqual([]);
      expect(result.duplicates).toEqual([
        {
          path: 'Photos from 2020/IMG_1.jpg',
          keptPart: 'takeout-r-001',
          droppedParts: ['takeout-r-002'],
          byteSize: 'identical bytes'.length,
        },
      ]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * The data-loss case. Two parts claim one path with different bytes, so they are not one file
   * and collapsing them would destroy one permanently and invisibly. Nothing is dropped, nothing
   * is chosen, and the contradiction is recorded for the reconciliation report.
   */
  it('keeps every copy when the sizes contradict each other, and records the conflict', async () => {
    const directory = await emptyExport('conflict', ['takeout-c-001', 'takeout-c-002']);
    try {
      const first = path.join(directory, 'takeout-c-001');
      const second = path.join(directory, 'takeout-c-002');
      await writeInto(first, 'Photos from 2020/IMG_1.jpg', 'the whole photo');
      await writeInto(second, 'Photos from 2020/IMG_1.jpg', 'truncated');

      const result = await traverseExport([first, second]);

      expect(result.duplicates).toEqual([]);
      expect(result.conflicts).toEqual([
        {
          path: 'Photos from 2020/IMG_1.jpg',
          copies: [
            {
              part: 'takeout-c-001',
              byteSize: 'the whole photo'.length,
              sourcePath: 'Photos from 2020/IMG_1.jpg',
            },
            {
              part: 'takeout-c-002',
              byteSize: 'truncated'.length,
              sourcePath: 'takeout-c-002/Photos from 2020/IMG_1.jpg',
            },
          ],
        },
      ]);

      // Both sets of bytes reach the pipeline.
      expect(result.media.length).toBe(2);
      expect(result.media.map((file) => file.part)).toEqual(['takeout-c-001', 'takeout-c-002']);

      // And they carry distinct dedupe identities, or the ledger would see one source with two
      // digests and reject the second as a divergence instead of importing it.
      const refIds = result.media.map((file) => sourceRefId(takeoutSourceOf(file)));
      expect(new Set(refIds).size).toBe(2);

      // Pairing still sees one filename, because the folder listing is about names.
      expect(folder(result, 'Photos from 2020').fileNames).toEqual(['IMG_1.jpg']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects two parts with the same directory name rather than misattributing their files', async () => {
    const outer = await temporaryDirectory('same-name');
    try {
      const first = path.join(outer, 'a', 'takeout-001');
      const second = path.join(outer, 'b', 'takeout-001');
      for (const part of [first, second]) {
        await fs.mkdir(path.join(part, TAKEOUT_MEDIA_ROOT), { recursive: true });
      }
      await expect(traverseExport([first, second])).rejects.toThrow(TakeoutTraversalError);
    } finally {
      await fs.rm(outer, { recursive: true, force: true });
    }
  });
});

describe('non-media files', () => {
  it('classifies export furniture and junk instead of skipping it', async () => {
    const directory = await emptyExport('furniture', ['takeout-f-001']);
    try {
      const part = path.join(directory, 'takeout-f-001');
      await writeInto(part, 'Photos from 2020/IMG_1.jpg', 'photo');
      await writeInto(part, 'Photos from 2020/IMG_1.jpg.json', '{}');
      await writeInto(part, 'Photos from 2020/.DS_Store', 'junk');
      await writeInto(part, 'Photos from 2020/notes.txt', 'stray');
      await writeInto(part, 'print-subscriptions.json', '[]');
      await writeInto(part, 'Holiday/metadata.json', '{"title":"Holiday"}');
      // Google writes this beside the product folder, above the export root.
      await fs.writeFile(path.join(part, 'Takeout', 'archive_browser.html'), '<html></html>');

      const result = await traverseExport([part]);
      const kinds = new Map(result.files.map((file) => [file.path, file.kind]));

      expect(kinds.get('Photos from 2020/IMG_1.jpg')).toBe(TakeoutFileKind.Media);
      expect(kinds.get('Photos from 2020/IMG_1.jpg.json')).toBe(TakeoutFileKind.Sidecar);
      expect(kinds.get('Photos from 2020/.DS_Store')).toBe(TakeoutFileKind.Unknown);
      expect(kinds.get('Photos from 2020/notes.txt')).toBe(TakeoutFileKind.Unknown);
      expect(kinds.get('print-subscriptions.json')).toBe(TakeoutFileKind.AccountMetadata);
      expect(kinds.get('Holiday/metadata.json')).toBe(TakeoutFileKind.AlbumMetadata);

      // Nothing was silently dropped: everything written is in `files`.
      expect(result.files.length).toBe(7);
      expect(result.ignored.map((file) => file.path).sort()).toEqual([
        'Photos from 2020/.DS_Store',
        'Photos from 2020/notes.txt',
        'Takeout/archive_browser.html',
        'print-subscriptions.json',
      ]);

      // Junk does not reach pairing, and does not become an asset.
      expect(folder(result, 'Photos from 2020').sidecarNames).toEqual(['IMG_1.jpg.json']);
      expect(result.media.map((file) => file.path)).toEqual(['Photos from 2020/IMG_1.jpg']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('holds a file above the export root outside every folder view, qualified by its part', async () => {
    const directory = await emptyExport('above-root', ['takeout-a-001', 'takeout-a-002']);
    try {
      const parts = ['takeout-a-001', 'takeout-a-002'].map((name) => path.join(directory, name));
      for (const part of parts) {
        await fs.writeFile(path.join(part, 'Takeout', 'archive_browser.html'), '<html></html>');
      }

      const result = await traverseExport(parts);
      const browsers = result.files.filter((file) => file.name === 'archive_browser.html');

      // One per part: they sit above the logical export, so they are not one repeated file.
      expect(browsers.length).toBe(2);
      expect(browsers.every((file) => file.outsideExport)).toBe(true);
      expect(browsers.map((file) => file.sourcePath).sort()).toEqual([
        'takeout-a-001/Takeout/archive_browser.html',
        'takeout-a-002/Takeout/archive_browser.html',
      ]);
      expect(result.duplicates).toEqual([]);

      // And they belong to no folder, so `Takeout` never appears as one.
      expect(result.folders.map((view) => view.path)).toEqual(['']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('reports a symlink rather than following it out of the export', async () => {
    const directory = await emptyExport('symlink', ['takeout-s-001']);
    try {
      const part = path.join(directory, 'takeout-s-001');
      await writeInto(part, 'Photos from 2020/IMG_1.jpg', 'photo');
      await fs.symlink(
        path.join(part, TAKEOUT_MEDIA_ROOT, 'Photos from 2020'),
        path.join(part, TAKEOUT_MEDIA_ROOT, 'loop'),
      );

      const result = await traverseExport([part]);
      const link = result.files.find((file) => file.name === 'loop');
      expect(link?.kind).toBe(TakeoutFileKind.Unknown);
      expect(result.media.map((file) => file.path)).toEqual(['Photos from 2020/IMG_1.jpg']);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe('traversal invariants', () => {
  it('refuses an empty part list rather than returning an empty export', async () => {
    await expect(traverseExport([])).rejects.toThrow(TakeoutTraversalError);
  });

  it('refuses a part that is a file, since archives must be unzipped first', async () => {
    const directory = await temporaryDirectory('zipped');
    try {
      const zip = path.join(directory, 'takeout-001.zip');
      await fs.writeFile(zip, 'PK');
      await expect(traverseExport([zip])).rejects.toThrow(TakeoutTraversalError);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * **Validates: Requirements 1.1** — multi-part archives processed as a single logical export.
   *
   * The property is what "one logical export" means as an equation: however a set of files is
   * split across parts, traversal yields exactly that set of logical paths, each exactly once.
   * Splitting is the only thing Takeout does when it decides where a file goes, and it does it on
   * size alone, so the partition is arbitrary and the result must not depend on it. A property
   * test is the right shape here because the failure mode — one specific split losing or doubling
   * one file — is invisible to any fixed example that happens not to contain that split.
   */
  it('yields the union of the parts, once each, whatever the split', async () => {
    const relativePath = fc
      .tuple(
        fc.constantFrom('Photos from 2019', 'Photos from 2021', 'Iceland', 'Album/Nested'),
        fc.constantFrom('IMG_1.jpg', 'IMG_2.HEIC', 'VID_1.mp4', nfc('IMG_3-modifié.jpg')),
      )
      .map(([dir, file]) => `${dir}/${file}`);

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(relativePath, { minLength: 1, maxLength: 8 }),
        // One part index per path, so every arrangement across up to three parts is reachable.
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 8, maxLength: 8 }),
        async (paths, assignment) => {
          const directory = await emptyExport('property', [
            'takeout-p-001',
            'takeout-p-002',
            'takeout-p-003',
          ]);
          try {
            const parts = ['takeout-p-001', 'takeout-p-002', 'takeout-p-003'].map((name) =>
              path.join(directory, name),
            );
            for (const [index, relative] of paths.entries()) {
              const partIndex = assignment[index] ?? 0;
              await writeInto(parts[partIndex] as string, relative, `bytes for ${relative}`);
            }

            const result = await traverseExport(parts);

            expect(result.media.map((file) => file.path).sort()).toEqual([...paths].sort());
            expect(result.duplicates).toEqual([]);
            expect(result.conflicts).toEqual([]);
            // Every surviving file is its own dedupe source, so nothing is counted per part.
            const refIds = result.media.map((file) => sourceRefId(takeoutSourceOf(file)));
            expect(new Set(refIds).size).toBe(paths.length);
          } finally {
            await fs.rm(directory, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it('agrees with the corpus about what is on disk', () => {
    // Every file the corpus wrote inside a part's export root appears in the merged view under
    // its logical path, which is the corpus path minus the part and the Takeout prefix.
    const problems: string[] = [];
    const logical = new Set(full.files.map((file) => file.path));

    for (const relative of built.files) {
      const segments = relative.split(path.sep);
      const part = segments[0] ?? '';
      const expected = nfc(
        path.relative(folderDirIn(part, ''), relative).split(path.sep).join('/'),
      );
      if (!logical.has(expected)) {
        problems.push(`${relative}: no entry at ${expected}`);
      }
    }

    expect(problems).toEqual([]);
  });
});
