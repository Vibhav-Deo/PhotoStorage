/**
 * Sidecar pairing: deciding which JSON describes which media file (task 2.3, Requirements 1.4
 * and 1.10).
 *
 * This is the second half of `TakeoutReader` (design: Importer components). It consumes the
 * merged per-folder view {@link TakeoutFolder} that traversal produced and does not touch the
 * filesystem: pairing is decided entirely from filenames, and re-walking the tree here would
 * both duplicate the I/O of a possibly 2 TB export and reintroduce the per-part view that
 * `cross-part-sidecar` exists to rule out. It does not read a sidecar's contents either —
 * timestamps are task 2.4, variant and Live Photo links are 2.5, albums are 2.6.
 *
 * ## The four steps, and why they are ordered
 *
 * Google emits a sidecar as `<media>.json` or `<media>.supplemental-metadata.json`, truncates
 * the whole sidecar name to roughly 51 characters, and puts `(n)` disambiguators in a different
 * place than the media file does — `IMG_1234(1).jpg` pairs with `IMG_1234.jpg(1).json`. The
 * resolution order is first match wins (design: Sidecar pairing):
 *
 * 1. **Exact** — `{name}.{ext}.json`, then `{name}.{ext}.supplemental-metadata.json`.
 * 2. **Truncated** — the longest sidecar whose stem is a prefix of the media filename.
 * 3. **Disambiguator swap** — `(n)` taken out of the media stem and probed as
 *    `{name}.{ext}({n}).json`.
 * 4. **Unique basename** — one sidecar in the folder whose basename matches the media's.
 *
 * The order is not a preference, it is a strength ranking, and the corpus is built to prove it.
 * `IMG_1234.jpg` and `IMG_1234(1).jpg` sit in one folder with both of their sidecars, so a
 * resolver that reaches step 4 (or matches loosely at step 2) hands `IMG_1234(1).jpg` the other
 * photo's metadata and backdates it by four seconds — wrong, and small enough to survive review.
 * Every probe is therefore **case- and byte-exact** against the merged folder's sidecar names.
 * Step 4 matches on the basename alone and is the only step that bridges a case difference in
 * the extension, which is exactly why it is last.
 *
 * ## Exclusive claims and shared claims
 *
 * Steps 1 to 3 derive the sidecar's name *from* the media filename, so a match is evidence
 * that the sidecar is about that file. Step 4 matches on a basename, which is intrinsically
 * many-to-one: `IMG_2001.HEIC` and `IMG_2001.MOV` are one Live Photo with one sidecar, named
 * after the still. So a sidecar can legitimately be referenced twice, and this module
 * distinguishes the two ways that happens:
 *
 * - **Owned.** At most one media filename per sidecar, established by whichever step matched.
 * - **Shared.** A step-4 reference to a sidecar another media file already owns. This is the
 *   Live Photo case, and it is the right outcome: the motion component gets the real capture
 *   time and sorts with its still instead of landing on the download mtime.
 *
 * When two media files would own one sidecar with equal standing — two truncated prefixes of
 * the same stem, or two basename matches with nothing anchoring which media the sidecar is
 * actually about — the export contradicts itself and this module **refuses to choose**, exactly
 * as traversal refuses to choose between conflicting copies of a path. Both files come back
 * unpaired with {@link UnpairedReason.ContestedSidecar} and the contest is recorded in
 * {@link PairingResult.contests}. Being unpaired is a supported outcome that costs a timestamp
 * and produces a line in the reconciliation report; a wrong pairing silently attaches one
 * photo's metadata, location, and people to another, and nothing downstream can detect it.
 *
 * Several copies of one filename are not a contest. Traversal keeps every copy of a path whose
 * parts disagree about its size, and those are candidate byte-streams for one logical file, so
 * claims are counted per filename rather than per file.
 *
 * ## Nothing is dropped
 *
 * Every media file in the folder comes back exactly once, in {@link PairingResult.pairings} or
 * in {@link PairingResult.unpaired} with a reason (Requirement 1.10). Sidecars that no media
 * file claimed come back too, in {@link PairingResult.unclaimedSidecars}: a sidecar with no
 * media means Takeout exported the metadata and not the bytes, which the user is entitled to
 * hear about. Task 2.12 turns all three into the reconciliation report.
 */

import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';

// ---------------------------------------------------------------------------
// Names Takeout gives sidecars
// ---------------------------------------------------------------------------

/** Every sidecar ends in this. Stripping it gives the stem step 2 compares. */
const JSON_SUFFIX = '.json';

/** The longer of Google's two sidecar spellings, probed second by step 1. */
const SUPPLEMENTAL_SUFFIX = '.supplemental-metadata.json';

/**
 * `(n)` in a media filename, with the extension after it — `IMG_1234(1).jpg`. Anchored and
 * numeric so that a filename which merely contains parentheses does not reach step 3.
 */
const DISAMBIGUATOR_PATTERN = /^(?<stem>.*)\((?<n>\d+)\)\.(?<ext>[^.]+)$/u;

/**
 * Which step paired a sidecar to its media, first match wins (design: Sidecar pairing,
 * Requirement 1.4).
 *
 * Reported rather than discarded because it is what makes a pairing regression diagnosable: a
 * file that still pairs but pairs by a later step means an earlier step stopped matching, which
 * is a bug even though the answer looks right. The fixture corpus declares the expected step
 * for every fixture for that reason.
 */
export const PairingStep = {
  /** `{name}.{ext}.json`, then `{name}.{ext}.supplemental-metadata.json`. */
  Exact: 'exact',
  /** Longest sidecar whose stem is a prefix of the media filename. */
  Truncated: 'truncated',
  /** `(n)` extracted from the media stem, probed as `{name}.{ext}({n}).json`. */
  DisambiguatorSwap: 'disambiguator-swap',
  /** Unique basename match within the same directory. */
  UniqueBasename: 'unique-basename',
} as const;
export type PairingStep = (typeof PairingStep)[keyof typeof PairingStep];

/** Steps whose match is derived from the media filename, and so cannot be shared. */
const EXCLUSIVE_STEPS: ReadonlySet<PairingStep> = new Set([
  PairingStep.Exact,
  PairingStep.Truncated,
  PairingStep.DisambiguatorSwap,
]);

/** Why a media file has no sidecar. Every value is a line in the reconciliation report. */
export const UnpairedReason = {
  /** No step matched anything in the folder. The ordinary case for an `-edited` render. */
  NoCandidate: 'no-candidate',
  /**
   * Step 4 found several sidecars with the media's basename, so the fallback did not match.
   * Distinguished from {@link NoCandidate} because "several plausible sidecars, none provable"
   * is a different thing to look at than "nothing here at all".
   */
  AmbiguousBasename: 'ambiguous-basename',
  /** Another media filename claimed the same sidecar with equal standing; see this module's header. */
  ContestedSidecar: 'contested-sidecar',
} as const;
export type UnpairedReason = (typeof UnpairedReason)[keyof typeof UnpairedReason];

function nfc(value: string): string {
  return value.normalize('NFC');
}

/**
 * The part of a filename before its first dot — what step 4 matches on.
 *
 * The first dot rather than the last, because both sides of the comparison carry extensions
 * that step 4 exists to look past: `IMG_2001.MOV` has to reach `IMG_2001.HEIC.json`, and
 * `IMG_0042.JPG` has to reach `IMG_0042.jpg.json`.
 */
export function basenameOf(fileName: string): string {
  const dot = fileName.indexOf('.');
  return dot === -1 ? fileName : fileName.slice(0, dot);
}

/**
 * A sidecar filename minus `.json` — what step 2 compares against a media filename.
 *
 * Truncation cuts the media extension in half, so this stem is routinely not a filename:
 * `2019-06-08_family_reunion_backyard_barbecue_ph.json` has the stem
 * `2019-06-08_family_reunion_backyard_barbecue_ph`, and only the untruncated `title` inside the
 * JSON names the media in full.
 */
export function sidecarStem(sidecarName: string): string {
  return sidecarName.endsWith(JSON_SUFFIX)
    ? sidecarName.slice(0, -JSON_SUFFIX.length)
    : sidecarName;
}

/** The two names step 1 probes, in the order it probes them. */
export function exactSidecarNames(mediaFileName: string): readonly [string, string] {
  return [`${mediaFileName}${JSON_SUFFIX}`, `${mediaFileName}${SUPPLEMENTAL_SUFFIX}`];
}

/**
 * The step-3 probe for a media filename, or `null` when it carries no `(n)`.
 *
 * `IMG_1234(1).jpg` becomes `IMG_1234.jpg(1).json`: the disambiguator moves behind the media
 * extension, which is where Takeout puts it. Only the plain spelling is probed, as the design
 * specifies — a `.supplemental-metadata` sidecar that also carries a disambiguator is reached
 * by step 4 instead, and inventing a fifth probe here would widen the step that the corpus's
 * adversarial `IMG_1234(1).jpg` fixture exists to keep narrow.
 */
export function disambiguatorProbe(mediaFileName: string): string | null {
  const groups = DISAMBIGUATOR_PATTERN.exec(mediaFileName)?.groups;
  if (groups === undefined) return null;
  const { stem = '', n = '', ext = '' } = groups;
  return `${stem}.${ext}(${n})${JSON_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Resolving one filename
// ---------------------------------------------------------------------------

/** A sidecar the four steps selected, and the step that selected it. */
export interface SidecarCandidate {
  /** Sidecar filename, NFC-normalized, present in the folder that was probed. */
  readonly sidecar: string;
  readonly step: PairingStep;
}

/** What the four steps concluded about one media filename. */
export interface SidecarResolution {
  /** The selected sidecar, or `null` when no step matched. */
  readonly candidate: SidecarCandidate | null;
  /**
   * Sidecars sharing the media's basename when step 4 found several and therefore did not
   * match, sorted. Empty in every other case, including a successful step-4 match.
   */
  readonly ambiguousBasenameMatches: readonly string[];
}

/**
 * Runs the four steps against a folder's sidecar names, first match wins.
 *
 * Filename-level and folder-level, with no notion of the other media in the folder: exclusivity
 * is a separate pass, because whether a match may stand depends on what every other media file
 * selected. Exported for its own tests and because it is the whole rule in one place.
 *
 * @param mediaFileName filename only, not a path.
 * @param sidecarNames every sidecar name in the folder, merged across archive parts — which is
 *   what {@link TakeoutFolder.sidecarNames} is, and why pairing cannot run per part.
 */
export function resolveSidecar(
  mediaFileName: string,
  sidecarNames: readonly string[],
): SidecarResolution {
  const media = nfc(mediaFileName);
  const names = new Set(sidecarNames.map(nfc));

  // Step 1: exact, in Google's two spellings. `.supplemental-metadata.json` is the second probe
  // of this step rather than a fallback: it is just as exact.
  for (const exact of exactSidecarNames(media)) {
    if (names.has(exact)) {
      return {
        candidate: { sidecar: exact, step: PairingStep.Exact },
        ambiguousBasenameMatches: [],
      };
    }
  }

  // Step 2: truncation. The longest prefix wins, and there can be no tie — two prefixes of one
  // string with the same length are the same string.
  let longest: string | null = null;
  let longestStem = '';
  for (const name of names) {
    const stem = sidecarStem(name);
    if (stem.length === 0 || !media.startsWith(stem)) continue;
    if (longest === null || stem.length > longestStem.length) {
      longest = name;
      longestStem = stem;
    }
  }
  if (longest !== null) {
    return {
      candidate: { sidecar: longest, step: PairingStep.Truncated },
      ambiguousBasenameMatches: [],
    };
  }

  // Step 3: the disambiguator moves behind the media extension.
  const probe = disambiguatorProbe(media);
  if (probe !== null && names.has(probe)) {
    return {
      candidate: { sidecar: probe, step: PairingStep.DisambiguatorSwap },
      ambiguousBasenameMatches: [],
    };
  }

  // Step 4: basename alone, and only if it is unambiguous within the folder.
  const basename = basenameOf(media);
  const matches = [...names].filter((name) => basenameOf(name) === basename).sort();
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only !== undefined) {
    return {
      candidate: { sidecar: only, step: PairingStep.UniqueBasename },
      ambiguousBasenameMatches: [],
    };
  }

  return { candidate: null, ambiguousBasenameMatches: matches };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** One media file's reference to a sidecar, and how it got there. */
export interface PairingClaim {
  readonly media: TakeoutFile;
  readonly step: PairingStep;
}

/** A media file paired with the sidecar that describes it. */
export interface SidecarPairing extends PairingClaim {
  readonly sidecar: TakeoutFile;
  /**
   * True when another media filename owns this sidecar and this file references it through step
   * 4 — the Live Photo case, where one sidecar legitimately describes a still and its motion
   * component. False for the owner, and false whenever a file is the sidecar's only claimant.
   */
  readonly shared: boolean;
}

/** A media file with no sidecar. Imported with degraded provenance and reported, never dropped. */
export interface UnpairedMedia {
  readonly media: TakeoutFile;
  readonly reason: UnpairedReason;
  /** One line naming what was considered, for the reconciliation report (task 2.12). */
  readonly detail: string;
  /** Sidecar names involved in the decision, sorted. Empty for {@link UnpairedReason.NoCandidate}. */
  readonly candidates: readonly string[];
}

/** One sidecar that two media filenames would own with equal standing. Nothing was chosen. */
export interface SidecarContest {
  readonly sidecar: TakeoutFile;
  /** Every claim on the sidecar, in folder order. Two or more distinct filenames. */
  readonly claimants: readonly PairingClaim[];
}

/** What pairing concluded about a folder, or about a whole export. */
export interface PairingResult {
  /** Every media file that has a sidecar, in folder order. */
  readonly pairings: readonly SidecarPairing[];
  /** {@link pairings} keyed by {@link TakeoutFile.sourcePath}, which is unique per file. */
  readonly pairingBySourcePath: ReadonlyMap<string, SidecarPairing>;
  /** Every media file that has none, with a reason. */
  readonly unpaired: readonly UnpairedMedia[];
  /** Sidecars no single media filename could be shown to own. */
  readonly contests: readonly SidecarContest[];
  /** Sidecars no media file claimed: metadata whose bytes are missing from the export. */
  readonly unclaimedSidecars: readonly TakeoutFile[];
}

// ---------------------------------------------------------------------------
// Pairing a folder
// ---------------------------------------------------------------------------

interface Claims {
  readonly sidecar: TakeoutFile;
  readonly claims: PairingClaim[];
  /** Distinct media filenames claiming through steps 1 to 3. */
  readonly exclusiveNames: Set<string>;
  /** Distinct media filenames claiming through step 4. */
  readonly weakNames: Set<string>;
}

function describeNames(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(', ');
}

/**
 * Pairs every media file in one merged folder with its sidecar.
 *
 * The folder is the unit because all four steps are folder-scoped — step 4 counts matches
 * within it, and Google never puts a sidecar in a different directory from its media, only in a
 * different archive part, which traversal has already merged away.
 */
export function pairFolder(folder: TakeoutFolder): PairingResult {
  const sidecarByName = new Map<string, TakeoutFile>();
  for (const sidecar of folder.sidecars) {
    // Several copies of one name are copies of one sidecar across parts; the first, which is the
    // earliest part, is the one to read. Traversal has already recorded the collapse.
    if (!sidecarByName.has(sidecar.name)) sidecarByName.set(sidecar.name, sidecar);
  }

  const claimsBySidecar = new Map<string, Claims>();
  const unpaired: UnpairedMedia[] = [];

  for (const media of folder.media) {
    const resolution = resolveSidecar(media.name, folder.sidecarNames);
    const candidate = resolution.candidate;

    if (candidate === null) {
      const ambiguous = resolution.ambiguousBasenameMatches;
      unpaired.push(
        ambiguous.length > 1
          ? {
              media,
              reason: UnpairedReason.AmbiguousBasename,
              detail:
                `${ambiguous.length.toString()} sidecars share the basename ` +
                `${JSON.stringify(basenameOf(media.name))} — ${describeNames(ambiguous)} — so the ` +
                'unique-basename fallback cannot say which describes this file',
              candidates: ambiguous,
            }
          : {
              media,
              reason: UnpairedReason.NoCandidate,
              detail:
                folder.sidecarNames.length === 0
                  ? `no sidecar in ${JSON.stringify(folder.path)} at all`
                  : `no sidecar in ${JSON.stringify(folder.path)} matches any of the four steps`,
              candidates: [],
            },
      );
      continue;
    }

    // The candidate name came out of `folder.sidecarNames`, which traversal derives from
    // `folder.sidecars`, so this lookup resolves.
    const sidecarFile = sidecarByName.get(candidate.sidecar) as TakeoutFile;
    const existing = claimsBySidecar.get(candidate.sidecar);
    const entry: Claims = existing ?? {
      sidecar: sidecarFile,
      claims: [],
      exclusiveNames: new Set<string>(),
      weakNames: new Set<string>(),
    };
    entry.claims.push({ media, step: candidate.step });
    (EXCLUSIVE_STEPS.has(candidate.step) ? entry.exclusiveNames : entry.weakNames).add(media.name);
    if (existing === undefined) claimsBySidecar.set(candidate.sidecar, entry);
  }

  const pairings: SidecarPairing[] = [];
  const contests: SidecarContest[] = [];

  for (const entry of claimsBySidecar.values()) {
    const exclusive = entry.exclusiveNames;
    const weak = entry.weakNames;

    // Two filenames with equal standing: two derived matches, or — with nothing derived to
    // anchor what the sidecar is about — two basename matches. Neither is chosen.
    const contested = exclusive.size > 1 || (exclusive.size === 0 && weak.size > 1);
    if (contested) {
      contests.push({ sidecar: entry.sidecar, claimants: [...entry.claims] });
      for (const claim of entry.claims) {
        const rivals = [...new Set([...exclusive, ...weak])].filter(
          (name) => name !== claim.media.name,
        );
        unpaired.push({
          media: claim.media,
          reason: UnpairedReason.ContestedSidecar,
          detail:
            `${JSON.stringify(entry.sidecar.name)} is claimed with equal standing by ` +
            `${describeNames(rivals)}, so pairing it here would be a guess`,
          candidates: [entry.sidecar.name],
        });
      }
      continue;
    }

    // One owner. Any remaining claim is a step-4 share of it, which is the Live Photo case.
    const ownerName = exclusive.size === 1 ? [...exclusive][0] : [...weak][0];
    for (const claim of entry.claims) {
      pairings.push({
        media: claim.media,
        sidecar: entry.sidecar,
        step: claim.step,
        shared: claim.media.name !== ownerName,
      });
    }
  }

  const byFolderOrder = new Map(folder.media.map((media, index) => [media.sourcePath, index]));
  const order = (file: TakeoutFile): number => byFolderOrder.get(file.sourcePath) ?? 0;
  pairings.sort((a, b) => order(a.media) - order(b.media));
  unpaired.sort((a, b) => order(a.media) - order(b.media));

  const claimedNames = new Set(pairings.map((pairing) => pairing.sidecar.name));
  return {
    pairings,
    pairingBySourcePath: new Map(pairings.map((pairing) => [pairing.media.sourcePath, pairing])),
    unpaired,
    contests,
    unclaimedSidecars: [...sidecarByName.values()].filter(
      (sidecar) => !claimedNames.has(sidecar.name),
    ),
  };
}

/**
 * Pairs every media file in a whole export, folder by folder.
 *
 * Folders arrive from traversal sorted by path and already merged across parts, so the result
 * is deterministic and independent of how Takeout split the export.
 */
export function pairExport(exportSet: TakeoutExport): PairingResult {
  const pairings: SidecarPairing[] = [];
  const unpaired: UnpairedMedia[] = [];
  const contests: SidecarContest[] = [];
  const unclaimedSidecars: TakeoutFile[] = [];

  for (const folder of exportSet.folders) {
    const result = pairFolder(folder);
    pairings.push(...result.pairings);
    unpaired.push(...result.unpaired);
    contests.push(...result.contests);
    unclaimedSidecars.push(...result.unclaimedSidecars);
  }

  return {
    pairings,
    pairingBySourcePath: new Map(pairings.map((pairing) => [pairing.media.sourcePath, pairing])),
    unpaired,
    contests,
    unclaimedSidecars,
  };
}
