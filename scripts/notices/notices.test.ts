import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import { buildNotices, isLicenseExpression, normalizeSpdxId } from './build.ts';
import { collectPackages, copyrightHolderOf, findLicenseFile } from './collect.ts';
import { renderNoticesJson, renderNoticesText } from './render.ts';
import type { CollectedPackage, ModelNotice } from './types.ts';

const MIT_TEMPLATE = '{{copyright}}\n\nPermission is hereby granted, free of charge...\n';
const SPDX = new Map([['MIT', MIT_TEMPLATE]]);

const MODEL: ModelNotice = {
  work: 'OpenAI CLIP ViT-B/32',
  copyright: 'Copyright (c) 2021 OpenAI',
  spdxId: 'MIT',
  licenseText: 'MIT License\n\nCopyright (c) 2021 OpenAI\n\nPermission is hereby granted...\n',
  artifacts: [
    {
      id: 'rne-clip-image-fp32',
      consumer: 'app',
      url: 'https://example.invalid/image.pte',
      revision: '68bad8b0',
    },
  ],
};

function pkg(overrides: Partial<CollectedPackage> = {}): CollectedPackage {
  return {
    name: 'some-package',
    version: '1.0.0',
    declaredLicense: 'MIT',
    bundledLicenseText: null,
    bundledLicenseFile: null,
    copyrightHolder: null,
    homepage: null,
    requiredBy: ['packages/importer'],
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'notices-'));
  tempDirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildNotices', () => {
  it('uses a bundled license file verbatim and records where it came from', () => {
    const text = 'MIT License\n\nCopyright (c) 2019 Someone Real\n\nPermission...\n';
    const { bundle, problems } = buildNotices({
      packages: [pkg({ bundledLicenseText: text, bundledLicenseFile: 'LICENSE' })],
      spdxTemplates: SPDX,
      models: [],
    });

    expect(problems).toEqual([]);
    expect(bundle.packages).toHaveLength(1);
    expect(bundle.packages[0]?.textSource).toBe('bundled');
    expect(bundle.packages[0]?.licenseText).toBe(text.trimEnd());
    expect(bundle.packages[0]?.textProvenance).toContain('LICENSE');
  });

  // This is the case that forced generation rather than collection: react-native-executorch
  // and onnxruntime-node are both MIT and neither ships a LICENSE file in its tarball.
  it('generates MIT text from the template when the package ships no license file', () => {
    const { bundle, problems } = buildNotices({
      packages: [
        pkg({
          name: 'react-native-executorch',
          version: '0.9.3',
          copyrightHolder: 'Software Mansion',
        }),
      ],
      spdxTemplates: SPDX,
      models: [],
    });

    expect(problems).toEqual([]);
    const entry = bundle.packages[0];
    expect(entry?.textSource).toBe('generated');
    expect(entry?.licenseText).toContain('Copyright (c) Software Mansion');
    expect(entry?.licenseText).toContain('Permission is hereby granted');
    expect(entry?.textProvenance).toContain('licenses/spdx/MIT.txt');
  });

  it('names the authors collectively when no copyright holder is declared', () => {
    const { bundle } = buildNotices({
      packages: [pkg({ name: 'holderless', copyrightHolder: null })],
      spdxTemplates: SPDX,
      models: [],
    });

    expect(bundle.packages[0]?.licenseText).toContain('Copyright (c) the holderless authors');
    expect(bundle.packages[0]?.textProvenance).toContain('No copyright holder is declared');
  });

  // A missing notice must stop the build. Emitting a file that silently omits an
  // obligation is worse than failing, because nothing downstream would notice.
  it('reports a problem rather than omitting a package it cannot render', () => {
    const { bundle, problems } = buildNotices({
      packages: [
        pkg({ name: 'exotic', declaredLicense: 'WTFPL' }),
        pkg({ name: 'undeclared', declaredLicense: null }),
        pkg({ name: 'dual', declaredLicense: '(MIT OR Apache-2.0)' }),
      ],
      spdxTemplates: SPDX,
      models: [],
    });

    expect(bundle.packages).toEqual([]);
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('licenses/spdx/WTFPL.txt');
    expect(problems.join('\n')).toContain('declares no license');
    expect(problems.join('\n')).toContain('(MIT OR Apache-2.0)');
  });

  it('merges duplicate name@version entries and unions their shippers', () => {
    const { bundle } = buildNotices({
      packages: [
        pkg({ requiredBy: ['apps/mobile'] }),
        pkg({
          requiredBy: ['packages/importer'],
          bundledLicenseText: 'text\n',
          bundledLicenseFile: 'LICENSE.md',
        }),
      ],
      spdxTemplates: SPDX,
      models: [],
    });

    expect(bundle.packages).toHaveLength(1);
    expect(bundle.packages[0]?.requiredBy).toEqual(['apps/mobile', 'packages/importer']);
    // The copy that carried text wins, so the verbatim notice is never lost to ordering.
    expect(bundle.packages[0]?.textSource).toBe('bundled');
  });

  it('rejects an empty model license text', () => {
    const { problems } = buildNotices({
      packages: [],
      spdxTemplates: SPDX,
      models: [{ ...MODEL, licenseText: '   ' }],
    });
    expect(problems).toHaveLength(1);
  });
});

describe('license id handling', () => {
  it('normalizes case for template lookup', () => {
    expect(normalizeSpdxId(' mit ')).toBe('MIT');
  });

  it('recognizes expressions it must not guess at', () => {
    expect(isLicenseExpression('(MIT OR Apache-2.0)')).toBe(true);
    expect(isLicenseExpression('Apache-2.0 WITH LLVM-exception')).toBe(true);
    expect(isLicenseExpression('MIT')).toBe(false);
    // 'BSD-2-Clause' contains no OR/AND token despite the letters.
    expect(isLicenseExpression('BSD-2-Clause')).toBe(false);
  });
});

describe('renderNoticesText', () => {
  it('carries the model attribution, its artifacts, and the verbatim license text', () => {
    const { bundle } = buildNotices({ packages: [pkg()], spdxTemplates: SPDX, models: [MODEL] });
    const text = renderNoticesText(bundle);

    expect(text).toContain('OpenAI CLIP ViT-B/32');
    expect(text).toContain('Copyright (c) 2021 OpenAI');
    expect(text).toContain('rne-clip-image-fp32');
    expect(text).toContain(MODEL.licenseText.trimEnd());
    expect(text).toContain('some-package@1.0.0');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders JSON the app can consume, with the same content as the text output', () => {
    const { bundle } = buildNotices({ packages: [pkg()], spdxTemplates: SPDX, models: [MODEL] });
    const parsed: unknown = JSON.parse(renderNoticesJson(bundle));
    const doc = parsed as {
      models: { work: string; licenseText: string }[];
      packages: { name: string; licenseText: string }[];
    };

    expect(doc.models[0]?.work).toBe('OpenAI CLIP ViT-B/32');
    expect(doc.models[0]?.licenseText).toBe(MODEL.licenseText.trimEnd());
    expect(doc.packages[0]?.name).toBe('some-package');
    expect(doc.packages[0]?.licenseText).toContain('Permission is hereby granted');
  });
});

describe('collectPackages', () => {
  it('walks runtime dependencies, skips dev dependencies, and reads shipped license files', () => {
    const root = makeTree({
      'packages/importer/package.json': JSON.stringify({
        name: '@photo-archive/importer',
        version: '0.0.0',
        dependencies: { 'shipped-dep': '1.0.0' },
        devDependencies: { 'dev-only': '1.0.0' },
      }),
      'node_modules/shipped-dep/package.json': JSON.stringify({
        name: 'shipped-dep',
        version: '1.2.3',
        license: 'MIT',
        author: 'Real Person <real@example.invalid>',
        dependencies: { 'transitive-dep': '1.0.0' },
      }),
      'node_modules/shipped-dep/LICENSE': 'MIT License\n\nCopyright (c) 2020 Real Person\n',
      // No license file here: this is the generated-notice path.
      'node_modules/transitive-dep/package.json': JSON.stringify({
        name: 'transitive-dep',
        version: '4.5.6',
        license: 'MIT',
        repository: { url: 'git+https://github.com/some-org/transitive-dep.git' },
      }),
      'node_modules/dev-only/package.json': JSON.stringify({
        name: 'dev-only',
        version: '9.9.9',
        license: 'MIT',
      }),
    });

    const { packages, unresolved } = collectPackages({
      repoRoot: root,
      distributedWorkspaces: ['packages/importer'],
    });

    expect(unresolved).toEqual([]);
    const names = packages.map((entry) => `${entry.name}@${entry.version}`).sort();
    expect(names).toEqual(['shipped-dep@1.2.3', 'transitive-dep@4.5.6']);

    const shipped = packages.find((entry) => entry.name === 'shipped-dep');
    expect(shipped?.bundledLicenseFile).toBe('LICENSE');
    expect(shipped?.copyrightHolder).toBe('Real Person');
    expect(shipped?.requiredBy).toEqual(['packages/importer']);

    const transitive = packages.find((entry) => entry.name === 'transitive-dep');
    expect(transitive?.bundledLicenseText).toBeNull();
    expect(transitive?.copyrightHolder).toBe('some-org');
  });

  it('reports a declared dependency that is not installed instead of ignoring it', () => {
    const root = makeTree({
      'packages/importer/package.json': JSON.stringify({
        name: '@photo-archive/importer',
        version: '0.0.0',
        dependencies: { missing: '1.0.0' },
      }),
    });

    const { packages, unresolved } = collectPackages({
      repoRoot: root,
      distributedWorkspaces: ['packages/importer'],
    });

    expect(packages).toEqual([]);
    expect(unresolved.join()).toContain('missing');
  });

  /**
   * `sharp` declares one optional dependency per supported platform and npm installs only
   * the matching one, so ~24 of them are legitimately absent from any given tree. Those
   * carry no notice obligation for this build and must not block it. A missing *required*
   * dependency is a different thing and still blocks.
   */
  it('skips an uninstalled optional dependency but still reports an uninstalled required one', () => {
    const root = makeTree({
      'packages/importer/package.json': JSON.stringify({
        name: '@photo-archive/importer',
        version: '0.0.0',
        dependencies: { 'platform-picker': '1.0.0' },
      }),
      'node_modules/platform-picker/package.json': JSON.stringify({
        name: 'platform-picker',
        version: '1.0.0',
        license: 'MIT',
        dependencies: { 'needed-everywhere': '1.0.0' },
        optionalDependencies: {
          'binary-this-host': '1.0.0',
          'binary-other-host': '1.0.0',
        },
      }),
      // The optional binary for this host is installed, so it is shipped and collected.
      'node_modules/binary-this-host/package.json': JSON.stringify({
        name: 'binary-this-host',
        version: '2.0.0',
        license: 'MIT',
      }),
      // `binary-other-host` and `needed-everywhere` are both absent from disk.
    });

    const { packages, unresolved } = collectPackages({
      repoRoot: root,
      distributedWorkspaces: ['packages/importer'],
    });

    expect(unresolved.join('\n')).toContain('needed-everywhere');
    expect(unresolved.join('\n')).not.toContain('binary-other-host');
    expect(packages.map((entry) => entry.name).sort()).toEqual([
      'binary-this-host',
      'platform-picker',
    ]);
  });

  it('finds license text under the common file name variants', () => {
    const root = makeTree({ 'LICENCE.md': 'text\n' });
    expect(findLicenseFile(root)?.file).toBe('LICENCE.md');
    expect(findLicenseFile(path.join(root, 'nope'))).toBeNull();
  });

  it('derives a copyright holder from an author object or a repository owner', () => {
    expect(copyrightHolderOf({ author: { name: 'Someone' } })).toBe('Someone');
    expect(copyrightHolderOf({ repository: 'https://github.com/an-org/a-repo' })).toBe('an-org');
    expect(copyrightHolderOf({})).toBeNull();
  });
});

/**
 * Property: the notices output is a deterministic function of the *set* of packages.
 *
 * This is what makes `npm run notices:check` a usable CI gate. If ordering, or
 * duplicate entries, could change a byte of the output, the check would fail on
 * unrelated changes and would be turned off.
 */
describe('notices output determinism', () => {
  const packageArbitrary = fc.record({
    name: fc.stringMatching(/^[a-z][a-z0-9-]{0,20}$/),
    version: fc.tuple(fc.nat(20), fc.nat(20), fc.nat(20)).map(([a, b, c]) => `${a}.${b}.${c}`),
    holder: fc.option(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,20}$/), { nil: null }),
    bundled: fc.boolean(),
    shipper: fc.constantFrom('packages/importer', 'apps/mobile', 'packages/core'),
  });

  it('is invariant under input ordering and lists every package exactly once', () => {
    fc.assert(
      fc.property(fc.array(packageArbitrary, { maxLength: 25 }), (raw) => {
        const packages: CollectedPackage[] = raw.map((entry) =>
          pkg({
            name: entry.name,
            version: entry.version,
            copyrightHolder: entry.holder,
            bundledLicenseText: entry.bundled ? `License for ${entry.name}\n` : null,
            bundledLicenseFile: entry.bundled ? 'LICENSE' : null,
            requiredBy: [entry.shipper],
          }),
        );

        const forward = buildNotices({ packages, spdxTemplates: SPDX, models: [MODEL] });
        const reversed = buildNotices({
          packages: [...packages].reverse(),
          spdxTemplates: SPDX,
          models: [MODEL],
        });

        expect(forward.problems).toEqual([]);

        // Ordering must not change a byte of either output.
        expect(renderNoticesText(reversed.bundle)).toBe(renderNoticesText(forward.bundle));
        expect(renderNoticesJson(reversed.bundle)).toBe(renderNoticesJson(forward.bundle));

        // Every distinct name@version appears exactly once.
        const distinct = new Set(packages.map((entry) => `${entry.name}@${entry.version}`));
        const rendered = forward.bundle.packages.map((entry) => `${entry.name}@${entry.version}`);
        expect(rendered).toHaveLength(distinct.size);
        expect(new Set(rendered)).toEqual(distinct);

        const text = renderNoticesText(forward.bundle);
        for (const id of distinct) {
          expect(text.split(`${id}\n`)).toHaveLength(2);
        }
      }),
      { numRuns: 200 },
    );
  });
});
