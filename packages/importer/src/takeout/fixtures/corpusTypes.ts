/**
 * The shape of the Takeout fixture corpus.
 *
 * The corpus is a **declarative manifest** (`corpus.ts`) materialized onto disk by
 * `buildCorpus()` (`buildCorpus.ts`). Nothing binary is committed: the payloads are
 * synthetic, generated deterministically from each fixture's id, so the corpus is a
 * TypeScript file rather than a directory of blobs that Git cannot diff and a reviewer
 * cannot read.
 *
 * ## Why every fixture carries an `expect` block
 *
 * The corpus is the regression suite for tasks 2.2-2.6 and 2.12, and the rules those tasks
 * implement — sidecar pairing, timestamp precedence, variant and Live Photo linking, album
 * reconstruction — are the part of the product that silently corrupts an archive when it is
 * wrong. A directory tree alone states the *input* and leaves the correct output to whatever
 * the implementation happens to produce, which is exactly the failure mode to avoid. So each
 * {@link MediaFixture} states, up front and in one place, what the importer must conclude:
 * which sidecar it pairs with and by which resolution step, the resolved capture time and its
 * {@link CapturedAtSource}, any `variantOf` base, any Live Photo counterpart, album
 * membership, and whether the containing folder is an album or a chronological bucket.
 *
 * `corpus.test.ts` checks those expectations against each other and against the materialized
 * tree, so a self-contradictory fixture fails before it can mislead a later task.
 *
 * ## What this corpus is not for
 *
 * The payloads are not decodable media (see `syntheticMedia.ts`). Pairing, variant, Live
 * Photo, album, and provenance rules are entirely filename- and sidecar-driven, so a tiny
 * payload with the right extension — plus, where it matters, a real EXIF segment — is
 * sufficient and keeps the corpus small. Tasks 2.7 and 2.8 generate derivatives with `sharp`
 * and `ffmpeg` and therefore need genuinely decodable inputs; those belong to their own,
 * much smaller fixture set.
 */

import type { AssetKind, CapturedAtSource } from '@photo-archive/core';

import type { FolderRole } from '../albums.ts';
import type { PairingStep } from '../pairing.ts';

/**
 * What a Takeout folder means, which is not deducible from its name alone — the distinction
 * between an album and a chronological bucket is the presence of `metadata.json` plus the
 * `Photos from YYYY` convention (design: Takeout metadata repair).
 *
 * Re-exported from album reconstruction (task 2.6) rather than declared here, for the same reason
 * {@link PairingStep} is: a fixture that says `year-bucket` and a resolver that says `year-bucket`
 * have to mean the same thing for the expectation to be falsifiable at all.
 */
export { FolderRole } from '../albums.ts';

/**
 * Which step of the four-step resolution order pairs a sidecar to its media, first match
 * wins (design: Takeout metadata repair, Requirement 1.4).
 *
 * Recording the step rather than only the outcome is what makes a pairing regression
 * diagnosable: a fixture that still pairs but pairs by a later step means an earlier step
 * stopped matching, which is a bug even though the result looks right.
 *
 * Re-exported from the resolver (task 2.3) rather than declared here, because a fixture that
 * says `truncated` and a resolver that says `truncated` have to mean the same thing for the
 * expectation to be falsifiable at all.
 */
export { PairingStep } from '../pairing.ts';

/** Coordinates as Takeout writes them, in `geoData` and `geoDataExif`. */
export interface GeoFixture {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number;
}

/**
 * The EXIF a fixture's payload actually carries.
 *
 * Declared here and written as a real APP1 segment rather than asserted in the abstract,
 * because task 2.4 has to read it: the case that matters is EXIF and sidecar disagreeing,
 * and a test where the EXIF is imaginary proves nothing about which one wins.
 */
export interface ExifFixture {
  /**
   * `DateTimeOriginal`, in EXIF's own `YYYY:MM:DD HH:MM:SS` form. Timezone-naive, because
   * the tag is: `OffsetTimeOriginal` is a separate tag and Takeout rarely preserves it. The
   * corpus treats a naive EXIF date as UTC, which is what the matching `expect.capturedAt`
   * values assume.
   */
  readonly dateTimeOriginal: string;
}

/** A sidecar JSON as Takeout emitted it, filename included. */
export interface SidecarFixture {
  /**
   * The sidecar's filename, verbatim. This is the whole point of several fixtures: the name
   * is what pairing has to cope with, so it is stated literally rather than derived from the
   * media filename by a helper that would encode the same assumption under test.
   */
  readonly file: string;
  /**
   * Part directory holding the sidecar, when it is not the part holding the media. Takeout
   * splits on size alone and will put an asset's sidecar in a different archive from its
   * bytes, which is why traversal has to merge parts before pairing runs (Requirement 1.1).
   */
  readonly part?: string;
  /** The sidecar's `title` field. Carries the untruncated original name. */
  readonly title: string;
  /** `photoTakenTime`, ISO 8601 UTC. Authoritative for capture time (Requirement 1.2). */
  readonly photoTakenAt: string;
  /** `creationTime`, ISO 8601 UTC. Upload time, not capture time. Never authoritative. */
  readonly creationAt: string;
  readonly geo?: GeoFixture;
  readonly favorited?: boolean;
  readonly archived?: boolean;
  readonly inTrash?: boolean;
  readonly people?: readonly string[];
}

/** `metadata.json` in an album folder. Its presence is what makes the folder an album. */
export interface AlbumMetadataFixture {
  readonly title: string;
  readonly description: string;
  /** The album's own `date`, ISO 8601 UTC. Unrelated to any member's capture time. */
  readonly albumDate: string;
  readonly geo?: GeoFixture;
}

/** What the importer must conclude about one media file. */
export interface MediaExpectation {
  /**
   * Filename of the sidecar this media pairs with, or `null` for unpaired media — which is
   * imported with degraded provenance and reported, never dropped (Requirement 1.10).
   */
  readonly sidecarFile: string | null;
  /** The step that produced the pairing. `null` exactly when `sidecarFile` is `null`. */
  readonly pairingStep: PairingStep | null;
  /** True when the sidecar lives in a different archive part than the media. */
  readonly sidecarInOtherPart?: boolean;
  /** Resolved capture time, ISO 8601 UTC. */
  readonly capturedAt: string;
  /** Provenance of {@link capturedAt}, persisted in `assets.captured_at_src`. */
  readonly capturedAtSource: CapturedAtSource;
  readonly kind: AssetKind;
  /** Fixture id of the base asset when this is an `-edited` variant (Requirement 1.5). */
  readonly variantOf: string | null;
  /** Fixture id of the other half of a Live Photo (Requirement 1.6). Symmetric. */
  readonly livePairOf: string | null;
  /** Album titles this asset belongs to. Non-empty only inside an album folder. */
  readonly albums: readonly string[];
  readonly folderRole: FolderRole;
  readonly archived: boolean;
  readonly inTrash: boolean;
  /** True for the MOV half of a Live Photo, which must appear once in the timeline. */
  readonly excludedFromTimeline: boolean;
  /** Why this fixture exists, or a decision it pins down. */
  readonly note?: string;
}

/** What the importer must conclude about one folder. */
export interface FolderExpectation {
  readonly isAlbum: boolean;
  readonly albumTitle: string | null;
  /** The year, when the folder is a `Photos from YYYY` bucket. */
  readonly yearBucket: number | null;
  readonly note?: string;
}

/** One media file, its optional sidecar, and the conclusions it pins down. */
export interface MediaFixture {
  /** Stable, unique, and referenced by `variantOf` and `livePairOf`. */
  readonly id: string;
  /** Name of the archive part directory holding the media bytes. */
  readonly part: string;
  /** {@link FolderFixture.dir} of the containing folder. */
  readonly folder: string;
  readonly file: string;
  /** File mtime, ISO 8601 UTC. The last-resort timestamp source (Requirement 1.3). */
  readonly mtime: string;
  readonly exif?: ExifFixture;
  readonly sidecar?: SidecarFixture;
  readonly expect: MediaExpectation;
}

/**
 * One logical folder. A folder can appear in several parts — Takeout splits on size, so a
 * large `Photos from YYYY` bucket is spread across archives and has to be reassembled.
 */
export interface FolderFixture {
  /** Path relative to `Takeout/Google Photos` inside each part. Unique in the corpus. */
  readonly dir: string;
  /** Parts this folder appears in. At least one. */
  readonly parts: readonly string[];
  readonly role: FolderRole;
  /** Written as `metadata.json`. Present exactly when the folder is an album. */
  readonly metadata?: AlbumMetadataFixture;
  readonly expect: FolderExpectation;
}

/** One archive part, which on disk is what a single Takeout zip expands to. */
export interface PartFixture {
  /** Directory name, matching Google's `takeout-<timestamp>-NNN` convention. */
  readonly name: string;
  /** What this part contributes to the corpus. */
  readonly note: string;
}

/** The whole corpus: parts, folders, and media, with expectations attached throughout. */
export interface TakeoutCorpus {
  readonly parts: readonly PartFixture[];
  readonly folders: readonly FolderFixture[];
  readonly media: readonly MediaFixture[];
}
