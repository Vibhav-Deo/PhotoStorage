/**
 * Sidecar pairing against the fixture corpus (task 2.3, Requirements 1.4 and 1.10).
 *
 * The corpus is the input, and its declared expectations are the oracle: every fixture states
 * the sidecar it must pair with **and the step that must produce the pairing**, so a resolver
 * that gets the right sidecar by the wrong step fails here rather than passing quietly until a
 * later change moves it off the step it was accidentally relying on. `corpus.test.ts` has
 * already proved each of those expectations is structurally reachable and not preempted by an
 * earlier step, so a failure in this file is a resolver failure and not a manifest failure.
 *
 * Two shapes the corpus deliberately does not contain — because they are not shapes a *correct*
 * export has — are built as synthetic folders instead: a sidecar two media filenames would own
 * with equal standing, and a basename that matches several sidecars. Both are cases where the
 * export contradicts itself, and what matters is that pairing refuses to guess and says so.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildCorpus } from './fixtures/buildCorpus.ts';
import { PART_001, PART_002, PART_003, TAKEOUT_CORPUS, fixtureById } from './fixtures/corpus.ts';
import type { MediaFixture } from './fixtures/corpusTypes.ts';
import { PairingStep, UnpairedReason, pairExport, pairFolder, resolveSidecar } from './pairing.ts';
import type { PairingResult, SidecarPairing } from './pairing.ts';
import { TakeoutFileKind, classifyFileName, traverseExport } from './traversal.ts';
import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

const PARTS = [PART_001, PART_002, PART_003] as const;

let root: string;
/** The whole corpus, all three parts, paired. */
let paired: PairingResult;
let full: TakeoutExport;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'takeout-pairing-'));
  await buildCorpus(root);
  full = await traverseExport(PARTS.map((part) => path.join(root, part)));
  paired = pairExport(full);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The logical path a fixture's media occupies, which is also its source path. */
function logicalPath(fixture: MediaFixture): string {
  return nfc(`${fixture.folder}/${fixture.file}`);
}

function pairingFor(fixture: MediaFixture): SidecarPairing | undefined {
  return paired.pairingBySourcePath.get(logicalPath(fixture));
}

// ---------------------------------------------------------------------------
// Synthetic folders, for export shapes that contradict themselves
// ---------------------------------------------------------------------------

const SYNTHETIC_PART = 'takeout-p-001';
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
 * Pairing reads nothing but filenames, so a folder can be stated rather than materialized —
 * which is what makes the property test below able to run hundreds of arrangements.
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

// ---------------------------------------------------------------------------
// The four steps, filename by filename
// ---------------------------------------------------------------------------

describe('the four-step resolution order', () => {
  it('probes both exact spellings, and treats supplemental-metadata as exact', () => {
    expect(resolveSidecar('IMG_1.jpg', ['IMG_1.jpg.json']).candidate).toEqual({
      sidecar: 'IMG_1.jpg.json',
      step: PairingStep.Exact,
    });
    expect(resolveSidecar('IMG_1.jpg', ['IMG_1.jpg.supplemental-metadata.json']).candidate).toEqual(
      {
        sidecar: 'IMG_1.jpg.supplemental-metadata.json',
        step: PairingStep.Exact,
      },
    );
    // The plain spelling is probed first, so it wins when Takeout emitted both.
    expect(
      resolveSidecar('IMG_1.jpg', ['IMG_1.jpg.supplemental-metadata.json', 'IMG_1.jpg.json'])
        .candidate?.sidecar,
    ).toBe('IMG_1.jpg.json');
  });

  it('takes the longest truncated prefix, not merely a matching one', () => {
    const sidecars = ['holiday_in.json', 'holiday_in_iceland_ring_ro.json', 'unrelated.json'];
    expect(resolveSidecar('holiday_in_iceland_ring_road.jpg', sidecars).candidate).toEqual({
      sidecar: 'holiday_in_iceland_ring_ro.json',
      step: PairingStep.Truncated,
    });
  });

  it('swaps the disambiguator behind the media extension', () => {
    expect(resolveSidecar('IMG_1234(1).jpg', ['IMG_1234.jpg(1).json']).candidate).toEqual({
      sidecar: 'IMG_1234.jpg(1).json',
      step: PairingStep.DisambiguatorSwap,
    });
    // Parentheses that are not a disambiguator must not reach step 3.
    expect(resolveSidecar('party(final).jpg', ['party.jpg(1).json']).candidate).toBeNull();
  });

  it('falls back to a basename match only when it is unique in the folder', () => {
    expect(resolveSidecar('IMG_0042.JPG', ['IMG_0042.jpg.json']).candidate).toEqual({
      sidecar: 'IMG_0042.jpg.json',
      step: PairingStep.UniqueBasename,
    });

    const ambiguous = resolveSidecar('IMG_0042.MOV', ['IMG_0042.jpg.json', 'IMG_0042.HEIC.json']);
    expect(ambiguous.candidate).toBeNull();
    expect(ambiguous.ambiguousBasenameMatches).toEqual(['IMG_0042.HEIC.json', 'IMG_0042.jpg.json']);
  });

  it('never guesses past a case difference before step 4', () => {
    // `IMG_0042.jpg` is not a prefix of `IMG_0042.JPG`, and the exact probe is byte-exact.
    const resolution = resolveSidecar('IMG_0042.JPG', ['IMG_0042.jpg.json', 'IMG_9.jpg.json']);
    expect(resolution.candidate?.step).toBe(PairingStep.UniqueBasename);
  });

  it('reports no candidate rather than reaching for something plausible', () => {
    const resolution = resolveSidecar('IMG_2002-edited.jpg', ['IMG_2002.jpg.json']);
    expect(resolution.candidate).toBeNull();
    expect(resolution.ambiguousBasenameMatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Against the corpus
// ---------------------------------------------------------------------------

describe('pairing the fixture corpus', () => {
  it('pairs every fixture with the sidecar it declares, by the step it declares', () => {
    const problems: string[] = [];

    for (const fixture of TAKEOUT_CORPUS.media) {
      const expected = fixture.expect.sidecarFile;
      const pairing = pairingFor(fixture);

      if (expected === null) {
        if (pairing !== undefined) {
          problems.push(`${fixture.id}: declared unpaired, paired with ${pairing.sidecar.name}`);
        }
        continue;
      }
      if (pairing === undefined) {
        problems.push(`${fixture.id}: expected ${expected}, got no pairing at all`);
        continue;
      }
      if (nfc(pairing.sidecar.name) !== nfc(expected)) {
        problems.push(`${fixture.id}: expected ${expected}, paired with ${pairing.sidecar.name}`);
      }
      if (pairing.step !== fixture.expect.pairingStep) {
        problems.push(
          `${fixture.id}: paired by ${pairing.step}, declared ${String(fixture.expect.pairingStep)}`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('accounts for every media file exactly once, paired or reported', () => {
    expect(paired.pairings.length + paired.unpaired.length).toBe(full.media.length);
    expect(full.media.length).toBe(TAKEOUT_CORPUS.media.length);

    const seen = [
      ...paired.pairings.map((pairing) => pairing.media.sourcePath),
      ...paired.unpaired.map((entry) => entry.media.sourcePath),
    ];
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual(full.media.map((file) => file.sourcePath).sort());
  });

  it('reports every unpaired fixture with a reason instead of dropping it', () => {
    const declaredUnpaired = TAKEOUT_CORPUS.media.filter((f) => f.expect.sidecarFile === null);
    expect(declaredUnpaired.length).toBeGreaterThan(0);

    const byPath = new Map(paired.unpaired.map((entry) => [entry.media.sourcePath, entry]));
    const problems: string[] = [];

    for (const fixture of declaredUnpaired) {
      const entry = byPath.get(logicalPath(fixture));
      if (entry === undefined) {
        problems.push(`${fixture.id}: not reported as unpaired`);
        continue;
      }
      if (entry.reason !== UnpairedReason.NoCandidate) {
        problems.push(`${fixture.id}: reported as ${entry.reason}`);
      }
      if (entry.detail.length === 0) {
        problems.push(`${fixture.id}: reported with no detail for the report`);
      }
    }

    expect(problems).toEqual([]);
    expect(paired.unpaired.length).toBe(declaredUnpaired.length);
  });

  it('holds the adversarial (n) case apart: neither photo takes the other metadata', () => {
    const plain = fixtureById('exact-sidecar');
    const disambiguated = fixtureById('disambiguator-swap');
    expect(plain).toBeDefined();
    expect(disambiguated).toBeDefined();
    if (plain === undefined || disambiguated === undefined) return;

    // Same folder, four seconds apart, and the sidecars carry the `(n)` in the other position.
    expect(plain.folder).toBe(disambiguated.folder);
    expect(pairingFor(plain)?.sidecar.name).toBe('IMG_1234.jpg.json');
    expect(pairingFor(plain)?.step).toBe(PairingStep.Exact);
    expect(pairingFor(disambiguated)?.sidecar.name).toBe('IMG_1234.jpg(1).json');
    expect(pairingFor(disambiguated)?.step).toBe(PairingStep.DisambiguatorSwap);
  });

  it("lets the Live Photo MOV share the still's sidecar, with the still owning it", () => {
    const still = fixtureById('live-photo-still');
    const motion = fixtureById('live-photo-motion');
    expect(still).toBeDefined();
    expect(motion).toBeDefined();
    if (still === undefined || motion === undefined) return;

    const stillPairing = pairingFor(still);
    const motionPairing = pairingFor(motion);

    expect(stillPairing?.sidecar.name).toBe('IMG_2001.HEIC.supplemental-metadata.json');
    expect(stillPairing?.shared).toBe(false);
    // One sidecar, named after the still, reached by the MOV through step 4.
    expect(motionPairing?.sidecar.name).toBe(stillPairing?.sidecar.name);
    expect(motionPairing?.step).toBe(PairingStep.UniqueBasename);
    expect(motionPairing?.shared).toBe(true);

    // The share is the only one in a correct export; everything else owns its sidecar.
    expect(paired.pairings.filter((pairing) => pairing.shared).length).toBe(1);
  });

  it('finds no contested and no unclaimed sidecar in an export that agrees with itself', () => {
    expect(paired.contests).toEqual([]);
    expect(paired.unclaimedSidecars).toEqual([]);
  });

  it('pairs across parts, and only across parts', async () => {
    const fixture = fixtureById('cross-part-sidecar');
    expect(fixture).toBeDefined();
    if (fixture === undefined) return;

    expect(pairingFor(fixture)?.sidecar.name).toBe('IMG_7777.jpg.json');
    expect(pairingFor(fixture)?.step).toBe(PairingStep.Exact);
    // Its sidecar is in part 002, so its own part cannot pair it — the failure this fixture
    // exists to make visible, and the reason pairing consumes a merged folder view.
    const alone = pairExport(await traverseExport([path.join(root, PART_003)]));
    const unpaired = alone.unpaired.find((entry) => entry.media.name === fixture.file);
    expect(unpaired?.reason).toBe(UnpairedReason.NoCandidate);
  });
});

// ---------------------------------------------------------------------------
// Exports that contradict themselves
// ---------------------------------------------------------------------------

describe('sidecars two media files would own', () => {
  it('refuses to choose between two truncated prefixes of one sidecar', () => {
    // `IMG_1234` is a prefix of both filenames, so step 2 selects the same sidecar twice.
    const result = pairFolder(syntheticFolder(['IMG_1234.jpg', 'IMG_1234.HEIC', 'IMG_1234.json']));

    expect(result.pairings).toEqual([]);
    expect(result.unpaired.map((entry) => entry.reason)).toEqual([
      UnpairedReason.ContestedSidecar,
      UnpairedReason.ContestedSidecar,
    ]);
    expect(result.contests).toHaveLength(1);
    expect(result.contests[0]?.sidecar.name).toBe('IMG_1234.json');
    expect(result.contests[0]?.claimants.map((claim) => claim.media.name).sort()).toEqual([
      'IMG_1234.HEIC',
      'IMG_1234.jpg',
    ]);
    // The reason names the rival, so the report can explain the decision.
    expect(result.unpaired[0]?.detail).toContain('IMG_1234');
  });

  it('refuses a basename match with nothing to anchor which media it describes', () => {
    // Two videos, one sidecar named after a still that is not in the export. Either could be
    // its subject and neither can be shown to be, so nothing is paired.
    const result = pairFolder(
      syntheticFolder(['IMG_9.MOV', 'IMG_9.mp4', 'IMG_9.HEIC.supplemental-metadata.json']),
    );

    expect(result.pairings).toEqual([]);
    expect(result.contests).toHaveLength(1);
    expect(new Set(result.unpaired.map((entry) => entry.reason))).toEqual(
      new Set([UnpairedReason.ContestedSidecar]),
    );
  });

  it('reports an ambiguous basename separately from having nothing to pair with', () => {
    const result = pairFolder(
      syntheticFolder(['IMG_9.MOV', 'IMG_9.HEIC.json', 'IMG_9.jpg.json', 'VID_1.mp4']),
    );

    const byName = new Map(result.unpaired.map((entry) => [entry.media.name, entry]));
    expect(byName.get('IMG_9.MOV')?.reason).toBe(UnpairedReason.AmbiguousBasename);
    expect(byName.get('IMG_9.MOV')?.candidates).toEqual(['IMG_9.HEIC.json', 'IMG_9.jpg.json']);
    expect(byName.get('VID_1.mp4')?.reason).toBe(UnpairedReason.NoCandidate);
  });

  it('reports a sidecar whose media never arrived', () => {
    const result = pairFolder(syntheticFolder(['IMG_1.jpg', 'IMG_1.jpg.json', 'IMG_2.jpg.json']));

    expect(result.pairings.map((pairing) => pairing.sidecar.name)).toEqual(['IMG_1.jpg.json']);
    expect(result.unclaimedSidecars.map((file) => file.name)).toEqual(['IMG_2.jpg.json']);
  });

  it('treats several copies of one filename as one claim, not as a contest', () => {
    // Traversal keeps every copy of a path whose parts disagree about its size. Those are
    // candidate byte-streams for one logical file, and the sidecar describes all of them.
    const folder = syntheticFolder(['IMG_1.jpg', 'IMG_1.jpg.json']);
    const media = folder.media[0];
    expect(media).toBeDefined();
    if (media === undefined) return;

    const secondCopy: TakeoutFile = {
      ...media,
      part: 'takeout-p-002',
      byteSize: media.byteSize + 1,
      sourcePath: `takeout-p-002/${media.path}`,
    };
    const withConflict: TakeoutFolder = {
      ...folder,
      parts: [SYNTHETIC_PART, 'takeout-p-002'],
      media: [media, secondCopy],
    };

    const result = pairFolder(withConflict);
    expect(result.contests).toEqual([]);
    expect(result.unpaired).toEqual([]);
    expect(result.pairings.map((pairing) => pairing.shared)).toEqual([false, false]);
    expect(result.pairingBySourcePath.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

/**
 * Filenames chosen so that every step, and every way two media files can reach for one sidecar,
 * is reachable from a subset of these two pools. Written out literally rather than derived by a
 * helper, for the reason the corpus gives: a generator that builds `IMG_1234.jpg(1).json` from
 * `IMG_1234(1).jpg` encodes the rule under test.
 */
const MEDIA_POOL: readonly string[] = [
  'IMG_1234.jpg',
  'IMG_1234(1).jpg',
  'IMG_1234.HEIC',
  'IMG_1234.MOV',
  'IMG_0042.JPG',
  'IMG_2001.HEIC',
  'IMG_2001.MOV',
  'IMG_2001-edited.jpg',
  'clip_from_the_long_summer_holiday_in_iceland.mp4',
];

const SIDECAR_POOL: readonly string[] = [
  'IMG_1234.jpg.json',
  'IMG_1234.jpg(1).json',
  'IMG_1234.jp.json',
  'IMG_1234.json',
  'IMG_1234.HEIC.supplemental-metadata.json',
  'IMG_0042.jpg.json',
  'IMG_2001.HEIC.supplemental-metadata.json',
  'IMG_2001.other.json',
  'clip_from_the_long_summer_holiday_in_icela.json',
  'IMG_9999.jpg.json',
];

describe('pairing invariants', () => {
  /**
   * **Validates: Requirements 1.4, 1.10** — sidecars pair with the media file they belong to,
   * and every media file is accounted for.
   *
   * The property is what "belongs to" means once a whole folder is in view: **a sidecar has at
   * most one owner**. Google emits one sidecar per photo, so two media files owning one is
   * always an error, and it is the error that matters, because the consequence is one photo's
   * capture time, location, and people silently attached to another. A fixed example cannot
   * establish this — the contests come from *combinations* of filenames, and the corpus contains
   * only combinations a correct export has.
   *
   * Three clauses come with it, because the headline clause alone is satisfied by a resolver
   * that pairs nothing: every media file appears exactly once across paired and unpaired
   * (Requirement 1.10, nothing dropped), no pairing names a sidecar that is not in the folder,
   * and the one legitimate way a sidecar is referenced twice — a step-4 share of a sidecar
   * another file owns, which is the Live Photo case — is marked as such and never happens
   * without an owner.
   */
  it('never lets two media files own one sidecar, and never drops a file', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MEDIA_POOL), { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(fc.constantFrom(...SIDECAR_POOL), { maxLength: 6 }),
        (mediaNames, sidecarNames) => {
          const folder = syntheticFolder([...mediaNames, ...sidecarNames]);
          const result = pairFolder(folder);

          // Nothing dropped, nothing counted twice.
          const accounted = [
            ...result.pairings.map((pairing) => pairing.media.sourcePath),
            ...result.unpaired.map((entry) => entry.media.sourcePath),
          ];
          expect([...accounted].sort()).toEqual(folder.media.map((file) => file.sourcePath).sort());

          // Nothing invented.
          for (const pairing of result.pairings) {
            expect(folder.sidecarNames).toContain(pairing.sidecar.name);
          }

          const bySidecar = new Map<string, SidecarPairing[]>();
          for (const pairing of result.pairings) {
            const group = bySidecar.get(pairing.sidecar.name) ?? [];
            group.push(pairing);
            bySidecar.set(pairing.sidecar.name, group);
          }

          for (const [sidecar, group] of bySidecar) {
            const owners = new Set(
              group.filter((pairing) => !pairing.shared).map((pairing) => pairing.media.name),
            );
            // The headline clause: one owner, and a claimed sidecar always has one.
            expect(owners.size, `${sidecar} has ${owners.size.toString()} owners`).toBe(1);

            for (const pairing of group.filter((entry) => entry.shared)) {
              // Sharing is only ever a step-4 reference to someone else's sidecar.
              expect(pairing.step).toBe(PairingStep.UniqueBasename);
              expect(owners.has(pairing.media.name)).toBe(false);
            }
          }

          // A contested sidecar is claimed by two filenames and paired with neither.
          for (const contest of result.contests) {
            const names = new Set(contest.claimants.map((claim) => claim.media.name));
            expect(names.size).toBeGreaterThan(1);
            expect(bySidecar.has(contest.sidecar.name)).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * Pairing must be a function of the folder's contents and not of the order they arrive in.
   * Takeout splits an export on size alone, so the order a filename reaches a folder view is
   * arbitrary, and a resolver whose answer depends on it would pair differently on a
   * re-download of the same library.
   */
  it('does not depend on the order the folder was assembled in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...MEDIA_POOL), { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(fc.constantFrom(...SIDECAR_POOL), { maxLength: 6 }),
        (mediaNames, sidecarNames) => {
          const names = [...mediaNames, ...sidecarNames];
          const forwards = pairFolder(syntheticFolder(names));
          const backwards = pairFolder(syntheticFolder([...names].reverse()));

          const summarize = (result: PairingResult): readonly string[] =>
            [
              ...result.pairings.map(
                (pairing) =>
                  `${pairing.media.name} -> ${pairing.sidecar.name} (${pairing.step}${pairing.shared ? ', shared' : ''})`,
              ),
              ...result.unpaired.map((entry) => `${entry.media.name} -> ${entry.reason}`),
            ].sort();

          expect(summarize(backwards)).toEqual(summarize(forwards));
        },
      ),
      { numRuns: 100 },
    );
  });
});
