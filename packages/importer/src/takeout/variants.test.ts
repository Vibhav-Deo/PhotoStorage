/**
 * Variant and Live Photo linking against the fixture corpus (task 2.5, Requirements 1.5, 1.6).
 *
 * The corpus is the input and its declared expectations are the oracle: every fixture states the
 * `variantOf` base and the `livePairOf` counterpart it must resolve to — by fixture id — plus the
 * `AssetKind` it must be given and whether it is excluded from the timeline. So a linker that
 * finds the right relationship for the wrong reason still has to survive four fixtures whose
 * shapes contradict each other:
 *
 * - `edited-variant` has no sidecar, `bearbeitet-variant` has its own, and both must link. Variant
 *   linking cannot be "the file with no sidecar".
 * - `localized-base` is the base of two variants at once, so a linker that assumes one render per
 *   base drops one of them.
 * - `modifie-variant` carries a `é`, which has two Unicode normalizations. A suffix table matched
 *   against the wrong form stops recognizing the variant and says nothing about it.
 * - `unpaired-video` is a video that is nobody's motion component and must stay
 *   {@link AssetKind.Video}, because a motion component is hidden from the timeline and a
 *   wrongly hidden asset is one the user cannot find.
 *
 * The relationships are keyed on source paths rather than hashes, since no hash exists during
 * metadata repair. `resolveLinkHashes` is the seam that turns them into `variant_of_hash` and
 * `live_pair_hash`, and it gets its own group with a stated lookup — including the two cases the
 * corpus cannot express, a counterpart that was never hashed and a counterpart that deduplicated
 * into the same asset.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { AssetKind } from '@photo-archive/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCorpus } from './fixtures/buildCorpus.ts';
import { PART_001, PART_002, PART_003, TAKEOUT_CORPUS, fixtureById } from './fixtures/corpus.ts';
import type { MediaFixture } from './fixtures/corpusTypes.ts';
import { pairExport, pairFolder } from './pairing.ts';
import type { PairingResult } from './pairing.ts';
import { TakeoutFileKind, classifyFileName, traverseExport } from './traversal.ts';
import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';
import {
  LinkRelation,
  UnlinkedVariantReason,
  VariantMatch,
  baseNameFor,
  editedSuffixOf,
  excludedFromTimeline,
  linkExport,
  linkFolder,
  resolveLinkHashes,
  splitExtension,
} from './variants.ts';
import type { LinkResult } from './variants.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

const PARTS = [PART_001, PART_002, PART_003] as const;

let root: string;
let full: TakeoutExport;
let paired: PairingResult;
/** The whole corpus, linked with pairing available. */
let linked: LinkResult;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-variants-'));
  await buildCorpus(root);
  full = await traverseExport(PARTS.map((part) => path.join(root, part)));
  paired = pairExport(full);
  linked = linkExport(full, { pairing: paired });
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The logical path a fixture's media occupies, which is also its source path. */
function logicalPath(fixture: MediaFixture): string {
  return nfc(`${fixture.folder}/${fixture.file}`);
}

function pathOfId(id: string): string {
  const fixture = fixtureById(id);
  if (fixture === undefined) throw new Error(`no fixture named ${id}`);
  return logicalPath(fixture);
}

// ---------------------------------------------------------------------------
// Synthetic folders, for shapes the corpus deliberately does not contain
// ---------------------------------------------------------------------------

const SYNTHETIC_PART = 'takeout-v-001';
const SYNTHETIC_DIR = 'Photos from 2020';

function syntheticFile(name: string): TakeoutFile {
  const classified = classifyFileName(name);
  const logical = `${SYNTHETIC_DIR}/${nfc(name)}`;
  return {
    path: logical,
    dir: SYNTHETIC_DIR,
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

/**
 * A merged folder view holding exactly `names`, classified by traversal's own classifier.
 *
 * Linking reads nothing but filenames, so a folder can be stated rather than materialized — which
 * is what lets the property tests below run hundreds of arrangements.
 */
function syntheticFolder(names: readonly string[]): TakeoutFolder {
  const files = [...names].map(syntheticFile).sort((a, b) => (a.name < b.name ? -1 : 1));
  const sidecars = files.filter((file) => file.kind === TakeoutFileKind.Sidecar);
  return {
    path: SYNTHETIC_DIR,
    name: SYNTHETIC_DIR,
    parts: [SYNTHETIC_PART],
    media: files.filter((file) => file.kind === TakeoutFileKind.Media),
    sidecars,
    albumMetadata: null,
    ignored: [],
    fileNames: files.map((file) => file.name),
    sidecarNames: sidecars.map((file) => file.name),
  };
}

/** The source path a synthetic folder gives a filename. */
function syntheticPath(name: string): string {
  return `${SYNTHETIC_DIR}/${nfc(name)}`;
}

// ---------------------------------------------------------------------------
// The suffix table, filename by filename
// ---------------------------------------------------------------------------

describe('the -edited suffix table', () => {
  it('recognizes every suffix the design names', () => {
    expect(editedSuffixOf('IMG_2002-edited.jpg')?.baseStem).toBe('IMG_2002');
    expect(editedSuffixOf('IMG_3001-bearbeitet.jpg')?.baseStem).toBe('IMG_3001');
    expect(editedSuffixOf('IMG_3002-modifié.jpg')?.baseStem).toBe('IMG_3002');
    expect(editedSuffixOf('IMG_3002-editado.jpg')?.baseStem).toBe('IMG_3002');
  });

  /**
   * The `é` in `-modifié` has two encodings and which one a directory listing returns is a
   * property of the filesystem, not of the export. Both spellings are the same filename, so both
   * must match — a table compared against one form only stops recognizing the variant on the
   * other platform, silently.
   */
  it('matches a decomposed é as well as a composed one', () => {
    const composed = 'IMG_3002-modifi\u00e9.jpg';
    const decomposed = 'IMG_3002-modifie\u0301.jpg';
    // Two spellings of one filename: not equal as strings, and both must be recognized.
    expect<string>(composed).not.toBe(decomposed);

    expect(editedSuffixOf(composed)?.baseStem).toBe('IMG_3002');
    expect(editedSuffixOf(decomposed)?.baseStem).toBe('IMG_3002');
    // And the base filename derived from either spelling is the same NFC string.
    expect(baseNameFor(decomposed)).toBe(baseNameFor(composed));
    expect(baseNameFor(decomposed)).toBe('IMG_3002.jpg');
  });

  it('leaves an ordinary filename alone', () => {
    expect(editedSuffixOf('IMG_1234.jpg')).toBeNull();
    expect(editedSuffixOf('IMG_1234(1).jpg')).toBeNull();
    // A word that merely ends in a suffix-like token is not the suffix: no hyphen, no match.
    expect(editedSuffixOf('unedited.jpg')).toBeNull();
    // Nothing left to be a base of.
    expect(editedSuffixOf('-edited.jpg')).toBeNull();
  });

  it('splits a filename at its last dot, not its first', () => {
    // Pairing's basenameOf cuts at the first dot to look past a sidecar's doubled extension.
    // Here both sides are media filenames, so the stem has to keep its own dots.
    expect(splitExtension('holiday.beach.jpg')).toEqual({ stem: 'holiday.beach', ext: 'jpg' });
    expect(splitExtension('IMG_2001.MOV')).toEqual({ stem: 'IMG_2001', ext: 'MOV' });
    expect(splitExtension('noextension')).toEqual({ stem: 'noextension', ext: '' });
  });
});

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

describe('the fixture corpus', () => {
  it('gives every media fixture exactly one kind', () => {
    const paths = TAKEOUT_CORPUS.media.map(logicalPath).sort();
    expect([...linked.kindBySourcePath.keys()].sort()).toEqual(paths);
  });

  for (const fixture of TAKEOUT_CORPUS.media) {
    it(`links ${fixture.id} exactly as the fixture declares`, () => {
      const sourcePath = logicalPath(fixture);
      const kind = linked.kindBySourcePath.get(sourcePath);

      expect(kind).toBe(fixture.expect.kind);
      expect(kind !== undefined && excludedFromTimeline(kind)).toBe(
        fixture.expect.excludedFromTimeline,
      );

      expect(linked.variantBaseBySourcePath.get(sourcePath) ?? null).toBe(
        fixture.expect.variantOf === null ? null : pathOfId(fixture.expect.variantOf),
      );
      expect(linked.livePairBySourcePath.get(sourcePath) ?? null).toBe(
        fixture.expect.livePairOf === null ? null : pathOfId(fixture.expect.livePairOf),
      );
    });
  }

  it('never claims a relationship the corpus does not declare', () => {
    const declaredVariants = TAKEOUT_CORPUS.media.filter(
      (fixture) => fixture.expect.variantOf !== null,
    );
    expect(linked.variants.map((link) => link.variant.sourcePath).sort()).toEqual(
      declaredVariants.map(logicalPath).sort(),
    );

    const declaredMotion = TAKEOUT_CORPUS.media.filter(
      (fixture) => fixture.expect.kind === AssetKind.MotionComponent,
    );
    expect(linked.livePairs.map((pair) => pair.motion.sourcePath).sort()).toEqual(
      declaredMotion.map(logicalPath).sort(),
    );

    // Every corpus folder is a folder a correct export would have, so nothing is contested.
    expect(linked.ambiguousLivePairs).toEqual([]);
    expect(linked.unlinkedVariants).toEqual([]);
  });

  /**
   * `bearbeitet-variant` carries its own `.supplemental-metadata.json`, so it pairs by step 1 and
   * is indistinguishable from a base by sidecar evidence alone. The suffix is the rule.
   */
  it('links a variant that has its own sidecar', () => {
    const variantPath = pathOfId('bearbeitet-variant');
    expect(paired.pairingBySourcePath.get(variantPath)?.sidecar.name).toBe(
      'IMG_3001-bearbeitet.jpg.supplemental-metadata.json',
    );
    expect(linked.variantBaseBySourcePath.get(variantPath)).toBe(pathOfId('bearbeitet-base'));
  });

  it('lets one base carry two variants', () => {
    const base = pathOfId('localized-base');
    const variantsOfBase = linked.variants
      .filter((link) => link.base.sourcePath === base)
      .map((link) => link.variant.sourcePath)
      .sort();
    expect(variantsOfBase).toEqual([pathOfId('editado-variant'), pathOfId('modifie-variant')]);
    // A base is never itself a variant.
    expect(linked.variantBaseBySourcePath.has(base)).toBe(false);
  });

  it('matches every corpus variant by name rather than by stem', () => {
    // Google kept the extension in all four corpus renders, so step 2 must not be doing the work
    // here; a linker that reached step 2 would also link things step 1 refuses.
    expect(linked.variants.map((link) => link.matchedBy)).toEqual(
      linked.variants.map(() => VariantMatch.SameName),
    );
  });

  it('makes the MOV a motion component and links the pair symmetrically', () => {
    const still = pathOfId('live-photo-still');
    const motion = pathOfId('live-photo-motion');

    expect(linked.kindBySourcePath.get(motion)).toBe(AssetKind.MotionComponent);
    expect(linked.kindBySourcePath.get(still)).toBe(AssetKind.Image);
    expect(linked.livePairBySourcePath.get(still)).toBe(motion);
    expect(linked.livePairBySourcePath.get(motion)).toBe(still);

    const pair = linked.livePairs.find((entry) => entry.motion.sourcePath === motion);
    expect(pair?.still.sourcePath).toBe(still);
    expect(pair?.stem).toBe('IMG_2001');
    // Corroborated: the MOV reached the still's sidecar through pairing step 4.
    expect(pair?.sidecarShared).toBe(true);
  });

  /**
   * Traversal cannot classify a motion component, because it would have to know a same-stem still
   * exists in the merged folder. That handoff is the reason `classifyFileName` never returns
   * `MotionComponent`, and it is worth pinning: if traversal ever starts guessing, the two modules
   * disagree about what a `.MOV` is.
   */
  it('is the only module that produces MotionComponent', () => {
    for (const file of full.media) {
      expect(file.mediaKind).not.toBe(AssetKind.MotionComponent);
    }
    expect([...linked.kindBySourcePath.values()]).toContain(AssetKind.MotionComponent);
  });

  it('leaves a video that no still claims visible in the timeline', () => {
    const video = pathOfId('unpaired-video');
    expect(linked.kindBySourcePath.get(video)).toBe(AssetKind.Video);
    expect(excludedFromTimeline(AssetKind.Video)).toBe(false);
    expect(linked.livePairBySourcePath.has(video)).toBe(false);
  });

  /** Pairing is corroboration, not a precondition: a pair with no sidecar at all is still a pair. */
  it('finds the same pairs without pairing information, minus the corroboration', () => {
    const withoutPairing = linkExport(full);
    expect([...withoutPairing.livePairBySourcePath.entries()].sort()).toEqual(
      [...linked.livePairBySourcePath.entries()].sort(),
    );
    expect(withoutPairing.livePairs.map((pair) => pair.sidecarShared)).toEqual([false]);
  });
});

// ---------------------------------------------------------------------------
// Shapes the corpus does not contain
// ---------------------------------------------------------------------------

describe('shapes a correct export does not have', () => {
  it('links across a changed extension when exactly one same-kind base has the stem', () => {
    // Google renders an edited HEIC as a JPEG, so the extensions genuinely differ.
    const result = linkFolder(syntheticFolder(['IMG_9.HEIC', 'IMG_9-edited.jpg']));
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0]?.base.name).toBe('IMG_9.HEIC');
    expect(result.variants[0]?.matchedBy).toBe(VariantMatch.SameStem);
  });

  it('does not offer a Live Photo MOV as the base of an edited still', () => {
    const result = linkFolder(syntheticFolder(['IMG_9.HEIC', 'IMG_9.MOV', 'IMG_9-edited.jpg']));
    expect(result.variants[0]?.base.name).toBe('IMG_9.HEIC');
    expect(result.unlinkedVariants).toEqual([]);
  });

  it('refuses to choose between two same-stem bases', () => {
    const result = linkFolder(syntheticFolder(['IMG_9.HEIC', 'IMG_9.png', 'IMG_9-edited.jpg']));
    expect(result.variants).toEqual([]);
    expect(result.unlinkedVariants[0]?.reason).toBe(UnlinkedVariantReason.AmbiguousBase);
    expect(result.unlinkedVariants[0]?.candidates).toEqual(['IMG_9.HEIC', 'IMG_9.png']);
  });

  it('reports a render whose base was never exported', () => {
    const result = linkFolder(syntheticFolder(['IMG_9-edited.jpg']));
    expect(result.variants).toEqual([]);
    expect(result.unlinkedVariants[0]?.reason).toBe(UnlinkedVariantReason.NoBase);
    // Still an asset, still in the timeline: unlinked is not dropped.
    expect(result.kindBySourcePath.get(syntheticPath('IMG_9-edited.jpg'))).toBe(AssetKind.Image);
  });

  it('never makes a variant the base of another variant', () => {
    const result = linkFolder(syntheticFolder(['IMG_9-edited.jpg', 'IMG_9-edited-edited.jpg']));
    expect(result.variants).toEqual([]);
    expect(result.unlinkedVariants).toHaveLength(2);
  });

  it('refuses a stem with two stills when no sidecar says which', () => {
    const result = linkFolder(syntheticFolder(['IMG_9.HEIC', 'IMG_9.jpg', 'IMG_9.MOV']));
    expect(result.livePairs).toEqual([]);
    expect(result.ambiguousLivePairs[0]?.stills).toEqual(['IMG_9.HEIC', 'IMG_9.jpg']);
    // Nothing is hidden from the timeline on a guess.
    expect(result.kindBySourcePath.get(syntheticPath('IMG_9.MOV'))).toBe(AssetKind.Video);
  });

  it('breaks that tie with the sidecar the MOV shares', () => {
    // One sidecar, named after the HEIC. Pairing gives the HEIC exclusive ownership by step 1 and
    // hands the same sidecar to `IMG_9.jpg` and `IMG_9.MOV` as step-4 shares, so the owner is the
    // only still the MOV can be said to be about.
    const folder = syntheticFolder(['IMG_9.HEIC', 'IMG_9.jpg', 'IMG_9.MOV', 'IMG_9.HEIC.json']);
    const folderPairing = pairFolder(folder);
    expect(folderPairing.pairingBySourcePath.get(syntheticPath('IMG_9.MOV'))?.shared).toBe(true);

    // Without the sidecar there is nothing to break the tie with, and nothing is linked.
    expect(linkFolder(folder).livePairs).toEqual([]);

    const result = linkFolder(folder, { pairing: folderPairing });
    expect(result.livePairs).toHaveLength(1);
    expect(result.livePairs[0]?.still.name).toBe('IMG_9.HEIC');
    expect(result.livePairs[0]?.sidecarShared).toBe(true);
    expect(result.kindBySourcePath.get(syntheticPath('IMG_9.jpg'))).toBe(AssetKind.Image);
  });

  it('does not treat an mp4 beside a same-stem photo as a Live Photo', () => {
    // Android's embedded motion photos are design open question 3; separate-file mp4 pairs are
    // not decided here, and an ordinary video must not be hidden from the timeline meanwhile.
    const result = linkFolder(syntheticFolder(['VID_1.jpg', 'VID_1.mp4']));
    expect(result.livePairs).toEqual([]);
    expect(result.kindBySourcePath.get(syntheticPath('VID_1.mp4'))).toBe(AssetKind.Video);
  });
});

// ---------------------------------------------------------------------------
// Resolving relationships to hashes
// ---------------------------------------------------------------------------

describe('resolving relationships to hashes', () => {
  /** A hash per source path, deterministic and distinct, standing in for the Hash stage. */
  function hashesFor(
    links: LinkResult,
    overrides: Readonly<Record<string, string | null>> = {},
  ): (sourcePath: string) => string | null {
    const hashes = new Map<string, string | null>();
    let index = 0;
    for (const sourcePath of links.kindBySourcePath.keys()) {
      index += 1;
      hashes.set(sourcePath, `hash${index.toString().padStart(4, '0')}`);
    }
    for (const [sourcePath, hash] of Object.entries(overrides)) {
      hashes.set(sourcePath, hash);
    }
    return (sourcePath: string): string | null => hashes.get(sourcePath) ?? null;
  }

  it('writes both columns for every corpus relationship', () => {
    const hashOf = hashesFor(linked);
    const resolved = resolveLinkHashes(linked, hashOf);

    expect(resolved.unresolved).toEqual([]);
    expect(resolved.assets).toHaveLength(TAKEOUT_CORPUS.media.length);

    for (const fixture of TAKEOUT_CORPUS.media) {
      const row = resolved.assets.find((asset) => asset.sourcePath === logicalPath(fixture));
      expect(row?.kind).toBe(fixture.expect.kind);
      expect(row?.variantOfHash ?? null).toBe(
        fixture.expect.variantOf === null ? null : hashOf(pathOfId(fixture.expect.variantOf)),
      );
      expect(row?.livePairHash ?? null).toBe(
        fixture.expect.livePairOf === null ? null : hashOf(pathOfId(fixture.expect.livePairOf)),
      );
    }
  });

  it('leaves the column null and reports it when the counterpart was never hashed', () => {
    const basePath = pathOfId('edited-base');
    const resolved = resolveLinkHashes(linked, hashesFor(linked, { [basePath]: null }));

    const variant = resolved.assets.find(
      (asset) => asset.sourcePath === pathOfId('edited-variant'),
    );
    expect(variant?.variantOfHash).toBeNull();
    expect(
      resolved.unresolved.some(
        (entry) =>
          entry.sourcePath === pathOfId('edited-variant') &&
          entry.relation === LinkRelation.VariantOf &&
          entry.counterpartSourcePath === basePath,
      ),
    ).toBe(true);
  });

  /**
   * Content addressing is the dedupe boundary, so a render byte-identical to its base *is* its
   * base — one asset. Writing the link would make that row a variant of itself.
   */
  it('drops a self-link when the counterpart deduplicated into the same asset', () => {
    const variantPath = pathOfId('edited-variant');
    const basePath = pathOfId('edited-base');
    const resolved = resolveLinkHashes(
      linked,
      hashesFor(linked, { [variantPath]: 'same', [basePath]: 'same' }),
    );

    const variant = resolved.assets.find((asset) => asset.sourcePath === variantPath);
    expect(variant?.variantOfHash).toBeNull();
    expect(resolved.unresolved.find((entry) => entry.sourcePath === variantPath)?.reason).toContain(
      'same asset',
    );
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/**
 * Filenames whose *combinations* are what produce the interesting cases: a stem with a base, a
 * render, a localized render, a still, and a MOV, plus an ordinary video and a second stem.
 */
const MEDIA_POOL: readonly string[] = [
  'IMG_1.jpg',
  'IMG_1.HEIC',
  'IMG_1.MOV',
  'IMG_1-edited.jpg',
  'IMG_1-edited.HEIC',
  'IMG_1-bearbeitet.jpg',
  'IMG_2.jpg',
  'IMG_2.MOV',
  'IMG_2-modifié.jpg',
  'VID_1.mp4',
  '-edited.jpg',
];

describe('linking invariants', () => {
  /**
   * **Validates: Requirements 1.5, 1.6** — a variant is a separate asset pointing at its base, a
   * Live Photo is one logical asset with the MOV hidden, and nothing is dropped or invented.
   *
   * A fixed example cannot establish these, because the failures come from *combinations* of
   * filenames in one folder and the corpus only contains combinations a correct export has. Five
   * clauses, each of which a plausible wrong linker violates:
   *
   * - every media file gets exactly one kind (nothing dropped, nothing counted twice);
   * - `MotionComponent` is given only to the MOV half of a pair, so no ordinary video is hidden
   *   from the timeline;
   * - the live-pair map is symmetric and an involution, since `live_pair_hash` is written on both
   *   halves and a pair has exactly two members;
   * - a variant's base exists in the folder, is not itself a variant, and is never the variant
   *   itself — the relationship is a single hop and acyclic;
   * - a variant is either linked or reported, never silently neither.
   */
  it('keeps kinds, pairs, and variant links well formed for any folder', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MEDIA_POOL), { minLength: 1, maxLength: 7 }),
        (names) => {
          const folder = syntheticFolder(names);
          const result = linkFolder(folder);

          // One kind per media file, and nothing invented.
          expect([...result.kindBySourcePath.keys()].sort()).toEqual(
            folder.media.map((file) => file.sourcePath).sort(),
          );

          const motionPaths = new Set(result.livePairs.map((pair) => pair.motion.sourcePath));
          for (const [sourcePath, kind] of result.kindBySourcePath) {
            expect(kind === AssetKind.MotionComponent).toBe(motionPaths.has(sourcePath));
          }

          // Symmetric, and an involution: following the link twice returns to the start.
          for (const [sourcePath, counterpart] of result.livePairBySourcePath) {
            expect(result.livePairBySourcePath.get(counterpart)).toBe(sourcePath);
            expect(counterpart).not.toBe(sourcePath);
          }
          expect(result.livePairBySourcePath.size).toBe(result.livePairs.length * 2);

          const mediaPaths = new Set(folder.media.map((file) => file.sourcePath));
          for (const link of result.variants) {
            expect(mediaPaths.has(link.base.sourcePath)).toBe(true);
            expect(link.base.sourcePath).not.toBe(link.variant.sourcePath);
            expect(editedSuffixOf(link.base.name)).toBeNull();
            // A base is never itself a variant, so the chain cannot be longer than one hop.
            expect(result.variantBaseBySourcePath.has(link.base.sourcePath)).toBe(false);
          }

          // Every file the table recognizes is either linked or reported.
          const accounted = new Set([
            ...result.variants.map((link) => link.variant.sourcePath),
            ...result.unlinkedVariants.map((entry) => entry.media.sourcePath),
          ]);
          for (const file of folder.media) {
            if (editedSuffixOf(file.name) !== null) {
              expect(accounted.has(file.sourcePath)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * Takeout splits an export on size alone, so the order a filename reaches a folder view is
   * arbitrary. A linker whose answer depends on it would link differently on a re-download of the
   * same library.
   */
  it('does not depend on the order the folder was assembled in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MEDIA_POOL), { minLength: 1, maxLength: 7 }),
        (names) => {
          const summarize = (result: LinkResult): readonly string[] =>
            [
              ...result.variants.map(
                (link) => `${link.variant.name} variantOf ${link.base.name} (${link.matchedBy})`,
              ),
              ...result.unlinkedVariants.map((entry) => `${entry.media.name} ${entry.reason}`),
              ...result.livePairs.map((pair) => `${pair.motion.name} pairs ${pair.still.name}`),
              ...result.ambiguousLivePairs.map((entry) => `${entry.stem} ambiguous`),
              ...[...result.kindBySourcePath].map(
                ([sourcePath, kind]) => `${sourcePath} kind ${kind.toString()}`,
              ),
            ].sort();

          expect(summarize(linkFolder(syntheticFolder([...names].reverse())))).toEqual(
            summarize(linkFolder(syntheticFolder(names))),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
