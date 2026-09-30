# Phase 0 spikes

Throwaway code. Nothing here is intended to survive into `packages/` or
`apps/`. Its only job is to convert an assumption in `design.md` into a fact
before a later phase depends on it.

## 0.1 On-device CLIP text encoder

**Open question being closed:** design.md open question 1. Image embeddings via
`CLIP_VIT_BASE_PATCH32_IMAGE` were already assumed to work; the *text* tower is
what Requirements 5.2 (query text never leaves the device) and 5.7 (search works
offline) actually rest on. If no text tower can run on-device, query embedding
moves server-side and both requirements break.

### Layout

| Directory | Purpose | Runs where |
|---|---|---|
| `clip-probe-core/` | Fixtures, vector maths, and the cross-modal scoring harness. No React Native and no ONNX imports. | Anywhere |
| `clip-text-encoder/` | Expo app that drives the harness through `react-native-executorch`. | iOS / Android device |
| `clip-text-encoder-reference/` | Same harness, same fixtures, driven through `onnxruntime-node`. | Any dev machine |

The split exists so that one question can be answered without a phone and the
other cannot be accidentally conflated with it:

- **Does CLIP's text tower share an embedding space with its image tower?** A
  property of the *model*. Answerable off-device, and answered — see below.
- **Does `react-native-executorch` expose that text tower on iOS and Android?** A
  property of the *runtime*. Requires a physical device.

Both runs are graded by the *same* `runCrossModalProbe` over the *same*
byte-identical generated fixtures, so a divergence between them isolates the
runtime rather than the input data.

---

### Running the off-device reference

Requires roughly 156 MB of downloads and no GPU.

```sh
cd spikes/clip-text-encoder-reference
npm install

mkdir -p .models
# Full CLIPModel export. The full model is required, not vision_model/text_model:
# those omit the projection heads, and their outputs are NOT in the joint space.
curl -L -o .models/clip_full_quantized.onnx \
  https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/model_quantized.onnx
curl -L -o .models/tokenizer.json \
  https://huggingface.co/software-mansion/react-native-executorch-clip-vit-base-patch32/resolve/v0.9.0/tokenizer.json

npm run reference           # the probe
npm run dump-fixtures       # optional: write the fixtures out as PNGs to eyeball
```

Unit tests for the scoring logic:

```sh
cd spikes/clip-probe-core && npm install && npm test
```

### Running the on-device probe

`react-native-executorch` ships native code, so Expo Go will not work; the app
needs a development build.

```sh
cd spikes/clip-text-encoder
npm install
npx expo prebuild --clean

npx expo run:ios      # a physical device is required, see the note below
npx expo run:android
```

Then press **Run probe** and read the screen. Record four things in
`design.md`:

1. Whether the text encoder **loaded at all**. This is the actual question.
2. The **verdict** and the per-caption ranks.
3. The **declared input shapes** the app prints for the text model. These settle
   a contradiction found by reading the library source — see below.
4. The **mean text embed time**, which is the fixed cost added to every search
   before any vector scanning, and so feeds Requirement 5.3's 300 ms budget.

Run on **both** platforms. Two reasons a simulator run is not sufficient: the
iOS simulator is restricted to the XNNPACK backend, so it cannot exercise a
Core ML path, and simulator CPU performance says nothing about the timing
budget.

---

## Findings

Everything below marked **verified** was established by reading published source
or by executing code. Everything marked **unverified** needs a device.

### Verified: a CLIP text encoder is a first-class model in the runtime

From `react-native-executorch@0.9.3` (read from the published npm tarball, not
from documentation):

- `'clip-vit-base-patch32-text'` is a member of the `TextEmbeddingsModelName`
  union in `src/types/textEmbeddings.ts`, and `CLIP_VIT_BASE_PATCH32_TEXT` is
  exported from `src/constants/modelUrls.ts` with both a `modelSource` and a
  `tokenizerSource`. It is a supported preset, not a custom export we would have
  to wire up ourselves.
- The library's own API reference describes it as mapping text into the
  "512-dimensional joint text-image embedding space", to be used together with
  the image encoder for text-to-image search. That is exactly the product's
  search path.
- In 0.9.3 both towers resolve to a **single XNNPACK fp32 artifact**. XNNPACK is
  the cross-platform CPU backend and is also the only backend available on the
  iOS simulator, so one artifact serves iOS and Android with no platform-specific
  code path that could diverge. Core ML and Vulkan variants of the text tower
  exist on the model repo's `main` branch but are not referenced by 0.9.3.
- Weights are **MIT** (`xnnpack/config.json` declares `"license": "mit"`, and the
  Hugging Face repo card agrees), which satisfies Requirement 11.4. This is
  evidence toward task 0.3 but does not close it; 0.3 also wants the license text
  and provenance recorded in the repo.

### Verified: the two towers do share an embedding space

Established off-device, by executing `npm run reference` against MIT-licensed
OpenAI CLIP ViT-B/32:

```
verdict : PASS
text->image top-1 100%, image->text top-1 100% (chance 20% over 5 cases)
matched cosine 0.3461 vs mismatched 0.2490, separation 0.0971
image dim 512, text dim 512
```

This used the **uint8-quantized** export. Quantization can only reduce
separation relative to fp32, so this is a lower bound.

**A correction to how task 0.1 is worded.** The task asks to verify that
matching text and image embeddings produce "high cosine similarity". Taken
literally that is the wrong test and would produce a misleading answer. CLIP's
contrastive objective optimizes a temperature-scaled softmax over a similarity
*matrix*, not the absolute magnitude of any single cosine. The measured numbers
above are the reality: a correct match sits at ~0.35 and a deliberate mismatch at
~0.25. A threshold of 0.8 would reject a perfectly working model; a threshold of
0.15 would accept a broken one. The harness therefore reports raw cosines for
inspection but bases its verdict on **retrieval ranking**, which is both
diagnostic and the property Requirements 5.1 and 5.3 actually depend on.

### Verified: image preprocessing does not match what CLIP expects

Reading `common/rnexecutorch/data_processing/ImageProcessing.cpp`, the
`ImageEmbeddings` path calls the two-argument `getTensorFromMatrix`, which
resolves to `colorMatToVector(mat, mean=0, std=1)` — a plain divide by 255. CLIP
expects channel normalization with mean `[0.481, 0.458, 0.408]` and std
`[0.269, 0.261, 0.276]`. The resize is also a plain bilinear stretch to
224 × 224, with no aspect-preserving center crop.

So either the shipped `.pte` bakes normalization in, or on-device image
embeddings are computed on differently-scaled input than the model was trained
on. The reference run measures the cost of the latter:

| | text→image top-1 | separation |
|---|---|---|
| CLIP channel normalization | 100% | 0.0971 |
| Plain /255 | 100% | 0.0764 |

Roughly a 21% loss of margin, with ranking still intact on these fixtures. Not
fatal, and not the main risk. **The main risk is divergence, not degradation:**
the importer (task 2.9) computes vectors with `onnxruntime-node`, the app with
ExecuTorch, and the design requires the two be directly comparable. Whichever
convention the runtime actually uses, the importer must match it exactly —
including the stretch-resize. Task 2.9's parity assertion should compare against
a fixture rendered by `clip-probe-core`, not merely check that both produce
512 numbers.

### Verified: nothing is L2-normalized natively

`BaseEmbeddings::postprocess` returns the raw first output tensor for both
towers, with no pooling and no normalization. Normalization is the caller's job.
The design already specifies an L2 normalize before `project()`, so this is
consistent — worth stating explicitly so it is not assumed to be handled.

### Unverified, and the reason a device run is still required

A contradiction that source cannot resolve:

- `xnnpack/config.json` in the model repo declares the text method as taking
  **one** input, shape `[1, 77]`, dtype int64.
- `TextEmbeddings::generate` in the runtime passes **two** int64 tensors,
  `(input_ids, attention_mask)`, each sized to the tokenizer's *actual* output
  length. There is no padding to 77, and there is no CLIP-specific branch: the
  text runner is entirely generic across all seven text-embedding presets.
- The bundled `tokenizer.json` has `padding: null`, so nothing pads on the way
  in either.

If the `.pte` genuinely takes one `[1, 77]` tensor, `forward` will fail on input
count or shape. If it was exported to accept `(ids, mask)` with a dynamic
sequence dimension, it will work. The spike prints the model's declared input
shapes via `getInputShape`, which answers this directly on first run.

Two smaller unverified items in the same area:

- The generic runner derives its attention mask as `token != 0`. Token id 0 is
  `!` in the CLIP vocab, not a pad token — CLIP pads with `<|endoftext|>`
  (49407). So a caption containing `!` has that position masked out. Harmless
  for typical queries, but it confirms the runner was not written with CLIP in
  mind.
- CLIP pools the hidden state at the end-of-text position rather than
  mean-pooling. Since the runner does no pooling at all and the declared output
  is `[1, 512]`, pooling and projection must both live inside the `.pte`. The
  512-dimensional output is consistent with that. The cross-modal probe is what
  confirms it.

### Fallbacks, evaluated in the order the task specifies

**1. ONNX Runtime text encoder — viable, and recommended as the fallback.**
`onnxruntime-react-native` is officially published by Microsoft (1.24.3 stable at
time of writing) and supports both platforms. A significant advantage specific to
this project: the importer already runs CLIP under `onnxruntime-node` for task
2.9, so using ONNX Runtime on device too puts *both* sides of the parity
requirement on the same inference stack, which removes a whole class of
importer-versus-device drift. Two costs. First, tokenization becomes ours: CLIP's
BPE would need a JS implementation, and the one in
`clip-text-encoder-reference/clipTokenizer.ts` is ASCII-only by deliberate
choice, so shipping it would mean completing the byte-level mapping. Second, the
artifact must be chosen carefully — `text_model.onnx` omits the projection head
and its output is **not** in the joint space, which would produce a plausible
looking 512-dimensional vector that silently fails to match images. The full
`CLIPModel` export, or a text export that includes `text_projection`, is
required.

**2. Separately bundled text tower — the fallback to the fallback.** Export the
text tower to ExecuTorch ourselves and load it through
`TextEmbeddingsModule.fromCustomModel`, or through `ExecutorchModule` for full
control of the input tensors. This is the only option that keeps a single
inference runtime on device if the preset turns out to be broken, and controlling
the export is what would let us fix the `[1, 77]` mismatch at its source. It
costs an export pipeline plus the same tokenizer work as option 1, and the
library documents the custom-model tensor contract as informal and subject to
change between releases.

**Not recommended: moving query embedding server-side.** This is the outcome the
spike exists to avoid. It would break Requirement 5.2 outright and Requirement
5.7 in practice, and it would put a developer-operated component in the search
path, which contradicts Requirement 13.5. Given that option 1 is a working
cross-platform runtime with the weights already available, this should not be
reached for.

### Risk to Requirements 5.2 and 5.7

**Low.** Both requirements need *an* on-device CLIP text encoder, not
specifically `react-native-executorch`'s. There are now two independent viable
paths (the runtime preset, and ONNX Runtime), the model-level premise is
confirmed by execution rather than assumed, and the weights are MIT. No
requirement change is warranted on present evidence.

The residual risk is scoped to runtime plumbing, and its worst realistic outcome
is a change to the design's technology-selection table — swapping the on-device
inference row for one embedding path — not a change to what the product
promises.

---

## 0.2 FTS5 availability and HEIC handling

**Open questions being closed:** design.md open questions 2 and 4. Requirement 5.4
says OCR text must be searchable, and the design's `ocr_fts` virtual table is how.
If `expo-sqlite` does not ship FTS5, that schema is unusable. Separately, HEIC is
the format iPhones capture in, so if it cannot be decoded in React Native then no
thumbnail, preview, embedding, or OCR can be produced on device at all — which
would take out most of Phase 7 rather than just Requirement 5.4.

### Layout

| Directory | Purpose | Runs where |
|---|---|---|
| `sqlite-heic-probe-core/` | OCR corpus, FTS5 capability detector, both index implementations, grading harness, downscale geometry. No expo and no `node:sqlite` imports. | Anywhere |
| `sqlite-fts-reference/` | Same corpus, same indexes, same grading, driven through `node:sqlite`. | Any dev machine |
| `sqlite-heic-probe/` | Expo app. Runs the same search harness through `expo-sqlite`, plus the HEIC decode and downscale probe. | iOS / Android device |

The split is the same one spike 0.1 used, for the same reason — it separates a
question about a *library* from a question about a *runtime*:

- **Does FTS5, as the design declares it, behave the way the design assumes?** A
  property of SQLite. Answerable off-device, and answered below.
- **Does the SQLite that `expo-sqlite` actually ships expose FTS5 on iOS and
  Android?** A property of the shipped native binary. Needs a device.

Node's bundled SQLite makes the first question genuinely answerable here: Node
22.19.0 reports `sqlite_version()` 3.50.4 with `ENABLE_FTS5`, and the amalgamation
`expo-sqlite@57.0.2` vendors is 3.50.3 built with `-DSQLITE_ENABLE_FTS5=1`. One
patch release apart, same module.

---

### Running the off-device reference

No downloads, no native build.

```sh
cd spikes/sqlite-fts-reference
npm install
npm run reference
```

Unit tests for the tokenizer, the query parser, the BM25 idf, and the downscale
geometry:

```sh
cd spikes/sqlite-heic-probe-core && npm install && npm test
```

### Running the on-device probe

`expo-sqlite` and `expo-image-manipulator` ship native code, so Expo Go will not
work; the app needs a development build. Fixtures are generated rather than
committed, so generate them first.

```sh
cd spikes/sqlite-heic-probe
npm install
npm run make-fixtures     # writes assets/fixture-12mp.{heic,jpg}, needs macOS sips
npx expo prebuild --clean

npx expo run:ios          # physical device preferred, see below
npx expo run:android
```

`make-fixtures` drives the macOS HEIF encoder through `sips`. On Linux use
`heif-enc -q 80 fixture.png -o fixture-12mp.heic` from `libheif-examples`, or
`ffmpeg -i fixture.png -c:v libx265 -tag:v hvc1 fixture-12mp.heic`. The encoder
matters less than it looks: the fixture proves the *decoder* exists, and the
photo-library source is what exercises real camera files.

Then press the three buttons in order and record:

1. **`sqlite_version()` and the `ENABLE_FTS5` compile flag.** The direct answer to
   open question 2. A version other than 3.50.3 is itself a finding — see below.
2. **The search verdict and the fallback-versus-FTS5 agreement line.**
3. **The tokenizer output**, specifically whether the CJK run appears as one token
   or several.
4. **The HEIC table**, comparing `full-decode` against `subsampled-decode` for
   decoded megabytes and elapsed time, and whether the photo-library source was
   skipped and why.
5. **Whether the concurrency stress survived.** Run it last: if it is killed for
   memory, that is the result, and a killed process reports nothing.

Run on **both** platforms. A simulator run is worth something here, unlike in
spike 0.1 — the FTS5 question is about a compile flag that does not vary by
architecture — but it cannot answer the HEIC half: the Android emulator's decoder
and heap limits are not a device's, and only a real library contains real camera
HEICs with 10-bit depth and HDR gain maps.

---

## Findings

Same convention as 0.1: **verified** means established by executing code or by
reading published source. **Unverified** needs a device.

### Verified by reading published source: FTS5 is compiled in on both platforms

From `expo-sqlite@57.0.2`, read from the npm tarball rather than the docs. The
module vendors its own amalgamation at `vendor/sqlite3/sqlite3.c` (version 3.50.3
per `sqlite3.h`) and compiles it as part of itself on both platforms, rather than
linking the platform's SQLite.

- **iOS**, `ios/ExpoSQLite.podspec`:
  `unless podfile_properties['expo.sqlite.enableFTS'] == 'false'` appends
  `-DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1`
  to `OTHER_CFLAGS`, and mirrors every flag into `OTHER_SWIFT_FLAGS` as `-Xcc`.
- **Android**, `android/build.gradle`:
  `if (findProperty('expo.sqlite.enableFTS') != 'false')` appends the same three
  flags to `SQLITE_BUILDFLAGS`, which `android/CMakeLists.txt` applies via
  `add_compile_options` to the same vendored `sqlite3.c`.

So FTS5 is **opt-out, not opt-in**, and the two platforms are configured
symmetrically from one source file. `SQLITE_ENABLE_MATH_FUNCTIONS` is on
unconditionally on both, which is worth knowing separately.

Three caveats that came out of the same reading, and that matter more than the
headline:

- **It is a build-configuration property, not a library property.** Setting
  `expo.sqlite.enableFTS: false` through `expo-build-properties` removes FTS5, and
  so does `expo.sqlite.useLibSQL: true`, which swaps in a prebuilt
  `libsql.xcframework` / `libsql_experimental.so` whose FTS5 status these flags do
  not control. Neither is something we would do deliberately, and both are exactly
  the kind of thing that regresses silently in someone else's pull request. The
  capability check in `sqlite-heic-probe-core/src/capability.ts` should not stay in
  this throwaway app: it belongs in task 1.3's migration runner as a startup
  assertion.
- **The web build does not have FTS5.** `web/wa-sqlite/wa-sqlite.wasm` contains no
  `fts5` symbols. Irrelevant to v1, which is iOS and Android, but the deferred web
  client would need the fallback rather than the primary — one more reason the
  fallback is worth having working rather than merely designed.
- **On iOS, `sqlite_version()` is the cheap tripwire.** Apple's own `libsqlite3`
  also enables FTS5, so if the vendored amalgamation ever lost a symbol race,
  everything would still work and `compile_options` would still list `ENABLE_FTS5`
  — they would just be Apple's options, several minor versions behind, with the
  podspec's flags silently not applying. The probe therefore pins the expected
  version at 3.50.3 and reports any mismatch as a finding.

### Verified by executing code: the design's schema and query plan are sound

`npm run reference` against SQLite 3.50.4:

```
node:sqlite (node v22.19.0) · SQLite 3.50.4 · verdict PASS
FTS5: compile flag present, design DDL ok, diacritic folding ok, bm25 ok, prefix ok
fts5        : pass · recall 100% · top-1 100% · forbidden hits 0 · mean query 0.2 ms
token-table : pass · recall 100% · top-1 100% · forbidden hits 0 · mean query 0.1 ms
fallback vs FTS5: same result set on 9/9 queries, same order on 9/9
```

The design's `ocr_fts` declaration is used verbatim, including
`tokenize='unicode61 remove_diacritics 2'`. Diacritic folding works in both
directions — `cafe` finds `Café` and `café` finds `CAFE` — prefix queries anchor at
token starts so `board*` does not match `whiteboard`, and `bm25()` returns the
negated score the ranking depends on.

### Verified by executing code: the fallback is a real substitute, not a sketch

The design already named the fallback as "a normalized token table with manual
ranking". It is now implemented and measured rather than assumed:

```sql
CREATE TABLE ocr_docs   (hash TEXT PRIMARY KEY, token_count INTEGER NOT NULL);
CREATE TABLE ocr_tokens (token TEXT NOT NULL, hash TEXT NOT NULL, tf INTEGER NOT NULL,
                         PRIMARY KEY (token, hash)) WITHOUT ROWID;
CREATE INDEX idx_ocr_tokens_hash ON ocr_tokens(hash);
```

`WITHOUT ROWID` keyed on `(token, hash)` makes the table itself the inverted index:
postings are physically clustered by token, so a term lookup is one contiguous
range scan and a prefix lookup is the same scan over a wider range. A rowid table
plus a separate index would store every posting twice.

It matched FTS5's result set **and** its ordering on 9 of 9 queries. That is the
number that makes it trustworthy — writing a fallback is easy, and knowing it ranks
identically to the thing it replaces is the part that usually gets skipped.

Two deliberate design decisions inside it:

- **idf is computed in JS, scoring and top-k stay in SQL.** idf needs only the
  corpus size and each term's document frequency, both cheap. Everything that
  touches posting lists stays in SQL, because shipping whole posting lists into JS
  to sort them there is what would make this unusable at 500,000 assets. Keeping
  `log()` out of SQL also means the fallback needs no build flags of its own — a
  fallback that requires its own configuration is answering the wrong question.
- **No positions are stored**, so there are no phrase queries and no `NEAR`. That
  is the fallback's real functional gap. The design does not use either — it fuses
  FTS rank with vector rank via reciprocal rank fusion rather than asking users for
  phrase syntax — so this is an omission with a reason, and adding positions later
  is a migration rather than a redesign.

### Verified by executing code: `unicode61` cannot retrieve CJK substrings

This is the one place the design's assumption does not hold, and it was found by
reading the tokenizer's actual output rather than by reasoning about it. Indexing
`東京都渋谷区の看板 Shibuya ward sign 12.50 SFO-NRT` and reading `fts5vocab`:

```
12 | 50 | nrt | sfo | shibuya | sign | ward | 東京都渋谷区の看板
```

`unicode61` classifies Han and kana as alphanumeric, so an unbroken CJK run becomes
a **single token**. Querying `渋谷` returns nothing. Neither does `渋谷*`, because a
prefix has to match a token start and this run's only token starts at `東`. So OCR
of Japanese or Chinese signage indexes but does not retrieve — the text is stored,
searching for any part of it fails silently, and nothing in the system reports a
problem.

Silence is what makes this worth flagging. The fallback splits CJK runs per
character and retrieves `渋谷` correctly, so **the fallback is strictly better than
the primary on non-Latin OCR**. That inverts the usual framing: the token table is
not only insurance against a missing compile flag, it is the better index for part
of the input space.

Options, none of which need deciding now:
1. Accept it. Latin-script OCR is unaffected, and Requirement 5.4 does not name a
   script.
2. Index CJK text into the fallback table alongside FTS5, and union at query time.
3. Emit CJK character bigrams into a second FTS5 column at index time, which is the
   conventional workaround and needs no custom tokenizer.
4. Register a custom FTS5 tokenizer, which `expo-sqlite` gives no API for.

Option 3 is the cheapest thing that keeps one index. This belongs with task 6.4 and
should be a decision, not a discovery made after shipping.

### Verified by reading published source: HEIC decodes on both platforms

Not in doubt on either platform, and no exotic dependency is involved.

- **iOS.** `expo-image-manipulator@57.0.16`'s `loadImage(atUrl:)` reads a local file
  with `UIImage(data:)` — ImageIO, which has decoded HEIC since iOS 11. The source
  carries the comment *"Read local files directly so UIKit preserves HEIC/EXIF
  orientation metadata"*. The pod's floor is iOS 16.4, so every supported version
  has the decoder. A `ph://` URL takes a different path: PhotoKit
  `requestImage` with `isNetworkAccessAllowed = true` and
  `deliveryMode = .highQualityFormat`, which means the ingest path can hand over an
  asset reference and never touch a HEIC *file*.
- **Android.** `expo-image-manipulator` delegates to `expo-image-loader`, which is
  Glide 5.0.5 (`Glide.with(context).asBitmap()`), which decodes through
  `BitmapFactory`. `BitmapFactory` gained HEIF support in **API 28**, and Glide's
  own `RegistryFactory` registers `ExifInterfaceImageHeaderParser` only on
  `O_MR1+` with the comment *"Right now we're only using this parser for HEIF
  images, which are only supported on OMR1+"*.

WebP output, which the design's `{sub}/th/{hash}.webp` and `{sub}/pv/{hash}.webp`
keys require, is present on both: `Bitmap.CompressFormat.WEBP` on Android, and
`SDImageWebPCoder` — vendored into `expo-image-manipulator`'s prebuilt xcframeworks
— on iOS.

**One gap: Expo SDK 57's `minSdkVersion` defaults to 24.** Read from
`expo-modules-autolinking`'s `ExpoRootProjectPlugin.kt`:
`versionCatalogs.getVersionOrDefault("minSdk", "24")`. API 24 through 27 have no
platform HEIF decoder, so the app installs on devices where HEIC decode fails.
The exposure is narrow — an Android phone whose own camera writes HEIC is API 28+
by construction, and the app displays WebP derivatives rather than originals — but
it is not zero, since a HEIC can arrive on an old device by download or transfer.
Either raise `minSdkVersion` to 26 or higher via `expo-build-properties` and accept
API 24–25 still failing, or treat an undecodable original as
`local_assets.hash_state = unreadable`, which the schema already provides for. The
second is the correct handling regardless, and the design's error-handling table
should have a row for it.

### Verified by reading published source: the risk is the decode shape, not HEIC

`ImageManipulator.manipulate(uri).resize({ width: 256 })` decodes the **whole**
image and then scales the bitmap down. On Android, `CustomTarget`'s no-argument
constructor requests `SIZE_ORIGINAL`; on iOS, `UIImage(data:)` has no size
parameter to give. A 12 megapixel original is 48.8 MB as ARGB_8888 and a 48
megapixel one is 195 MB, and the design runs `Derive` at `min(4, cores-1)`
concurrency. Four concurrent full-resolution decodes is enough to exhaust the heap
on a mid-tier Android device before React Native's own footprint is counted — and
it is pure waste, since the output is 256 px on its longest edge.

**The mitigation is a supported API rather than a workaround**, and it is verified
in source on both platforms. `expo-image`'s
`Image.loadAsync(uri, { maxWidth, maxHeight })` constrains the decode itself:

- iOS, `ImageLoader.swift` sets `context[.imageThumbnailPixelSize]`, which
  SDWebImage implements with `CGImageSourceCreateThumbnailAtIndex` and
  `kCGImageSourceThumbnailMaxPixelSize`. Both symbols, along with `public.heic` and
  `public.heif`, are present in the SDWebImage binary that ships inside
  `expo-image-manipulator`'s prebuilt xcframework — checked in the artifact, not
  inferred from SDWebImage's docs. The full-resolution bitmap is never
  materialized.
- Android, `ImageLoadTask.kt` calls `.submit(maxWidth, maxHeight)`, which Glide
  turns into `BitmapFactory`'s `inSampleSize`, so the decoder subsamples as it
  reads.

The result is an `ImageRef`, and `ImageManipulator.manipulate` accepts
`string | SharedRef<'image'>` — on Android its native signature is
`EitherOfThree<Uri, SharedRef<Bitmap>, SharedRef<Drawable>>`. So the two modules
hand off without a second decode. **This is the path task 7.3 should use.** The
probe runs both so the difference is a measurement rather than an argument.

One trap for whoever writes task 7.3: `ImageRef.width` and `.height` are *logical*
units, and pixels are logical times `scale`. On Android `scale` is bitmap density
over screen density and is routinely not 1, so reading the logical values as pixels
understates the decode by the square of the density. `expo-image-manipulator`'s own
`ImageRef`, confusingly, reports pixels on both platforms.

A useful thing noticed in passing: `expo-image` 57 exposes
`Image.generateThumbhashAsync(source)`. Task 5.1 and task 7.3 both need thumbhash,
and this removes a dependency.

### Verified by reading published source: Android redacts EXIF from MediaStore bytes

Found while establishing the Android decode path, and the most consequential thing
in this spike. Glide 5.0.5 ships `QMediaStoreUriLoader` whose own doc comment reads:

> HEIC images on Q cannot be decoded if they've gone through Android's exif
> redaction, due to a bug in the implementation that corrupts the file.

and, about its own workaround:

> This class does not fix applications that target Q, do not opt in to legacy
> storage and that don't have `ACCESS_MEDIA_LOCATION`.

So on Android 10 without `ACCESS_MEDIA_LOCATION`, HEIC decode from MediaStore can
fail outright. That is a Requirement 5.4 problem. But redaction has a much larger
consequence: **redacted bytes are different bytes, so they hash differently.**

The design is content-addressed (Requirement 3.1) and verified reclamation deletes
a local original only after confirming the stored object matches that hash
(Requirement 6). Hashing redacted bytes would mean computing a hash that is not the
original's, uploading the altered copy, verifying *it* successfully, and then
deleting the true original from the device — with every check passing. It would also
break dedupe against the same photo imported from Takeout, which is one of the
product's premises (Requirement 3.2).

`ACCESS_MEDIA_LOCATION` is **not** requested by default:
`expo-media-library`'s config plugin gates it behind `isAccessMediaLocationEnabled`,
default `false`. And `expo-media-library` calls `MediaStore.setRequireOriginal` in
exactly one place — `AssetUtils.getExifLocationForUri`, for reading EXIF location —
not on the path that hands out a URI to read bytes from.

The spike app enables the permission so the photo-library source exercises the real
path. Tasks 4.1, 7.1, and 7.2 need to as well, and task 7.2 needs a test that
hashes the same asset twice, once with the permission and once without, and asserts
the digests match. This is the cheapest possible check for a failure that would
otherwise be silent and irreversible. It is not in scope for task 0.2 to change a
requirement, so it is recorded in the design's open questions as a new item rather
than resolved here.

### Unverified, and the reason a device run is still required

- **That the compile flags survive into a built app on each platform.** The flags are
  in the podspec and the gradle file; whether the app that comes out of
  `expo prebuild` has them is a different statement. `sqlite_version()` and
  `PRAGMA compile_options`, both printed by the probe, settle it in one screen.
- **That nothing on iOS links Apple's `libsqlite3` in place of the vendored
  amalgamation.** Same screen, via the version number.
- **What a HEIC decode actually costs, and whether the naive path survives the
  design's `Derive` concurrency.** All the numbers here are arithmetic on pixel
  counts. The gap between `full-decode` and `subsampled-decode` on a real device is
  what decides how much of task 7.3 has to be written carefully rather than simply.
- **That real camera HEIC works, not just a generated one.** 10-bit depth, HDR gain
  maps, and Live Photo containers are all absent from the fixture. The
  photo-library source covers this, and reports a skip rather than a pass when it
  cannot.
- **Whether Android's EXIF redaction changes the bytes in practice**, and by
  extension the hash. The probe surfaces the path; proving the hash consequence is
  task 7.2's job and needs the test described above.

The JS half of the app is verified as far as it can be without a native toolchain:
`tsc --noEmit` is clean and `expo export` bundles for both iOS and Android with both
fixtures resolved.

### Risk to Requirement 5.4

**Low.** Requirement 5.4 needs OCR text to be searchable, not specifically FTS5.
There are now two working indexes behind one interface, the primary is enabled by
default on both platforms by an opt-out flag read from the shipped build
configuration, and the fallback has been measured to return the same documents in
the same order — and to be better on CJK. The residual risk is that a build
configuration change removes FTS5, and the answer to that is a startup assertion in
task 1.3 rather than a design change.

HEIC carries no requirement risk either: decode exists on both platforms through
ordinary Expo modules, WebP output exists on both, and a subsampled decode path is
available and is the one to use. The `minSdkVersion` 24 gap and the Android EXIF
redaction issue are both real, but neither changes what the product promises —
the first is an unreadable-asset case the schema already models, and the second is a
permission to request and a test to write.

The one finding that could change a requirement is not about task 0.2's questions at
all: EXIF redaction versus content addressing touches Requirements 3.1, 3.2, and 6,
which is why it is recorded as a new open question rather than closed here.
