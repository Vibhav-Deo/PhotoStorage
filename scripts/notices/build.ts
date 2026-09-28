import type {
  BuildInput,
  BuildResult,
  CollectedPackage,
  NoticeEntry,
  NoticeTextSource,
} from './types.ts';

const COPYRIGHT_PLACEHOLDER = '{{copyright}}';

/** Normalizes an SPDX id for template lookup. Expressions are left alone. */
export function normalizeSpdxId(declared: string): string {
  return declared.trim().toUpperCase();
}

/** True for `(MIT OR Apache-2.0)` and friends, which we refuse to guess at. */
export function isLicenseExpression(declared: string): boolean {
  return /[()]|\b(?:OR|AND|WITH)\b/i.test(declared.trim());
}

function mergeDuplicates(packages: readonly CollectedPackage[]): CollectedPackage[] {
  const byId = new Map<string, CollectedPackage>();
  for (const pkg of packages) {
    const id = `${pkg.name}@${pkg.version}`;
    const existing = byId.get(id);
    if (existing === undefined) {
      byId.set(id, pkg);
      continue;
    }
    const requiredBy = [...new Set([...existing.requiredBy, ...pkg.requiredBy])].sort();
    byId.set(id, {
      ...existing,
      requiredBy,
      // Prefer whichever copy actually carried license text.
      bundledLicenseText: existing.bundledLicenseText ?? pkg.bundledLicenseText,
      bundledLicenseFile: existing.bundledLicenseFile ?? pkg.bundledLicenseFile,
    });
  }
  return [...byId.values()];
}

function compareEntries(a: CollectedPackage, b: CollectedPackage): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

function fillTemplate(template: string, copyright: string): string {
  return template.replaceAll(COPYRIGHT_PLACEHOLDER, copyright);
}

function copyrightLine(pkg: CollectedPackage): { line: string; holderKnown: boolean } {
  if (pkg.copyrightHolder !== null && pkg.copyrightHolder.trim() !== '') {
    return { line: `Copyright (c) ${pkg.copyrightHolder.trim()}`, holderKnown: true };
  }
  return { line: `Copyright (c) the ${pkg.name} authors`, holderKnown: false };
}

interface ResolvedText {
  readonly text: string;
  readonly source: NoticeTextSource;
  readonly provenance: string;
}

function resolveText(
  pkg: CollectedPackage,
  spdxTemplates: ReadonlyMap<string, string>,
): ResolvedText | { readonly problem: string } {
  const id = `${pkg.name}@${pkg.version}`;

  if (pkg.bundledLicenseText !== null && pkg.bundledLicenseText.trim() !== '') {
    return {
      text: pkg.bundledLicenseText.trimEnd(),
      source: 'bundled',
      provenance: `verbatim from ${pkg.bundledLicenseFile ?? 'LICENSE'} in the published package`,
    };
  }

  if (pkg.declaredLicense === null || pkg.declaredLicense.trim() === '') {
    return {
      problem:
        `${id} ships no license file and declares no license. ` +
        `Resolve its terms by hand and record the text at licenses/spdx/<id>.txt, ` +
        `or remove the dependency.`,
    };
  }

  const declared = pkg.declaredLicense.trim();
  const template = spdxTemplates.get(normalizeSpdxId(declared));

  if (template === undefined && isLicenseExpression(declared)) {
    return {
      problem:
        `${id} declares the license expression "${declared}" and ships no license file. ` +
        `Pick the term we rely on and record its text at licenses/spdx/<id>.txt.`,
    };
  }

  if (template === undefined) {
    return {
      problem:
        `${id} declares "${declared}" but ships no license file and there is no template ` +
        `at licenses/spdx/${declared}.txt. Add the license text there.`,
    };
  }

  const { line, holderKnown } = copyrightLine(pkg);
  const holderNote = holderKnown
    ? ''
    : ' No copyright holder is declared by the package; the notice names its authors collectively.';
  return {
    text: fillTemplate(template, line).trimEnd(),
    source: 'generated',
    provenance:
      `generated from licenses/spdx/${normalizeSpdxId(declared)}.txt because the published ` +
      `package ships no license file.${holderNote}`,
  };
}

/**
 * Resolves every collected package to notice text and returns a deterministic bundle.
 *
 * Deterministic means: sorted by name then version, duplicates merged, and byte-identical
 * for any input ordering. The output is committed to the repo and checked in CI, so any
 * instability would show up as a spurious diff.
 */
export function buildNotices(input: BuildInput): BuildResult {
  const problems: string[] = [];
  const entries: NoticeEntry[] = [];

  for (const pkg of mergeDuplicates(input.packages).sort(compareEntries)) {
    const resolved = resolveText(pkg, input.spdxTemplates);
    if ('problem' in resolved) {
      problems.push(resolved.problem);
      continue;
    }
    entries.push({
      name: pkg.name,
      version: pkg.version,
      spdxId: pkg.declaredLicense,
      homepage: pkg.homepage,
      licenseText: resolved.text,
      textSource: resolved.source,
      textProvenance: resolved.provenance,
      requiredBy: [...pkg.requiredBy].sort(),
    });
  }

  for (const model of input.models) {
    if (model.licenseText.trim() === '') {
      problems.push(`model notice "${model.work}" has empty license text`);
    }
  }

  return { bundle: { models: input.models, packages: entries }, problems };
}
