# Model licensing record

This directory is the compliance record for Requirement 11.4: every ML model
artifact the product ships, or causes a user's device to download, carries a
license permitting commercial use, and no research-only weights are shipped.

It is deliberately **not** in `spikes/`. The spikes are throwaway; this has to
outlive them, and it has to be updatable by whoever bumps a model version
without re-deriving all of it.

- `model-artifacts.json` — machine-readable inventory: every artifact, its
  pinned revision, its size, its digest, and the license declared at its source.
- `models/openai-clip-mit.txt` — the verbatim license text, byte-for-byte as
  retrieved. This is the file whose contents must appear in the shipped app.
- `spdx/` — SPDX license texts, used to *generate* a notice for a package that
  declares a license but ships no text. `{{copyright}}` is substituted with the
  holder resolved from the package manifest. Adding a license means adding
  `spdx/<SPDX-ID>.txt`; until then the notices generator fails rather than
  omitting the package.

The tooling that consumes all of this lives at `scripts/notices/` and runs as
`npm run notices` (added by task 1.1). See "Notice obligations" below.

Verified for task 0.3. Everything below was established by resolving the actual
constants in the installed package and by retrieving the sources, not from
documentation. Retrieval date **2026-09-07** (UTC, machine clock).

---

## What actually ships

`react-native-executorch` does not bundle weights in its npm package — there is
no `.pte` inside the tarball. The presets are URLs, and the runtime downloads
them to the device on first use. So the artifacts below are *caused to be
downloaded by our app* rather than embedded in our binary. That distinction
affects the notice analysis below but not the license question: either way these
weights are part of the shipped product.

The URLs are not documented anywhere; they are assembled at build time from
template literals. Resolving them means reading
`react-native-executorch@0.9.3`'s `src/constants/versions.ts`
(`URL_PREFIX`, `LIB_VERSION = '0.9.0'`, so `VERSION_TAG = 'resolve/v0.9.0'`)
together with `src/constants/modelUrls.ts`. The resolved set:

| Artifact | Preset / consumer | sha256 | Size |
|---|---|---|---|
| `xnnpack/clip_vit_base_patch32_image_xnnpack_fp32.pte` | `CLIP_VIT_BASE_PATCH32_IMAGE` | `7aab2a60…c421987` | 351.6 MB |
| `xnnpack/clip_vit_base_patch32_image_xnnpack_int8.pte` | `CLIP_VIT_BASE_PATCH32_IMAGE_QUANTIZED` | `7f00a412…d16e2a98` | 96.4 MB |
| `xnnpack/clip_vit_base_patch32_text_xnnpack_fp32.pte` | `CLIP_VIT_BASE_PATCH32_TEXT` | `65824346…0b5643b1` | 254.0 MB |
| `tokenizer.json` | `CLIP_VIT_BASE_PATCH32_TEXT.tokenizerSource` | `593e5dda…35792ca3` | 2.2 MB |
| `onnx/model_quantized.onnx` | importer, task 2.9 — and the on-device fallback | `0898a3fa…17dfc7328` | 153.7 MB |

The first four come from
`software-mansion/react-native-executorch-clip-vit-base-patch32` at tag `v0.9.0`,
which resolves to commit `68bad8b0cb33346612e74d143c5b99242b101053`. The fifth
comes from `Xenova/clip-vit-base-patch32` at commit
`d15189d7028b43f1d3e65039190477f6af591c2a`. Full URLs and untruncated digests
are in `model-artifacts.json`.

The tokenizer is listed as an artifact in its own right. It is a 49408-entry
byte-level BPE vocabulary — a copyrightable asset, not a config file — and it is
easy to overlook because the preset field is named `tokenizerSource` rather than
anything resembling "model".

Two digests were verified against bytes actually retrieved on this machine
(`tokenizer.json` and `model_quantized.onnx`, both already downloaded by the 0.1
spike); `model_quantized.onnx` matched the registry's published digest exactly.
The three `.pte` digests are the ones Hugging Face publishes for that revision
and have not been independently downloaded — together they are 700 MB.

## Provenance chain

```
openai/CLIP  (GitHub)               MIT, "Copyright (c) 2021 OpenAI"
  └─ openai/clip-vit-base-patch32   the reference weights, on Hugging Face
       ├─ software-mansion/react-native-executorch-clip-vit-base-patch32
       │    └─ ExecuTorch .pte conversions + tokenizer copy   ← the app
       └─ Xenova/clip-vit-base-patch32
            └─ ONNX exports                                   ← the importer
```

The middle hop is a claim, and it is worth saying which parts of it are proven.
The `react-native-executorch` model card states in plain text that the repo
hosts `clip-vit-base-patch32` for that library, and `Xenova`'s card declares
`base_model: openai/clip-vit-base-patch32` in its metadata. Neither is
digest-verifiable, because a format conversion changes every byte.

The tokenizer, however, *is* verifiable, and it was verified: the `vocab`,
`merges`, and `added_tokens` of the tokenizer the runtime downloads are
identical, compared field by field, to those in
`openai/clip-vit-base-patch32`'s `tokenizer.json` at revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. That is not proof about the weights,
but it does mean the converted repo demonstrably carries content copied from the
upstream one, which corroborates its account of where the weights came from.
Spike 0.1's measured 512-dimensional joint-space behaviour corroborates it
further.

## The license

MIT. Verbatim text in `models/openai-clip-mit.txt`, sha256
`987e63b32f6c89ff5160e429458a872ff048e6860b590a3912e938f9da8f14db`, retrieved
from `openai/CLIP` at commit `d05afc436d78f1c48dc0dbf8e5980a9d471f35f6`. The
`LICENSE` file itself has not been touched since commit
`b1c4b6be5871f1b94359ba55901627f29ecc9ae9` on 2021-01-05, so the text is stable
rather than a moving target.

MIT grants use, copying, modification, merging, publication, distribution,
sublicensing, and sale without restriction. Commercial use is permitted
unconditionally. The single obligation is notice retention.

### Where the license is, and is not, declared

This is the part that did not match the assumption going in.

- **The converted ExecuTorch repo declares MIT**, in two independent places:
  `license: mit` in the repo card front matter, and `"license": "mit"` in
  `xnnpack/config.json`. Hugging Face also surfaces it as a `license:mit` tag.
- **`openai/clip-vit-base-patch32` declares no license at all.** No `LICENSE`
  file among its twelve files, no `license` key in its card metadata, no
  `license:*` tag, and no mention of the word "license" anywhere in its model
  card.
- **`Xenova/clip-vit-base-patch32` declares no license either.** Its card
  metadata is `base_model` and `library_name` only.

So the artifact the *app* downloads is the only one of the three that says MIT,
and the artifact the *importer* downloads says nothing. MIT for the weights rests
on the `openai/CLIP` source repository, which is where these weights originate
and which is unambiguously MIT with a named copyright holder.

That is a sound basis, and it is also the whole chain — there is no second
independent confirmation for the ONNX path. Two things follow, neither urgent:

1. If the ONNX artifact ever needs to stand on its own, export it ourselves from
   `openai/clip-vit-base-patch32` with Optimum rather than consuming a
   third-party conversion. That reduces the provenance chain to one hop and
   removes a party who has not stated terms.
2. Pin the revision. The 0.1 spike fetches `Xenova/…/resolve/main/…`, and `main`
   moves. A compliance record over a branch name is not a record. Task 2.9
   should fetch by the commit sha in `model-artifacts.json` and check the digest.

## Notice obligations

MIT requires that the copyright notice and the permission notice be included in
all copies or substantial portions of the software. For a shipped app that means
**a notices surface is required, not optional.**

There is a narrow argument that we never redistribute the `.pte` weights — the
device fetches them from Hugging Face itself, and we only ship a URL. The
argument is not worth relying on. We do redistribute the ONNX artifact if the
importer vendors it, we do ship a product built around these weights, and the
cost of complying is one text file. Include the notice regardless.

Concretely:

- The app needs a reachable notices view containing the contents of
  `models/openai-clip-mit.txt`, attributed to OpenAI and identifying CLIP
  ViT-B/32 as the covered work. It should sit alongside the aggregated
  notices for npm dependencies rather than being a separate one-off screen —
  `react-native-executorch` and `onnxruntime-node` are themselves MIT and carry
  the same obligation, and neither ships a `LICENSE` file in its tarball, so
  the aggregation has to be generated rather than collected.
- The importer, being a CLI, satisfies this with a `THIRD_PARTY_NOTICES` file
  distributed alongside it.

### Status: the aggregation exists (task 1.1)

`scripts/notices/` implements it. `npm run notices` writes both outputs from a
single aggregation, so the CLI and the app cannot disagree about what the product
includes:

- `packages/importer/THIRD_PARTY_NOTICES.txt`
- `apps/mobile/assets/third-party-notices.json`

Both are committed, and `npm run notices:check` fails when they are stale.

It generates rather than collects, for the reason recorded above: a package that
declares MIT but ships no `LICENSE` file gets its notice built from
`spdx/MIT.txt`, labelled `generated`, with the copyright holder resolved from the
package manifest's `author` or repository owner. Packages that do ship text have
it reproduced verbatim and labelled `bundled`. A package whose terms cannot be
resolved at all — no text, no template, or a dual-license expression — stops the
build with a message naming the file to add, rather than being dropped from the
notices silently.

The model notice is built from `model-artifacts.json` and carries
`models/openai-clip-mit.txt` attributed to OpenAI for CLIP ViT-B/32, listing every
artifact with its pinned revision. The generator verifies the license text against
the `license.textSha256` recorded here, so a divergence between the shipped text
and this record fails the build. That covers the offline half of the staleness
check described under "Keeping this current"; confirming that each revision still
resolves and still declares the same license needs network access and is not
automated yet.

One field was added to `model-artifacts.json` for this: `license.coveredWork`,
the display name of the licensed work. It changes no claim in the record.

What remains is the app's own notices view, which renders
`third-party-notices.json`. That belongs to the app phase (task 4.1 onward).

## Research-only weights: Requirement 11.4's second clause

Nothing research-licensed is in the graph, and the exclusion the design already
records is now backed by the actual license rather than by reputation.

**Apple MobileCLIP is confirmed research-only.** `apple/MobileCLIP-S2` declares
`license: apple-amlr`, `license_name: apple-ascl`, pointing at
`apple/ml-mobileclip`'s weights license. That file opens by stating the model is
released for the sole purpose of scientific research of AI and ML technology,
and it uses the terms "Research Purposes" and "non-commercial" throughout.
GitHub classifies the repository's license as `NOASSERTION`. It fails
Requirement 11.4 outright, and excluding it is correct.

**It is not reachable from anything we depend on.** `react-native-executorch`'s
`ImageEmbeddingsModelName` union is exactly two members, both
`clip-vit-base-patch32`, and `TextEmbeddingsModelName` is seven members —
`all-MiniLM-L6-v2`, `all-mpnet-base-v2`, two `multi-qa-*`,
`distiluse-base-multilingual-cased-v2`, `paraphrase-multilingual-MiniLM-L12-v2`,
and `clip-vit-base-patch32-text`. No MobileCLIP preset exists to select by
accident. A case-insensitive search across the whole dependency tree returns
`mobileclip` only inside the prebuilt ONNX Runtime shared libraries, and those
hits are graph-optimizer rule names — `TryFuseMobileClipMHA`,
`MobileClipSplitForMHA`, `Fused MobileCLIP attention subgraph` — that is,
compiler code for accelerating someone else's model, containing no weights.

### One tension worth recording rather than burying

CLIP's license and CLIP's model card do not say the same thing about deployment.

The license is MIT and permits commercial use. The model card, separately, states
that any deployed use case of the model — commercial or not — is currently out of
scope, describes the intended users as AI researchers, and notes that the
training dataset was not intended as the basis for any commercial or deployed
model. It also puts surveillance and facial recognition permanently out of scope
regardless of performance.

These are use *recommendations* from the authors, not license terms, and they do
not narrow the MIT grant. Requirement 11.4's first clause is about licenses, and
it is satisfied. But the second clause says research-only weights shall not be
shipped, and a reader could reasonably ask whether a model whose own card says
"not for deployment" counts. The honest answer is that the requirement's own
example — MobileCLIP — is research-only *by license*, which is the reading the
design intends, and CLIP is not that. Worth knowing that the distinction is
license versus card guidance, and that it was noticed rather than missed.

Two things make this comfortable in practice rather than merely arguable. The
surveillance and facial-recognition carve-out is the sharpest part of the card,
and this product does neither: there is no face detection, no recognition, no
identity clustering anywhere in the design. And the use here is retrieval over a
user's own private library, on their own device, which is close to the card's own
example of a constrained non-deployed use — image search in a constrained
environment — and is the opposite of open-ended classification against an
arbitrary taxonomy.

If the card's language ever becomes a commercial concern, the exit is ordinary
rather than dramatic: retrain or swap to an openly-licensed CLIP variant. The
design already versions the embedding model (Requirement 11.5) precisely so a
model swap is a migration.

## Verdict

**Requirement 11.4 is satisfied on the evidence recorded here.** Every shipped
artifact traces to MIT-licensed weights with a named copyright holder, the
license text is now in the repo rather than referenced, the revisions are
pinned to commit shas, and no research-licensed weights are reachable from the
dependency graph.

Two items are follow-on work rather than open risk:

- A notices surface is required by MIT and does not exist yet. Belongs with
  task 1.1.
- Task 2.9 must fetch the ONNX artifact by pinned commit sha and verify its
  digest, not from `main`.

## Keeping this current

This record is only true for the revisions it names. It must be revisited when
`react-native-executorch` is upgraded — `LIB_VERSION` is what builds the model
URLs, so a library bump silently repoints every artifact at a new model
revision — or when the importer's ONNX artifact changes, or when a new model of
any kind is introduced.

The check itself is small enough to automate, and probably should be: for each
entry in `model-artifacts.json`, confirm the revision still resolves, the digest
still matches, and the declared license has not changed.

## Staleness alert (task 6.1)

The tripwire described above has fired. The app now depends on
`react-native-executorch@0.10.2`, whose `NEXT_VERSION_TAG` is `resolve/v0.10.0`,
and the app pins its artifact URLs at that tag explicitly
(`apps/mobile/src/search/clipModelConfig.ts`). Every ExecuTorch artifact the app
will download is therefore at revision `v0.10.0`, while this record still
documents the `v0.9.0` digests. The weights are the same origin and the same
MIT chain, but the recorded digests are no longer digests of the bytes the app
actually fetches — and a compliance record over the wrong bytes is not a record.

Before any build that ships: refresh this inventory against `resolve/v0.10.0` —
fetch each artifact, compute digests locally (`digestVerifiedLocally: true`),
and re-verify the declared license — then automate the check so the next
`LIB_VERSION` bump fails loudly instead of silently.
