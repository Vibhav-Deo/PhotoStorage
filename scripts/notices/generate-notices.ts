/**
 * Generates the third-party notices the product has to distribute.
 *
 * MIT's one obligation is notice retention, and this repository ships MIT material of
 * two kinds: CLIP model artifacts (see licenses/) and npm packages. Several of those
 * packages — `react-native-executorch` and `onnxruntime-node` among them — declare MIT
 * but ship no LICENSE file, so this cannot be a collector. It resolves text where the
 * package provides it and generates it from licenses/spdx/ where it does not, labelling
 * which of the two happened.
 *
 * Two outputs, one aggregation, so the CLI and the app can never disagree:
 *   packages/importer/THIRD_PARTY_NOTICES.txt   distributed with the importer
 *   apps/mobile/assets/third-party-notices.json rendered by the app's notices view
 *
 * Usage:
 *   node scripts/notices/generate-notices.ts           write the files
 *   node scripts/notices/generate-notices.ts --check    fail if they are stale
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { buildNotices } from './build.ts';
import { collectPackages } from './collect.ts';
import { renderNoticesJson, renderNoticesText } from './render.ts';
import type { ModelArtifactRef, ModelNotice } from './types.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Workspaces whose runtime dependencies are actually distributed. */
const DISTRIBUTED_WORKSPACES = ['packages/core', 'packages/importer', 'apps/mobile'] as const;

const TEXT_OUTPUT = path.join(REPO_ROOT, 'packages', 'importer', 'THIRD_PARTY_NOTICES.txt');
const JSON_OUTPUT = path.join(REPO_ROOT, 'apps', 'mobile', 'assets', 'third-party-notices.json');

function loadSpdxTemplates(): Map<string, string> {
  const dir = path.join(REPO_ROOT, 'licenses', 'spdx');
  const templates = new Map<string, string>();
  if (!existsSync(dir)) return templates;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.txt')) continue;
    const id = entry.slice(0, -'.txt'.length).toUpperCase();
    templates.set(id, readFileSync(path.join(dir, entry), 'utf8'));
  }
  return templates;
}

interface ModelArtifactsRecord {
  readonly license?: {
    readonly spdxId?: unknown;
    readonly copyrightHolder?: unknown;
    readonly coveredWork?: unknown;
    readonly textFile?: unknown;
    readonly textSha256?: unknown;
  };
  readonly artifacts?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`licenses/model-artifacts.json: ${field} is missing or not a string`);
  }
  return value;
}

/**
 * Reads the task 0.3 compliance record and turns it into a notice.
 *
 * The digest check is the point: the record states the sha256 of the license text it
 * verified, so if the shipped text and the record ever diverge, the build stops rather
 * than shipping a notice that the compliance record does not vouch for.
 */
function loadModelNotices(): ModelNotice[] {
  const recordFile = path.join(REPO_ROOT, 'licenses', 'model-artifacts.json');
  const parsed: unknown = JSON.parse(readFileSync(recordFile, 'utf8'));
  const record = parsed as ModelArtifactsRecord;
  const license = record.license ?? {};

  const textFile = requireString(license.textFile, 'license.textFile');
  const textPath = path.join(REPO_ROOT, 'licenses', textFile);
  const licenseText = readFileSync(textPath, 'utf8');
  const digest = createHash('sha256').update(licenseText).digest('hex');
  const expected = requireString(license.textSha256, 'license.textSha256');
  if (digest !== expected) {
    throw new Error(
      `licenses/${textFile} sha256 is ${digest} but licenses/model-artifacts.json records ` +
        `${expected}. The compliance record and the shipped license text disagree; resolve ` +
        `that before regenerating notices.`,
    );
  }

  const artifacts: ModelArtifactRef[] = (Array.isArray(record.artifacts) ? record.artifacts : [])
    .map((entry): ModelArtifactRef => {
      const artifact = entry as Record<string, unknown>;
      return {
        id: requireString(artifact.id, 'artifacts[].id'),
        consumer: requireString(artifact.consumer, 'artifacts[].consumer'),
        url: requireString(artifact.url, 'artifacts[].url'),
        revision: requireString(artifact.revision, 'artifacts[].revision'),
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return [
    {
      work: requireString(license.coveredWork, 'license.coveredWork'),
      copyright: requireString(license.copyrightHolder, 'license.copyrightHolder'),
      spdxId: requireString(license.spdxId, 'license.spdxId'),
      licenseText,
      artifacts,
    },
  ];
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function main(): number {
  const check = process.argv.includes('--check');

  const collected = collectPackages({
    repoRoot: REPO_ROOT,
    distributedWorkspaces: DISTRIBUTED_WORKSPACES,
  });

  const { bundle, problems } = buildNotices({
    packages: collected.packages,
    spdxTemplates: loadSpdxTemplates(),
    models: loadModelNotices(),
  });

  const blocking = [
    ...problems,
    ...collected.unresolved.map(
      (entry) => `could not resolve ${entry}; run \`npm install\` before generating notices`,
    ),
  ];

  if (blocking.length > 0) {
    console.error('Third-party notices are incomplete:');
    for (const problem of blocking) console.error(`  - ${problem}`);
    return 1;
  }

  const text = renderNoticesText(bundle);
  const json = renderNoticesJson(bundle);

  if (check) {
    const stale = [
      readIfExists(TEXT_OUTPUT) === text ? null : path.relative(REPO_ROOT, TEXT_OUTPUT),
      readIfExists(JSON_OUTPUT) === json ? null : path.relative(REPO_ROOT, JSON_OUTPUT),
    ].filter((entry): entry is string => entry !== null);

    if (stale.length > 0) {
      console.error('Third-party notices are out of date:');
      for (const file of stale) console.error(`  - ${file}`);
      console.error('Run `npm run notices` and commit the result.');
      return 1;
    }
    console.log(
      `Third-party notices are current: ${bundle.models.length} model notice(s), ` +
        `${bundle.packages.length} package notice(s).`,
    );
    return 0;
  }

  mkdirSync(path.dirname(TEXT_OUTPUT), { recursive: true });
  mkdirSync(path.dirname(JSON_OUTPUT), { recursive: true });
  writeFileSync(TEXT_OUTPUT, text, 'utf8');
  writeFileSync(JSON_OUTPUT, json, 'utf8');

  const generated = bundle.packages.filter((entry) => entry.textSource === 'generated').length;
  console.log(
    `Wrote ${path.relative(REPO_ROOT, TEXT_OUTPUT)} and ${path.relative(REPO_ROOT, JSON_OUTPUT)}: ` +
      `${bundle.models.length} model notice(s), ${bundle.packages.length} package notice(s) ` +
      `(${generated} generated from an SPDX template).`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
