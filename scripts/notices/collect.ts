import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { CollectedPackage } from './types.ts';

/** The subset of a package manifest this tool reads. */
interface Manifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly author?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
}

export interface CollectOptions {
  readonly repoRoot: string;
  /**
   * Workspaces whose runtime dependencies are actually distributed, relative to
   * `repoRoot`. Dev dependencies are deliberately out of scope: a test runner is not
   * shipped and carries no notice obligation.
   */
  readonly distributedWorkspaces: readonly string[];
}

export interface CollectResult {
  readonly packages: readonly CollectedPackage[];
  /**
   * Declared **required** dependencies that could not be found on disk. Usually a missing
   * install, and blocking: a required dependency is shipped, so a notice is owed for it.
   *
   * Uninstalled *optional* dependencies are deliberately absent from this list. See
   * `dependencyEntries`.
   */
  readonly unresolved: readonly string[];
}

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readManifest(dir: string): Manifest | null {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A declared dependency and whether its absence from disk is legitimate. */
export interface DependencyEntry {
  readonly name: string;
  readonly optional: boolean;
}

/**
 * Runtime dependencies of a manifest, tagged optional or required.
 *
 * The distinction decides what an unresolvable name means. A required dependency that is
 * not on disk is a broken install and must be reported, because it is part of the shipped
 * tree and a notice is owed for it. An optional dependency that is not on disk is normal:
 * `sharp` declares an `optionalDependencies` entry for every platform it supports
 * (`@img/sharp-linux-x64`, `@img/sharp-win32-arm64`, and a dozen more) and npm installs
 * only the one matching the host. The rest are not in this build's tree and carry no
 * notice obligation for this build, so they are skipped silently rather than reported.
 *
 * npm lets a name appear in both maps, where the optional entry wins; that is respected.
 */
export function dependencyEntries(manifest: Manifest): DependencyEntry[] {
  const optional = new Set(Object.keys(asRecord(manifest.optionalDependencies)));
  const names = new Set([...Object.keys(asRecord(manifest.dependencies)), ...optional]);
  return [...names].map((name) => ({ name, optional: optional.has(name) }));
}

/** Node's resolution, narrowed to the repo: walk up node_modules, stop at the root. */
export function resolvePackageDir(fromDir: string, name: string, repoRoot: string): string | null {
  let current = fromDir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (isDirectory(candidate)) return candidate;
    if (path.resolve(current) === path.resolve(repoRoot)) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** A symlink into the repo rather than an installed tarball: our own workspace. */
function isWorkspaceLink(packageDir: string): boolean {
  let real: string;
  try {
    real = realpathSync(packageDir);
  } catch {
    return false;
  }
  return !real.split(path.sep).includes('node_modules');
}

export function findLicenseFile(packageDir: string): { file: string; text: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(packageDir);
  } catch {
    return null;
  }
  const matches = entries.filter((entry) => LICENSE_FILE_PATTERN.test(entry)).sort();
  for (const entry of matches) {
    const full = path.join(packageDir, entry);
    if (!isDirectory(full)) {
      try {
        const text = readFileSync(full, 'utf8');
        if (text.trim() !== '') return { file: entry, text };
      } catch {
        // Unreadable; try the next candidate.
      }
    }
  }
  return null;
}

function declaredLicense(manifest: Manifest): string | null {
  const { license, licenses } = manifest;
  if (typeof license === 'string' && license.trim() !== '') return license.trim();
  if (typeof license === 'object' && license !== null) {
    const type = asRecord(license).type;
    if (typeof type === 'string' && type.trim() !== '') return type.trim();
  }
  if (Array.isArray(licenses)) {
    const entries: unknown[] = licenses;
    const first = entries.find((candidate) => typeof asRecord(candidate).type === 'string');
    const type = asRecord(first).type;
    if (typeof type === 'string' && type.trim() !== '') return type.trim();
  }
  return null;
}

/** `Name <email> (url)` and `{ name }` both reduce to the name. */
export function copyrightHolderOf(manifest: Manifest): string | null {
  const { author, repository } = manifest;
  if (typeof author === 'string') {
    const name = author.split('<')[0]?.split('(')[0]?.trim();
    if (name !== undefined && name !== '') return name;
  }
  if (typeof author === 'object' && author !== null) {
    const name = asRecord(author).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  }
  const repoUrl = typeof repository === 'string' ? repository : asRecord(repository).url;
  if (typeof repoUrl === 'string') {
    const owner = /(?:github|gitlab|bitbucket)\.com[/:]([^/]+)\//.exec(repoUrl)?.[1];
    if (owner !== undefined && owner !== '') return owner;
  }
  return null;
}

function homepageOf(manifest: Manifest): string | null {
  const { homepage, name } = manifest;
  if (typeof homepage === 'string' && homepage.trim() !== '') return homepage.trim();
  if (typeof name === 'string' && name.trim() !== '')
    return `https://www.npmjs.com/package/${name}`;
  return null;
}

/**
 * Walks the runtime dependency graph of the distributed workspaces and reads what each
 * package actually ships. Nothing is fetched from the network: the notices describe the
 * tree that is installed, which is the tree that gets shipped.
 *
 * That last sentence is also the honest limitation. Because platform-specific optional
 * dependencies resolve differently per host, the generated notices describe the tree of
 * the machine that generated them, not every tree the product can be built into. On
 * Linux a different `@img/sharp-*` binary is installed and distributed, with its own
 * copyright holder, and the committed notices would not name it. This is not solved here;
 * a per-platform notices step belongs to whatever produces the release artifacts.
 */
export function collectPackages(options: CollectOptions): CollectResult {
  const { repoRoot, distributedWorkspaces } = options;

  const requiredBy = new Map<string, Set<string>>();
  const resolvedDirs = new Map<string, string>();
  const unresolved = new Set<string>();
  const visited = new Set<string>();

  interface QueueItem {
    readonly dir: string;
    readonly shippedBy: string;
  }

  const queue: QueueItem[] = [];

  for (const workspace of distributedWorkspaces) {
    const workspaceDir = path.join(repoRoot, workspace);
    const manifest = readManifest(workspaceDir);
    if (manifest === null) {
      unresolved.add(`${workspace} (no package.json)`);
      continue;
    }
    for (const dependency of dependencyEntries(manifest)) {
      const dir = resolvePackageDir(workspaceDir, dependency.name, repoRoot);
      if (dir === null) {
        // Not installed and optional: not in this build's tree, so nothing is owed.
        if (!dependency.optional) unresolved.add(`${dependency.name} (required by ${workspace})`);
        continue;
      }
      queue.push({ dir, shippedBy: workspace });
    }
  }

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;

    const manifest = readManifest(item.dir);
    if (manifest === null) continue;
    const name = typeof manifest.name === 'string' ? manifest.name : path.basename(item.dir);
    const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';

    // Our own workspaces carry no third-party obligation, but their dependencies do.
    const internal = isWorkspaceLink(item.dir);
    const id = `${name}@${version}`;

    if (!internal) {
      const shippers = requiredBy.get(id) ?? new Set<string>();
      shippers.add(item.shippedBy);
      requiredBy.set(id, shippers);
      resolvedDirs.set(id, item.dir);
    }

    const visitKey = `${id}\u0000${item.shippedBy}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    for (const dependency of dependencyEntries(manifest)) {
      const dir = resolvePackageDir(item.dir, dependency.name, repoRoot);
      if (dir === null) {
        if (!dependency.optional) unresolved.add(`${dependency.name} (required by ${id})`);
        continue;
      }
      queue.push({ dir, shippedBy: item.shippedBy });
    }
  }

  const packages: CollectedPackage[] = [];
  for (const [id, dir] of resolvedDirs) {
    const manifest = readManifest(dir);
    if (manifest === null) continue;
    const licenseFile = findLicenseFile(dir);
    const atIndex = id.lastIndexOf('@');
    packages.push({
      name: id.slice(0, atIndex),
      version: id.slice(atIndex + 1),
      declaredLicense: declaredLicense(manifest),
      bundledLicenseText: licenseFile?.text ?? null,
      bundledLicenseFile: licenseFile?.file ?? null,
      copyrightHolder: copyrightHolderOf(manifest),
      homepage: homepageOf(manifest),
      requiredBy: [...(requiredBy.get(id) ?? new Set<string>())].sort(),
    });
  }

  return { packages, unresolved: [...unresolved].sort() };
}
