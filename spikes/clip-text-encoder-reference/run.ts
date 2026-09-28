/**
 * Off-device reference run for photo-archive task 0.1.
 *
 * ## What this does and does not establish
 *
 * The task asks two separable questions that are easy to conflate:
 *
 *   A. Do CLIP's image and text towers share an embedding space, such that a
 *      typed query can rank images? (a property of the *model*)
 *   B. Does `react-native-executorch` expose the text tower on both iOS and
 *      Android? (a property of the *runtime*)
 *
 * B genuinely requires a device. A does not. This script settles A using the
 * same MIT-licensed OpenAI CLIP ViT-B/32 weights, the same fixtures, and the
 * same scoring code as the on-device spike. If A fails here, no amount of
 * runtime plumbing would have helped, and Requirements 5.2 and 5.7 would be in
 * real trouble. If A passes, the residual risk is narrowed to plumbing.
 *
 * ## The preprocessing comparison
 *
 * Reading `react-native-executorch`'s native image path
 * (`common/rnexecutorch/data_processing/ImageProcessing.cpp`,
 * `colorMatToVector`) shows `ImageEmbeddings` feeds the model pixels scaled to
 * [0,1] with mean 0 and standard deviation 1 -- that is, a plain divide by 255,
 * with *no* CLIP channel normalization. HF's `CLIPModel` expects
 * `pixel_values` already normalized with CLIP's mean/std.
 *
 * So either the shipped `.pte` bakes the normalization in, or on-device image
 * embeddings are computed on differently-scaled input than the model expects.
 * This script runs both normalizations and reports each, which turns "might be a
 * problem" into a number: if plain /255 barely degrades retrieval, the risk is
 * cosmetic; if it collapses, the on-device run must be checked specifically for
 * this and the importer (task 2.9) must match whichever convention wins.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';

import {
  FIXTURES,
  FIXTURE_SIZE,
  renderRgb,
  runCrossModalProbe,
  type Encoders,
  type ProbeCase,
  type ProbeReport,
  type SyntheticFixture,
} from '../clip-probe-core/src/index.ts';
import { ClipTokenizer, CONTEXT_LENGTH } from './clipTokenizer.ts';
import { encodePng } from './png.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = join(HERE, '.models');
const MODEL_PATH = join(MODELS, 'clip_full_quantized.onnx');
const TOKENIZER_PATH = join(MODELS, 'tokenizer.json');

/** OpenAI CLIP's image channel normalization, per its preprocessor_config. */
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const;
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const;

type Normalization = 'clip-mean-std' | 'plain-divide-255';

/**
 * Converts packed RGB bytes (HWC) to the CHW float tensor CLIP expects.
 * Shares its input with the on-device run by construction: both start from
 * `renderRgb`.
 */
function toPixelValues(rgb: Uint8Array, mode: Normalization): Float32Array {
  const pixels = FIXTURE_SIZE * FIXTURE_SIZE;
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    for (let c = 0; c < 3; c++) {
      const scaled = rgb[i * 3 + c]! / 255;
      out[c * pixels + i] =
        mode === 'clip-mean-std' ? (scaled - CLIP_MEAN[c]!) / CLIP_STD[c]! : scaled;
    }
  }
  return out;
}

interface ClipSession {
  session: ort.InferenceSession;
  tokenizer: ClipTokenizer;
  /** A zero-cost dummy for whichever tower we are not reading. */
  inputNames: readonly string[];
  outputNames: readonly string[];
}

async function openClip(): Promise<ClipSession> {
  for (const path of [MODEL_PATH, TOKENIZER_PATH]) {
    if (!existsSync(path)) {
      throw new Error(
        `missing ${path}\nRun the download step in README.md before this script.`
      );
    }
  }
  const session = await ort.InferenceSession.create(MODEL_PATH);
  return {
    session,
    tokenizer: new ClipTokenizer(TOKENIZER_PATH),
    inputNames: session.inputNames,
    outputNames: session.outputNames,
  };
}

/**
 * `CLIPModel` is a single graph taking both towers' inputs and returning both
 * projected embeddings. We therefore always feed both, and read whichever output
 * we want. Feeding a fixed neutral value to the unused tower keeps the two
 * directions independent: `image_embeds` does not depend on `input_ids`.
 */
async function forward(
  clip: ClipSession,
  pixelValues: Float32Array,
  inputIds: BigInt64Array,
  attentionMask: BigInt64Array
): Promise<{ imageEmbeds: Float32Array; textEmbeds: Float32Array }> {
  const feeds: Record<string, ort.Tensor> = {
    pixel_values: new ort.Tensor('float32', pixelValues, [
      1,
      3,
      FIXTURE_SIZE,
      FIXTURE_SIZE,
    ]),
    input_ids: new ort.Tensor('int64', inputIds, [1, CONTEXT_LENGTH]),
    attention_mask: new ort.Tensor('int64', attentionMask, [1, CONTEXT_LENGTH]),
  };
  for (const name of clip.inputNames) {
    if (!(name in feeds)) {
      throw new Error(
        `the model expects an input this script does not supply: "${name}" ` +
          `(known: ${Object.keys(feeds).join(', ')})`
      );
    }
  }

  const results = await clip.session.run(feeds);
  const imageEmbeds = results['image_embeds'];
  const textEmbeds = results['text_embeds'];
  if (!imageEmbeds || !textEmbeds) {
    throw new Error(
      `expected projected embeddings; the graph returned ` +
        `[${clip.outputNames.join(', ')}]. A bare text_model/vision_model ` +
        `export omits the projection heads and its outputs are NOT in the ` +
        `joint space.`
    );
  }
  return {
    imageEmbeds: new Float32Array(imageEmbeds.data as Float32Array),
    textEmbeds: new Float32Array(textEmbeds.data as Float32Array),
  };
}

/** A caption that is neutral filler for runs where we only read image_embeds. */
const NEUTRAL_CAPTION = 'a photo';

async function probeWithNormalization(
  clip: ClipSession,
  mode: Normalization
): Promise<ProbeReport> {
  const neutral = clip.tokenizer.encode(NEUTRAL_CAPTION);
  const blank = new Float32Array(3 * FIXTURE_SIZE * FIXTURE_SIZE);

  const encoders: Encoders<Float32Array> = {
    async embedImage(pixelValues) {
      const { imageEmbeds } = await forward(
        clip,
        pixelValues,
        neutral.inputIds,
        neutral.attentionMask
      );
      return imageEmbeds;
    },
    async embedText(caption) {
      const encoded = clip.tokenizer.encode(caption);
      if (encoded.truncated) {
        throw new Error(`caption exceeded the context window: "${caption}"`);
      }
      const { textEmbeds } = await forward(
        clip,
        blank,
        encoded.inputIds,
        encoded.attentionMask
      );
      return textEmbeds;
    },
  };

  const cases: ProbeCase<Float32Array>[] = FIXTURES.map((fixture) => ({
    id: fixture.id,
    caption: fixture.caption,
    image: toPixelValues(renderRgb(fixture), mode),
  }));

  return runCrossModalProbe(encoders, cases);
}

function printReport(label: string, report: ProbeReport): void {
  console.log(`\n=== ${label} ===`);
  console.log(`verdict : ${report.verdict.toUpperCase()}`);
  console.log(`summary : ${report.summary}`);
  console.log(`dims    : image ${report.imageDim}, text ${report.textDim}`);

  if (report.matrix.length > 0) {
    const width = 16;
    console.log('\ncosine(image row, caption column):');
    console.log(
      ' '.repeat(width) +
        report.caseIds.map((id) => id.padStart(width)).join('')
    );
    report.matrix.forEach((row, i) => {
      const cells = row
        .map((v, j) => (i === j ? `[${v.toFixed(4)}]` : ` ${v.toFixed(4)} `))
        .map((s) => s.padStart(width))
        .join('');
      console.log(report.caseIds[i]!.padEnd(width) + cells);
    });
    console.log('\n(diagonal = the matching pair)');

    console.log('\nper caption (text -> image, the direction search uses):');
    for (const row of report.perCaption) {
      const ok = row.rankOfCorrectImage === 1 ? 'ok  ' : 'MISS';
      console.log(
        `  ${ok} rank ${row.rankOfCorrectImage}  cos ${row.matchedCosine.toFixed(4)}  ` +
          `top="${row.topImageId}"  "${row.caption}"`
      );
    }
  }
}

function dumpFixtures(): void {
  const dir = join(HERE, 'fixture-previews');
  mkdirSync(dir, { recursive: true });
  for (const fixture of FIXTURES as readonly SyntheticFixture[]) {
    const png = encodePng(FIXTURE_SIZE, FIXTURE_SIZE, fixture.shade);
    writeFileSync(join(dir, `${fixture.id}.png`), png);
  }
  console.log(`Wrote ${FIXTURES.length} fixture previews to ${dir}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--dump-fixtures')) {
    dumpFixtures();
    return;
  }

  const clip = await openClip();
  console.log('model inputs :', clip.inputNames.join(', '));
  console.log('model outputs:', clip.outputNames.join(', '));
  console.log(
    '\nNote: this run uses the uint8-quantized CLIPModel export. Quantization\n' +
      'can only make separation worse than fp32, so a pass here is a lower\n' +
      'bound on the real model.'
  );

  const withClipNorm = await probeWithNormalization(clip, 'clip-mean-std');
  printReport("CLIP's own channel normalization (what the model expects)", withClipNorm);

  const withPlainScale = await probeWithNormalization(clip, 'plain-divide-255');
  printReport(
    'Plain /255, no channel normalization (what react-native-executorch feeds)',
    withPlainScale
  );

  console.log('\n=== interpretation ===');
  console.log(
    `shared embedding space : ${
      withClipNorm.verdict === 'pass' ? 'CONFIRMED' : 'NOT CONFIRMED'
    } (${withClipNorm.verdict})`
  );
  console.log(
    `sensitivity to missing channel normalization : ` +
      `top-1 ${(withClipNorm.textToImageTop1 * 100).toFixed(0)}% -> ` +
      `${(withPlainScale.textToImageTop1 * 100).toFixed(0)}%, separation ` +
      `${withClipNorm.separation.toFixed(4)} -> ${withPlainScale.separation.toFixed(4)}`
  );
  console.log(
    '\nStill unverified without a device: that react-native-executorch loads\n' +
      'and runs clip-vit-base-patch32-text on iOS and on Android. See README.md.'
  );

  if (withClipNorm.verdict === 'fail') process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
