/**
 * Variant and Live Photo linking (task 2.5, Requirements 1.5 and 1.6).
 *
 * This is the third and last part of `TakeoutReader` (design: Importer components). It consumes
 * the merged per-folder view traversal produced, plus — as corroboration only — what pairing
 * concluded, and decides three things the design's variants-and-pairs table specifies:
 *
 * - an `-edited` render is **a separate asset** whose `variant_of_hash` points at its base;
 * - a same-stem still and MOV are **one logical Live Photo**, linked through `live_pair_hash`;
 * - the MOV is `kind = motion_component`, so the timeline shows the Live Photo once.
 *
 * Like pairing, this module never touches the filesystem and never reads a sidecar. Both rules
 * are decided from filenames within one merged folder, which is why they can run over a 2 TB
 * export without a second pass over its bytes.
 *
 * ## Relationships are expressed by source path, not by hash
 *
 * `variant_of_hash` and `live_pair_hash` are hashes, and no hash exists yet: hashing is the
 * `Hash` stage and this is metadata repair over filenames, which runs from `ExtractMeta` against
 * a `TakeoutFile`. Waiting for hashes would mean deferring the rules to a stage that no longer
 * has the folder in view — the very thing that makes them decidable.
 *
 * So this module produces the **relationships**, keyed on {@link TakeoutFile.sourcePath}, which
 * is the one identifier that names exactly one file in a logical export (traversal qualifies it
 * with the part name when a path is ambiguous, precisely so this holds). Turning a relationship
 * into a column value is a separate, pure step: {@link resolveLinkHashes} takes a lookup from
 * source path to content hash and emits one {@link AssetLinks} row per media file, which is the
 * shape task 2.11 writes into `assets`. The seam is a function rather than a convention so it is
 * testable now, with a stated lookup, instead of being discovered later inside the pipeline.
 *
 * Two things fall out of that split, and both are real:
 *
 * - **A counterpart may have no hash.** Its `Hash` job may have failed or be queued. The column
 *   stays null and the relationship is reported in {@link ResolvedLinks.unresolved} rather than
 *   being silently forgotten — a variant with a null `variant_of_hash` is an independent asset,
 *   which is a visible wrong answer, so it needs to be visible in the report (Requirement 1.10).
 * - **A counterpart may hash to the same asset.** Content addressing is the dedupe boundary, so
 *   a variant byte-identical to its base *is* its base, one row, and writing `variant_of_hash`
 *   would make that row a variant of itself. The self-link is dropped and reported.
 *
 * ## Variants: what the suffix table can and cannot do
 *
 * The design names four suffixes — `-edited`, `-bearbeitet`, `-modifié`, `-editado` — and
 * {@link EDITED_SUFFIXES} is exactly that list. Google localizes the suffix per account, so the
 * table is inherently incomplete, and it is worth being precise about the failure: an
 * unrecognized suffix means the render is imported as an ordinary independent asset. That shows
 * up as a near-duplicate in the timeline, which is visible and repairable. Guessing instead —
 * treating any `-<word>` tail as a variant — would attach one photo to another as its base, and
 * nothing downstream can detect that. Incomplete and honest beats broad and wrong; adding a
 * locale is one entry in the table.
 *
 * The table is NFC-normalized at load, and so is every filename traversal reports. That is not
 * decoration: `IMG_3002-modifié.jpg` has two Unicode normalizations, which one a directory
 * listing returns is a property of the filesystem rather than of the export, and a table matched
 * against the other form silently stops recognizing the variant — the failure the corpus's
 * `modifie-variant` fixture exists to catch. Both sides of every comparison here are normalized.
 *
 * Finding the base is a two-step strength ranking, the same shape as sidecar pairing:
 *
 * 1. **Same name.** The base stem plus the variant's own extension, byte-exact —
 *    `IMG_2002-edited.jpg` → `IMG_2002.jpg`. Derived from the variant's filename, so a match is
 *    evidence.
 * 2. **Same stem.** One media file of the same kind whose stem is the base stem, when the
 *    extensions differ. Google renders an edited HEIC as a JPEG, so the extensions genuinely do
 *    not always match. Restricted to the same media kind so that a Live Photo's MOV is not
 *    offered as the base of an edited still, and taken **only when it is unique** — several
 *    candidates and nothing to choose between them is a contest, not a decision.
 *
 * A variant is never a base candidate, which is what keeps `IMG_1-edited.jpg` from becoming the
 * base of `IMG_1-edited-edited.jpg`'s sibling and keeps the relationship a single hop.
 *
 * Variant linking is deliberately **independent of sidecars**. The corpus's
 * `bearbeitet-variant` has its own `.supplemental-metadata.json`, so "the file with no sidecar"
 * is not the rule and never was; the suffix is.
 *
 * ## Live Photos: same stem, one still, one MOV
 *
 * The design's table is `IMG_1234.HEIC` + `IMG_1234.MOV`, same stem, and Requirement 1.6 widens
 * the still to HEIC *or* JPG. The stem is the filename minus its last extension — not pairing's
 * {@link basenameOf}, which cuts at the *first* dot because it exists to look past a sidecar's
 * doubled extension. Here both sides are media filenames and the extension is the discriminator,
 * so cutting at the first dot would make `holiday.beach.jpg` and `holiday.trip.mov` one Live
 * Photo.
 *
 * The motion half is `.mov` only. Widening it to `.mp4` would catch Android's separate-file
 * motion photos, but it would also catch an ordinary video that happens to share a stem with a
 * photo — `VID_20210704_121314.mp4` sitting beside a same-stem JPEG — and Android's shape is
 * open question 3 in the design rather than a settled requirement. See the note at the end of
 * this header.
 *
 * Pairing's `shared` flag is corroboration, not the rule. A Live Photo's MOV reaches the still's
 * sidecar through pairing step 4, because Google emits one sidecar for the pair named after the
 * still. That signal is recorded on every pair ({@link LivePair.sidecarShared}) and is used as
 * the tiebreaker when a stem has more than one still — the still that *owns* the sidecar the MOV
 * shares is the one the MOV is about. It cannot be a precondition: a pair whose sidecar Takeout
 * omitted altogether is still a pair, and requiring the sidecar would demote it to a stray video
 * in the timeline.
 *
 * When a stem is still ambiguous after that — two stills with nothing to separate them, or two
 * MOVs — nothing is linked and the stem is reported in {@link LinkResult.ambiguousLivePairs}.
 * Both files are imported as independent assets, which costs a duplicate-looking timeline entry.
 * The alternative is hiding an arbitrary video from the timeline as a motion component, and a
 * hidden asset is one the user cannot find and cannot tell is there.
 *
 * ## Exclusion from the timeline is derived, not stored
 *
 * There is no "hidden" column. `assets.kind` is the whole of it: `MotionComponent` is excluded
 * from timeline queries, which is what makes a Live Photo appear once (design: Takeout metadata
 * repair). {@link excludedFromTimeline} is that predicate in one place so the rule is quotable
 * rather than reimplemented per query.
 *
 * ## What this module says about open question 3
 *
 * Design open question 3 — Android embeds motion data inside the JPEG rather than pairing files,
 * so the `live_pair_hash` model assumes pairs and may need a third representation — is **not
 * resolved here**, and nothing below decides it. What is on record for whoever takes it on:
 *
 * - An embedded motion photo has one file, so it produces one asset and no relationship, and it
 *   reaches the timeline as an ordinary image today. Nothing here has to be undone for it.
 * - The relationship layer is keyed on source paths and resolved to hashes separately, so a
 *   representation that is not a second asset — a flag, or an offset into the JPEG — attaches to
 *   the asset row without touching how pairs are found.
 * - The one thing that would have made it harder is treating `.mp4` as a motion extension on
 *   stem evidence alone. Keeping the motion half to `.mov` leaves the separate-file Android case
 *   undecided rather than answered wrongly, so it stays a decision that can be made on its
 *   merits.
 */

import { AssetKind } from '@photo-archive/core';

import type { PairingResult } from './pairing.ts';
import type { TakeoutExport, TakeoutFile, TakeoutFolder } from './traversal.ts';

function nfc(value: string): string {
  return value.normalize('NFC');
}

/** Codepoint order. `localeCompare` would make this module's output depend on the machine's ICU. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describeNames(names: readonly string[]): string {
  return names.map((name) => JSON.stringify(name)).join(', ');
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/**
 * The suffixes Google appends to an edited render, from the design's variants table.
 *
 * Localized per account and therefore incomplete by nature. An unlisted suffix means the render
 * is imported as an independent asset rather than being attached to the wrong base; see this
 * module's header.
 */
export const EDITED_SUFFIXES: readonly string[] = [
  '-edited',
  '-bearbeitet',
  '-modifié',
  '-editado',
];

/**
 * The table as it is matched: NFC and lowercased, once, at load.
 *
 * Normalizing the table rather than only the input is the point — a suffix typed in NFD in this
 * file would otherwise stop matching NFC filenames, and the mistake would be invisible because
 * the two spellings render identically.
 */
const MATCHABLE_SUFFIXES: readonly string[] = EDITED_SUFFIXES.map((suffix) =>
  nfc(suffix).toLowerCase(),
);

/** Still halves of a Live Photo, per the design's table widened by Requirement 1.6 to JPG. */
const LIVE_STILL_EXTENSIONS: ReadonlySet<string> = new Set(['heic', 'heif', 'jpg', 'jpeg']);

/** The motion half. `.mov` only, on purpose; see this module's header. */
const LIVE_MOTION_EXTENSIONS: ReadonlySet<string> = new Set(['mov']);

/**
 * A filename split at its **last** dot, NFC-normalized.
 *
 * The last dot rather than the first, unlike pairing's {@link basenameOf}: that helper looks past
 * a sidecar's doubled extension, whereas here both sides of every comparison are media filenames
 * and the extension is what distinguishes a still from its motion component.
 *
 * A name with no dot has an empty extension, and a dotfile (`.hidden`) is all stem — neither can
 * be a variant or a Live Photo half, and both fall out of the rules below without a special case.
 */
export function splitExtension(fileName: string): { readonly stem: string; readonly ext: string } {
  const name = nfc(fileName);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

/** What an `-edited` filename decomposes into. */
export interface EditedSuffixMatch {
  /** The suffix as it appeared in the filename, NFC. */
  readonly suffix: string;
  /** The stem with the suffix removed — `IMG_2002` for `IMG_2002-edited.jpg`. Never empty. */
  readonly baseStem: string;
  /** The variant's own extension, verbatim. */
  readonly ext: string;
}

/**
 * Decomposes a variant filename, or returns null when it carries no known suffix.
 *
 * Matched case-insensitively: a suffix differing only in case is still Google's suffix, and the
 * base lookup uses the stem sliced out of the original filename rather than a lowercased copy, so
 * nothing is guessed about the base's spelling.
 *
 * A name that is *only* a suffix (`-edited.jpg`) is not a variant: there is no base stem left to
 * look for.
 */
export function editedSuffixOf(fileName: string): EditedSuffixMatch | null {
  const { stem, ext } = splitExtension(fileName);
  const lower = stem.toLowerCase();
  for (const suffix of MATCHABLE_SUFFIXES) {
    if (lower.length <= suffix.length || !lower.endsWith(suffix)) continue;
    const cut = stem.length - suffix.length;
    return { suffix: stem.slice(cut), baseStem: stem.slice(0, cut), ext };
  }
  return null;
}

/** True when the filename carries a known `-edited` suffix. */
export function isEditedVariantName(fileName: string): boolean {
  return editedSuffixOf(fileName) !== null;
}

/**
 * The filename step 1 probes for a variant's base — the base stem plus the variant's own
 * extension — or null when the name is not a variant, or carries no extension to reuse.
 */
export function baseNameFor(fileName: string): string | null {
  const match = editedSuffixOf(fileName);
  if (match === null || match.ext === '') return null;
  return `${match.baseStem}.${match.ext}`;
}

/** True when this extension can be the still half of a Live Photo. */
export function isLiveStillExtension(ext: string): boolean {
  return LIVE_STILL_EXTENSIONS.has(nfc(ext).toLowerCase());
}

/** True when this extension can be the motion half of a Live Photo. */
export function isLiveMotionExtension(ext: string): boolean {
  return LIVE_MOTION_EXTENSIONS.has(nfc(ext).toLowerCase());
}

/**
 * Whether an asset of this kind appears in the timeline.
 *
 * The whole of the rule, in one place: a motion component is a real asset with its own hash and
 * bytes, hidden from timeline queries so a Live Photo appears once. There is no column for it —
 * `assets.kind` is the column.
 */
export function excludedFromTimeline(kind: AssetKind): boolean {
  return kind === AssetKind.MotionComponent;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Which step found a variant's base. A strength ranking, not a preference. */
export const VariantMatch = {
  /** Base stem plus the variant's own extension, byte-exact. Derived from the variant's name. */
  SameName: 'same-name',
  /** The one media file of the same kind with the base stem, when the extensions differ. */
  SameStem: 'same-stem',
} as const;
export type VariantMatch = (typeof VariantMatch)[keyof typeof VariantMatch];

/** An `-edited` render and the base asset it is a variant of (Requirement 1.5). */
export interface VariantLink {
  readonly variant: TakeoutFile;
  readonly base: TakeoutFile;
  /** The suffix as it appeared, NFC — useful in the report when a locale is in play. */
  readonly suffix: string;
  readonly matchedBy: VariantMatch;
}

/** Why a file that looks like a variant was imported as an independent asset. */
export const UnlinkedVariantReason = {
  /** Nothing in the folder has the base stem. Google exported the render and not its base. */
  NoBase: 'no-base',
  /** Several same-stem candidates and nothing to choose between them; see the header. */
  AmbiguousBase: 'ambiguous-base',
} as const;
export type UnlinkedVariantReason =
  (typeof UnlinkedVariantReason)[keyof typeof UnlinkedVariantReason];

/** A variant with no base link, and the reason. One line in the reconciliation report. */
export interface UnlinkedVariant {
  readonly media: TakeoutFile;
  readonly suffix: string;
  readonly reason: UnlinkedVariantReason;
  readonly detail: string;
  /** Base filenames that were considered, sorted. Empty for {@link UnlinkedVariantReason.NoBase}. */
  readonly candidates: readonly string[];
}

/** A still and its motion component, one logical Live Photo (Requirement 1.6). */
export interface LivePair {
  readonly still: TakeoutFile;
  /** The MOV. Becomes {@link AssetKind.MotionComponent} and is hidden from the timeline. */
  readonly motion: TakeoutFile;
  /** The stem both halves share, NFC. */
  readonly stem: string;
  /**
   * True when the motion reached the still's sidecar through pairing step 4 — Google's one
   * sidecar per pair, named after the still. Corroboration and a tiebreaker, never a
   * precondition; see this module's header.
   */
  readonly sidecarShared: boolean;
}

/** A stem with same-stem stills and MOVs that could not be resolved to one pair. */
export interface AmbiguousLivePair {
  readonly stem: string;
  /** Still filenames sharing the stem, sorted. */
  readonly stills: readonly string[];
  /** MOV filenames sharing the stem, sorted. */
  readonly motions: readonly string[];
  readonly detail: string;
}

/**
 * What linking concluded about a folder, or about a whole export.
 *
 * Every map is keyed on {@link TakeoutFile.sourcePath}, and every value that would be a hash is a
 * source path instead. {@link resolveLinkHashes} is what turns these into column values.
 */
export interface LinkResult {
  /** One entry per variant *file*, so a path with conflicting copies contributes each copy. */
  readonly variants: readonly VariantLink[];
  readonly unlinkedVariants: readonly UnlinkedVariant[];
  readonly livePairs: readonly LivePair[];
  readonly ambiguousLivePairs: readonly AmbiguousLivePair[];
  /**
   * `assets.kind` for every media file, in folder order. Equal to
   * {@link TakeoutFile.mediaKind} except for the MOV of a Live Photo, which traversal cannot
   * classify because the decision needs the whole folder.
   */
  readonly kindBySourcePath: ReadonlyMap<string, AssetKind>;
  /** Variant source path to its base's source path. The relationship behind `variant_of_hash`. */
  readonly variantBaseBySourcePath: ReadonlyMap<string, string>;
  /**
   * Either half of a Live Photo to the other. Symmetric, because `live_pair_hash` is: the still
   * points at its motion component and the motion component points back.
   */
  readonly livePairBySourcePath: ReadonlyMap<string, string>;
}

/** Optional inputs. Linking works without any of them; they only make it better informed. */
export interface LinkOptions {
  /**
   * What pairing concluded, used for the `shared` corroboration on Live Photos. Omitted, pairs
   * are still found by stem and {@link LivePair.sidecarShared} is false throughout.
   */
  readonly pairing?: PairingResult;
}

// ---------------------------------------------------------------------------
// Linking one folder
// ---------------------------------------------------------------------------

/** One filename's decision, made once and then applied to every copy of that name. */
interface NameDecision {
  /** Base filename, when this name is a linked variant. */
  readonly baseName: string | null;
  readonly matchedBy: VariantMatch | null;
  readonly suffix: string | null;
  /** Counterpart filename, when this name is half of a Live Photo. */
  readonly livePairName: string | null;
  readonly kind: AssetKind;
}

/**
 * Decides variant and Live Photo relationships for one merged folder.
 *
 * The folder is the unit for the same reason it is in pairing: Google keeps a render beside its
 * base and a MOV beside its still, and traversal has already merged the parts, so both rules are
 * folder-scoped and neither needs to look across an export.
 *
 * Decisions are made per **filename** and then applied to every copy of that name, which is how
 * pairing treats a path whose parts disagree about its size: those copies are candidate
 * byte-streams for one logical file, and the earliest part's copy is the one named as a
 * counterpart. Content addressing is the backstop — copies that really differ hash differently
 * and become separate assets regardless.
 */
export function linkFolder(folder: TakeoutFolder, options: LinkOptions = {}): LinkResult {
  // First copy per filename, in name-then-part order, so the representative is the earliest part.
  const representatives = new Map<string, TakeoutFile>();
  for (const media of folder.media) {
    if (!representatives.has(media.name)) representatives.set(media.name, media);
  }

  const variantsByName = new Map<
    string,
    { readonly baseName: string; readonly matchedBy: VariantMatch; readonly suffix: string }
  >();
  const unlinkedByName = new Map<
    string,
    { readonly reason: UnlinkedVariantReason; readonly detail: string; candidates: string[] }
  >();

  for (const [name, media] of representatives) {
    const match = editedSuffixOf(name);
    if (match === null) continue;

    // Step 1: the base stem plus this variant's own extension, byte-exact.
    const sameName = baseNameFor(name);
    if (sameName !== null && representatives.has(sameName) && !isEditedVariantName(sameName)) {
      variantsByName.set(name, {
        baseName: sameName,
        matchedBy: VariantMatch.SameName,
        suffix: match.suffix,
      });
      continue;
    }

    // Step 2: one media file of the same kind whose stem is the base stem. Same kind because a
    // Live Photo's MOV shares its still's stem and is not a candidate base for an edited still.
    const sameStem = [...representatives.values()]
      .filter(
        (candidate) =>
          candidate.name !== name &&
          splitExtension(candidate.name).stem === match.baseStem &&
          candidate.mediaKind === media.mediaKind &&
          !isEditedVariantName(candidate.name),
      )
      .map((candidate) => candidate.name)
      .sort(compareStrings);

    const only = sameStem.length === 1 ? sameStem[0] : undefined;
    if (only !== undefined) {
      variantsByName.set(name, {
        baseName: only,
        matchedBy: VariantMatch.SameStem,
        suffix: match.suffix,
      });
      continue;
    }

    unlinkedByName.set(
      name,
      sameStem.length > 1
        ? {
            reason: UnlinkedVariantReason.AmbiguousBase,
            detail:
              `${sameStem.length.toString()} files share the base stem ` +
              `${JSON.stringify(match.baseStem)} — ${describeNames(sameStem)} — and none of them ` +
              `carries this variant's extension ${JSON.stringify(match.ext)}, so which one was ` +
              'edited would be a guess',
            candidates: sameStem,
          }
        : {
            reason: UnlinkedVariantReason.NoBase,
            detail:
              `nothing in ${JSON.stringify(folder.path)} has the base stem ` +
              `${JSON.stringify(match.baseStem)}, so this render's base was not exported`,
            candidates: [],
          },
    );
  }

  const { pairsByName, ambiguous } = findLivePairs(folder, representatives, options);

  // ---- expand per-name decisions onto every copy, in folder order ----

  const decisionFor = (name: string): NameDecision => {
    const variant = variantsByName.get(name);
    const pair = pairsByName.get(name);
    const mediaKind = representatives.get(name)?.mediaKind ?? AssetKind.Image;
    return {
      baseName: variant?.baseName ?? null,
      matchedBy: variant?.matchedBy ?? null,
      suffix: variant?.suffix ?? null,
      livePairName: pair?.counterpart ?? null,
      kind: pair?.isMotion === true ? AssetKind.MotionComponent : mediaKind,
    };
  };

  const variantLinks: VariantLink[] = [];
  const unlinkedVariants: UnlinkedVariant[] = [];
  const livePairs: LivePair[] = [];
  const kindBySourcePath = new Map<string, AssetKind>();
  const variantBaseBySourcePath = new Map<string, string>();
  const livePairBySourcePath = new Map<string, string>();

  for (const media of folder.media) {
    const decision = decisionFor(media.name);
    kindBySourcePath.set(media.sourcePath, decision.kind);

    if (decision.baseName !== null && decision.matchedBy !== null && decision.suffix !== null) {
      const base = representatives.get(decision.baseName) as TakeoutFile;
      variantLinks.push({
        variant: media,
        base,
        suffix: decision.suffix,
        matchedBy: decision.matchedBy,
      });
      variantBaseBySourcePath.set(media.sourcePath, base.sourcePath);
    }

    const unlinked = unlinkedByName.get(media.name);
    if (unlinked !== undefined) {
      unlinkedVariants.push({
        media,
        // Present because `unlinkedByName` is only populated for names that matched the table.
        suffix: editedSuffixOf(media.name)?.suffix ?? '',
        reason: unlinked.reason,
        detail: unlinked.detail,
        candidates: unlinked.candidates,
      });
    }

    if (decision.livePairName !== null) {
      const counterpart = representatives.get(decision.livePairName) as TakeoutFile;
      livePairBySourcePath.set(media.sourcePath, counterpart.sourcePath);
      // One LivePair per motion file, so a pair is reported once rather than from both ends.
      if (decision.kind === AssetKind.MotionComponent) {
        const pair = pairsByName.get(media.name);
        livePairs.push({
          still: counterpart,
          motion: media,
          stem: splitExtension(media.name).stem,
          sidecarShared: pair?.sidecarShared ?? false,
        });
      }
    }
  }

  return {
    variants: variantLinks,
    unlinkedVariants,
    livePairs,
    ambiguousLivePairs: ambiguous,
    kindBySourcePath,
    variantBaseBySourcePath,
    livePairBySourcePath,
  };
}

/** One half of a Live Photo, as decided per filename. */
interface LivePairName {
  readonly counterpart: string;
  readonly isMotion: boolean;
  readonly sidecarShared: boolean;
}

/**
 * Groups a folder's media by stem and resolves each group to at most one pair.
 *
 * Nothing is linked unless the group has exactly one MOV and one still, or the sidecar share
 * identifies which still the MOV is about. Everything else is reported and imported as separate
 * assets — see this module's header for why an arbitrary choice is worse than a duplicate.
 */
function findLivePairs(
  folder: TakeoutFolder,
  representatives: ReadonlyMap<string, TakeoutFile>,
  options: LinkOptions,
): {
  pairsByName: ReadonlyMap<string, LivePairName>;
  ambiguous: readonly AmbiguousLivePair[];
} {
  const pairing = options.pairing;

  /** The sidecar a file was paired with, and whether it reached it as a step-4 share. */
  const sidecarOf = (file: TakeoutFile): { name: string; shared: boolean } | null => {
    const paired = pairing?.pairingBySourcePath.get(file.sourcePath);
    return paired === undefined ? null : { name: paired.sidecar.name, shared: paired.shared };
  };

  const byStem = new Map<string, { stills: TakeoutFile[]; motions: TakeoutFile[] }>();
  for (const media of representatives.values()) {
    const { stem, ext } = splitExtension(media.name);
    const isStill = media.mediaKind === AssetKind.Image && isLiveStillExtension(ext);
    const isMotion = media.mediaKind === AssetKind.Video && isLiveMotionExtension(ext);
    if (!isStill && !isMotion) continue;
    const group = byStem.get(stem) ?? { stills: [], motions: [] };
    (isStill ? group.stills : group.motions).push(media);
    byStem.set(stem, group);
  }

  const pairsByName = new Map<string, LivePairName>();
  const ambiguous: AmbiguousLivePair[] = [];

  for (const [stem, group] of [...byStem.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    // A lone still is an ordinary photo; a lone MOV is an ordinary video. Neither is a pair, and
    // the corpus's `unpaired-video` is the case that must stay an ordinary video.
    if (group.motions.length === 0 || group.stills.length === 0) continue;

    const stills = [...group.stills].sort((a, b) => compareStrings(a.name, b.name));
    const motions = [...group.motions].sort((a, b) => compareStrings(a.name, b.name));

    const motion = motions.length === 1 ? motions[0] : undefined;
    if (motion === undefined) {
      ambiguous.push({
        stem,
        stills: stills.map((file) => file.name),
        motions: motions.map((file) => file.name),
        detail:
          `${motions.length.toString()} videos share the stem ${JSON.stringify(stem)} in ` +
          `${JSON.stringify(folder.path)} — ${describeNames(motions.map((file) => file.name))} — ` +
          'so which one is the motion component of a Live Photo cannot be established',
      });
      continue;
    }

    const motionSidecar = sidecarOf(motion);
    let still = stills.length === 1 ? stills[0] : undefined;

    if (still === undefined && motionSidecar !== null && motionSidecar.shared) {
      // The tiebreaker: Google emits one sidecar per pair, named after the still, and the MOV
      // reaches it through pairing step 4. So the still that *owns* that sidecar — pairing's
      // exclusive claimant, not another sharer of it — is the one the MOV is about.
      const owners = stills.filter((candidate) => {
        const sidecar = sidecarOf(candidate);
        return sidecar !== null && !sidecar.shared && sidecar.name === motionSidecar.name;
      });
      still = owners.length === 1 ? owners[0] : undefined;
    }

    if (still === undefined) {
      ambiguous.push({
        stem,
        stills: stills.map((file) => file.name),
        motions: [motion.name],
        detail:
          `${stills.length.toString()} stills share the stem ${JSON.stringify(stem)} in ` +
          `${JSON.stringify(folder.path)} — ${describeNames(stills.map((file) => file.name))} — ` +
          `and ${JSON.stringify(motion.name)} shares no sidecar with any one of them, so pairing ` +
          'it here would be a guess',
      });
      continue;
    }

    const shared =
      motionSidecar !== null &&
      motionSidecar.shared &&
      sidecarOf(still)?.name === motionSidecar.name;

    pairsByName.set(motion.name, {
      counterpart: still.name,
      isMotion: true,
      sidecarShared: shared,
    });
    pairsByName.set(still.name, {
      counterpart: motion.name,
      isMotion: false,
      sidecarShared: shared,
    });
  }

  return { pairsByName, ambiguous };
}

/**
 * Links every folder of an export.
 *
 * Folders arrive from traversal sorted by path and already merged across parts, so the result is
 * deterministic and independent of how Takeout split the export.
 */
export function linkExport(exportSet: TakeoutExport, options: LinkOptions = {}): LinkResult {
  const variants: VariantLink[] = [];
  const unlinkedVariants: UnlinkedVariant[] = [];
  const livePairs: LivePair[] = [];
  const ambiguousLivePairs: AmbiguousLivePair[] = [];
  const kindBySourcePath = new Map<string, AssetKind>();
  const variantBaseBySourcePath = new Map<string, string>();
  const livePairBySourcePath = new Map<string, string>();

  for (const folder of exportSet.folders) {
    const result = linkFolder(folder, options);
    variants.push(...result.variants);
    unlinkedVariants.push(...result.unlinkedVariants);
    livePairs.push(...result.livePairs);
    ambiguousLivePairs.push(...result.ambiguousLivePairs);
    for (const [sourcePath, kind] of result.kindBySourcePath) {
      kindBySourcePath.set(sourcePath, kind);
    }
    for (const [sourcePath, base] of result.variantBaseBySourcePath) {
      variantBaseBySourcePath.set(sourcePath, base);
    }
    for (const [sourcePath, counterpart] of result.livePairBySourcePath) {
      livePairBySourcePath.set(sourcePath, counterpart);
    }
  }

  return {
    variants,
    unlinkedVariants,
    livePairs,
    ambiguousLivePairs,
    kindBySourcePath,
    variantBaseBySourcePath,
    livePairBySourcePath,
  };
}

// ---------------------------------------------------------------------------
// Turning relationships into column values, once hashes exist
// ---------------------------------------------------------------------------

/** Which column a relationship becomes. */
export const LinkRelation = {
  /** `assets.variant_of_hash`. */
  VariantOf: 'variant-of',
  /** `assets.live_pair_hash`. */
  LivePair: 'live-pair',
} as const;
export type LinkRelation = (typeof LinkRelation)[keyof typeof LinkRelation];

/** One media file's `assets` columns, as far as this module decides them. */
export interface AssetLinks {
  readonly sourcePath: string;
  /** `assets.kind`. */
  readonly kind: AssetKind;
  /** `assets.variant_of_hash`. */
  readonly variantOfHash: string | null;
  /** `assets.live_pair_hash`. */
  readonly livePairHash: string | null;
}

/** A relationship that was found but could not be written as a hash, and why. */
export interface UnresolvedLink {
  readonly sourcePath: string;
  readonly relation: LinkRelation;
  readonly counterpartSourcePath: string;
  readonly reason: string;
}

/** Content hash of the asset a source path contributed to, or null/undefined when there is none. */
export type ContentHashLookup = (sourcePath: string) => string | null | undefined;

/** Columns for every media file, plus the relationships that did not survive into one. */
export interface ResolvedLinks {
  /** One row per media file, in {@link LinkResult.kindBySourcePath} order. */
  readonly assets: readonly AssetLinks[];
  readonly unresolved: readonly UnresolvedLink[];
}

/**
 * Resolves relationships to hashes, which is the step this module cannot do itself.
 *
 * Pure and synchronous: the caller supplies the lookup, so the same rules are testable with
 * stated hashes and are reusable by task 2.11 with the ledger behind them.
 *
 * Two relationships legitimately fail to become a column value, and both are reported rather than
 * dropped quietly:
 *
 * - the counterpart has no hash yet, because its `Hash` job has not run or failed;
 * - the counterpart hashes to the *same* asset, so the link would point a row at itself. That is
 *   dedupe working correctly — byte-identical files are one asset — and a self-referential
 *   `variant_of_hash` would be a cycle of length one for any consumer that walks it.
 */
export function resolveLinkHashes(links: LinkResult, hashOf: ContentHashLookup): ResolvedLinks {
  const assets: AssetLinks[] = [];
  const unresolved: UnresolvedLink[] = [];

  const resolve = (
    sourcePath: string,
    ownHash: string | null,
    relation: LinkRelation,
    counterpartSourcePath: string | undefined,
  ): string | null => {
    if (counterpartSourcePath === undefined) return null;
    const counterpartHash = hashOf(counterpartSourcePath) ?? null;
    if (counterpartHash === null) {
      unresolved.push({
        sourcePath,
        relation,
        counterpartSourcePath,
        reason: `${counterpartSourcePath} has no content hash, so ${relation} cannot be recorded`,
      });
      return null;
    }
    if (ownHash !== null && counterpartHash === ownHash) {
      unresolved.push({
        sourcePath,
        relation,
        counterpartSourcePath,
        reason:
          `${counterpartSourcePath} is byte-identical to this file and deduplicated into the ` +
          `same asset ${counterpartHash}, so ${relation} would point the row at itself`,
      });
      return null;
    }
    return counterpartHash;
  };

  for (const [sourcePath, kind] of links.kindBySourcePath) {
    const ownHash = hashOf(sourcePath) ?? null;
    assets.push({
      sourcePath,
      kind,
      variantOfHash: resolve(
        sourcePath,
        ownHash,
        LinkRelation.VariantOf,
        links.variantBaseBySourcePath.get(sourcePath),
      ),
      livePairHash: resolve(
        sourcePath,
        ownHash,
        LinkRelation.LivePair,
        links.livePairBySourcePath.get(sourcePath),
      ),
    });
  }

  return { assets, unresolved };
}
