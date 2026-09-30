# photo-archive

A cross-platform photo and video archive: Google Takeout import, device library ingest,
on-device semantic search, and verified space reclamation into object storage the user
controls. Requirements, design, and the implementation plan live in
`.kiro/specs/photo-archive/`.

## Layout

| Path                | What it is                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `packages/core`     | Domain types, key derivation, SQLite schema, `ObjectStore`, hashing, job queue |
| `packages/importer` | Node CLI for bulk Takeout import                                               |
| `apps/mobile`       | React Native + Expo client                                                     |
| `infra`             | AWS CDK app                                                                    |
| `scripts/notices`   | Third-party notices generator                                                  |
| `licenses/`         | ML model licensing compliance record and SPDX texts                            |
| `spikes/`           | Throwaway Phase 0 code, kept as a record                                       |

`spikes/` is **not** a workspace and never becomes one. Each spike has its own
dependency tree, and the code there exists to have answered a question rather than to be
maintained. It is excluded from the workspace globs, from every TypeScript project, and
from Vitest, ESLint, and Prettier. It is not deleted, because the findings recorded in
`spikes/README.md` are cited throughout `design.md`.

## Commands

Run from the repository root.

| Command             | What it does                                                    |
| ------------------- | --------------------------------------------------------------- |
| `npm run typecheck` | Type-checks the tooling and every workspace                     |
| `npm run lint`      | ESLint, with type-aware rules                                   |
| `npm run format`    | Prettier, writing in place (`format:check` to verify only)      |
| `npm test`          | Vitest, once (`test:watch` to watch)                            |
| `npm run notices`   | Regenerates the third-party notices (`notices:check` to verify) |
| `npm run check`     | All of the above, in the order CI should run them               |

## Conventions

**TypeScript is strict, and then some.** `tsconfig.base.json` is the single source of
compiler options; every workspace extends it and overrides only paths, libs, and whether
it emits. Beyond `strict`, three options are on because of what this product does:
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` because a metadata field that
is absent means something different from one that is null when the archive's correctness
depends on it, and `erasableSyntaxOnly` so that types can always be stripped rather than
transformed. That last one bans enums, namespaces, and parameter properties — use `const`
objects and union types instead.

**Relative imports carry the `.ts` extension.** `rewriteRelativeImportExtensions` turns
them into `.js` on emit. One import style then works everywhere: `node file.ts` runs
sources directly via Node's built-in type stripping, Vitest resolves them, Metro resolves
them, and `tsc` emits valid ESM. Nothing in this repo needs a TypeScript runner.

**Node workspaces are composite TypeScript projects.** `packages/core`,
`packages/importer`, and `infra` emit declarations to `dist/` and reference each other
through project references, so `tsc --build` in one builds what it depends on.
`apps/mobile` is the exception: Metro bundles it from source, so it never emits and uses
bundler module resolution.

**Platform-specific implementations sit behind subpath exports.** `packages/core` defines
narrow interfaces — `SqlDriver`, `ObjectStore` — in its root export, and every
implementation that touches a Node built-in is reachable only through its own subpath
(`@photo-archive/core/node-sqlite`, `/local-fs-store`, `/store-conformance`). The root
export is what Metro bundles, so a bare `node:fs` or `node:sqlite` anywhere in that graph
fails the app bundle. Callers depend on the interface; the platform picks the
implementation.

**Dependencies are pinned exactly** (`save-exact=true` in `.npmrc`). This is not fussiness:
`react-native-executorch`'s version is what builds the model artifact URLs, so a silent
minor bump repoints the weights at a different revision and invalidates the compliance
record in `licenses/`. See `licenses/README.md`.

**Tests sit next to the code** as `*.test.ts`, and unit tests and property-based tests are
both expected. Vitest is configured once at the root; a workspace gets its own config only
when it genuinely needs a different environment, which `apps/mobile` will.

### Version choices worth knowing

Vitest is pinned to 3.2.7 rather than the current major. Vitest 4's peer graph cannot be
installed by the npm in this environment, and the Phase 0 spikes already standardised on
3.2.x, so this keeps one test runner across the repo. Worth revisiting when the toolchain
moves.

TypeScript is pinned to the 5.9 line. `typescript-eslint` does not yet support TypeScript
7, and Expo SDK 57 — which `design.md` pins the app to — is built against 5.9.

## Third-party notices

`npm run notices` writes two files from one aggregation:

- `packages/importer/THIRD_PARTY_NOTICES.txt`, distributed with the CLI
- `apps/mobile/assets/third-party-notices.json`, rendered by the app's notices view

Both are committed, and `npm run notices:check` fails if they are stale.

The generator generates rather than collects, which is the whole reason it exists. MIT's
one obligation is notice retention, and several MIT-licensed packages this product depends
on — `react-native-executorch` and `onnxruntime-node` among them — ship no `LICENSE` file
in their npm tarballs. So where a package provides text, that text is reproduced verbatim;
where it does not, the notice is generated from the SPDX text in `licenses/spdx/` and is
labelled as generated, with its copyright holder taken from the package manifest.

Two behaviours are deliberate. A package whose license cannot be resolved **fails the
build** rather than being quietly omitted, with a message naming the file to add. And the
model notice's license text is checked against the sha256 recorded in
`licenses/model-artifacts.json`, so if the shipped text and the compliance record ever
diverge, generation stops.

The in-app view that renders the JSON belongs to the app phase; this repo only guarantees
the data exists and stays current.
