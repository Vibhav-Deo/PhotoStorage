/**
 * Types for the third-party notices aggregation.
 *
 * Why this exists: every dependency we ship is MIT or similar, and MIT's single
 * obligation is notice retention. Two of the packages this product depends on for
 * inference — `react-native-executorch` and `onnxruntime-node` — are MIT but ship
 * no LICENSE file in their npm tarballs, so the aggregation cannot be a collector.
 * It has to be able to *generate* the notice text from an SPDX template when a
 * package omits it, and it has to say which it did. See licenses/README.md.
 */

/** A dependency as found on disk, before license text is resolved. */
export interface CollectedPackage {
  readonly name: string;
  readonly version: string;
  /** SPDX id or expression exactly as the package manifest declares it. */
  readonly declaredLicense: string | null;
  /** Verbatim contents of a LICENSE file shipped inside the package, if there is one. */
  readonly bundledLicenseText: string | null;
  /** Which file the bundled text came from, for provenance. */
  readonly bundledLicenseFile: string | null;
  /** Best available copyright holder, from `author` or the repository owner. */
  readonly copyrightHolder: string | null;
  readonly homepage: string | null;
  /** Workspaces that ship this package, e.g. `packages/importer`. */
  readonly requiredBy: readonly string[];
}

/** An ML model artifact set covered by one license. */
export interface ModelNotice {
  /** The covered work as a human reads it, e.g. `OpenAI CLIP ViT-B/32`. */
  readonly work: string;
  /** Copyright line, verbatim from the compliance record. */
  readonly copyright: string;
  readonly spdxId: string;
  /** Verbatim license text. Never templated — this one we hold on disk. */
  readonly licenseText: string;
  readonly artifacts: readonly ModelArtifactRef[];
}

export interface ModelArtifactRef {
  readonly id: string;
  readonly consumer: string;
  readonly url: string;
  readonly revision: string;
}

/** Where a notice's text came from. The distinction is the point of this tool. */
export type NoticeTextSource = 'bundled' | 'generated';

/** One resolved notice entry, ready to render. */
export interface NoticeEntry {
  readonly name: string;
  readonly version: string;
  readonly spdxId: string | null;
  readonly homepage: string | null;
  readonly licenseText: string;
  readonly textSource: NoticeTextSource;
  /** Human-readable provenance, e.g. which file, or which template and why. */
  readonly textProvenance: string;
  readonly requiredBy: readonly string[];
}

export interface NoticeBundle {
  readonly models: readonly ModelNotice[];
  readonly packages: readonly NoticeEntry[];
}

export interface BuildInput {
  readonly packages: readonly CollectedPackage[];
  /** SPDX id (upper-cased) to template text containing a `{{copyright}}` line. */
  readonly spdxTemplates: ReadonlyMap<string, string>;
  readonly models: readonly ModelNotice[];
}

export interface BuildResult {
  readonly bundle: NoticeBundle;
  /**
   * Anything that would make the notices incomplete. Non-empty means the
   * generator fails rather than emitting a file that quietly omits an obligation.
   */
  readonly problems: readonly string[];
}
