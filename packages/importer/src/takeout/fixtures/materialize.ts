/**
 * Writes the fixture corpus somewhere durable so a human can look at it.
 *
 * ```
 * node packages/importer/src/takeout/fixtures/materialize.ts .tmp/takeout-corpus
 * ```
 *
 * The tests build the corpus into a temporary directory and delete it, which is right for CI
 * and useless when a pairing rule is misbehaving and the question is what the directory
 * actually looks like. This script exists for that moment: it prints the tree it wrote,
 * grouped by fixture, with the sidecar each fixture is expected to pair with and by which
 * step, so the expectation and the filenames can be read side by side.
 *
 * It runs under `node` directly, with no build and no test runner, because relative imports in
 * this repo carry their `.ts` extension and Node strips the types (see the conventions section
 * of `README.md`).
 */

import * as path from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';

import { TAKEOUT_CORPUS } from './corpus.ts';
import { buildCorpus } from './buildCorpus.ts';

const target = argv[2];
if (target === undefined) {
  stderr.write(
    'usage: node packages/importer/src/takeout/fixtures/materialize.ts <directory>\n' +
      '       writes the Takeout fixture corpus into <directory>\n',
  );
  exit(2);
}

const built = await buildCorpus(target);

stdout.write(`corpus root: ${built.root}\n`);
stdout.write(
  `${String(TAKEOUT_CORPUS.parts.length)} parts, ` +
    `${String(TAKEOUT_CORPUS.folders.length)} folders, ` +
    `${String(TAKEOUT_CORPUS.media.length)} media fixtures, ` +
    `${String(built.files.length)} files\n\n`,
);

for (const part of TAKEOUT_CORPUS.parts) {
  stdout.write(`${part.name}\n  ${part.note}\n`);
}
stdout.write('\n');

for (const fixture of TAKEOUT_CORPUS.media) {
  const entry = built.media.get(fixture.id);
  if (entry === undefined) {
    continue;
  }
  const expected = fixture.expect;
  const pairing =
    expected.sidecarFile === null
      ? 'unpaired'
      : `${expected.sidecarFile}  [${String(expected.pairingStep)}${
          expected.sidecarInOtherPart === true ? ', other part' : ''
        }]`;
  stdout.write(`${fixture.id}\n`);
  stdout.write(`  media    ${entry.mediaPath} (${String(entry.byteLength)} bytes)\n`);
  stdout.write(`  pairs    ${pairing}\n`);
  stdout.write(
    `  capture  ${expected.capturedAt}  src=${String(expected.capturedAtSource)}` +
      `  mtime=${fixture.mtime}\n`,
  );
  if (expected.variantOf !== null) {
    stdout.write(`  variant  of ${expected.variantOf}\n`);
  }
  if (expected.livePairOf !== null) {
    stdout.write(`  live     with ${expected.livePairOf}\n`);
  }
  stdout.write(
    `  folder   ${fixture.folder} [${expected.folderRole}]` +
      `${expected.albums.length > 0 ? ` albums=${expected.albums.join(', ')}` : ''}\n`,
  );
}

stdout.write(`\nalbum metadata:\n`);
for (const metadata of built.albumMetadata) {
  stdout.write(`  ${metadata}\n`);
}

stdout.write(`\ninspect with: find ${JSON.stringify(path.relative('.', built.root))} -type f\n`);
