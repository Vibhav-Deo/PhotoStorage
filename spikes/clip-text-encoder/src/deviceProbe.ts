/**
 * The on-device half of task 0.1: does `react-native-executorch` actually load
 * and run a CLIP *text* encoder, on iOS and on Android?
 *
 * This file deliberately holds no scoring logic. It adapts the runtime to the
 * `Encoders` interface and nothing more, so the verdict a device produces is
 * computed by exactly the same code as the off-device reference.
 *
 * ## What the library source says (verified by reading react-native-executorch@0.9.3)
 *
 * - `clip-vit-base-patch32-text` is a member of the `TextEmbeddingsModelName`
 *   union, so the text tower is a first-class supported model, not a custom
 *   export we have to hand-wire.
 * - Both towers resolve to a single XNNPACK fp32 artifact in 0.9.3. XNNPACK is
 *   the cross-platform CPU backend, so one artifact serves both platforms and
 *   the simulator. There is no iOS-only or Android-only code path to diverge.
 * - The native text runner is generic: `TextEmbeddings::generate` passes two
 *   int64 tensors, `(input_ids, attention_mask)`, both sized to the tokenizer's
 *   actual output length, with no padding to a fixed context window.
 * - The published `xnnpack/config.json` for this model declares the text method
 *   as taking a *single* input of shape `[1, 77]`.
 *
 * Those last two points do not agree, and that disagreement is the whole reason
 * this has to run on a device. If the `.pte` really takes one `[1, 77]` tensor,
 * `forward` will throw on input count or shape. If it was exported to accept
 * `(ids, mask)` with a dynamic sequence length, it will work. The source cannot
 * settle it; only execution can. `probeDevice` is written so that this specific
 * failure is reported clearly instead of appearing as a bad score.
 *
 * - Neither tower is L2-normalized natively (`BaseEmbeddings::postprocess`
 *   returns the raw output tensor), so normalization happens in the harness.
 */

import {
  ImageEmbeddingsModule,
  TextEmbeddingsModule,
  CLIP_VIT_BASE_PATCH32_IMAGE,
  CLIP_VIT_BASE_PATCH32_TEXT,
  ScalarType,
  type PixelData,
} from 'react-native-executorch';

import {
  FIXTURES,
  FIXTURE_SIZE,
  renderRgb,
  runCrossModalProbe,
  type Encoders,
  type ProbeCase,
  type ProbeReport,
} from '../../clip-probe-core/src/index.ts';

export type Stage =
  | 'idle'
  | 'loading-image-encoder'
  | 'loading-text-encoder'
  | 'embedding'
  | 'done'
  | 'error';

export interface ProbeProgress {
  stage: Stage;
  /** Free-text detail for the UI, e.g. which model is downloading. */
  detail: string;
  /** 0..1 while a model is downloading. */
  downloadProgress?: number;
}

export interface DeviceProbeOutcome {
  readonly report?: ProbeReport;
  /**
   * Set when the run could not complete. Kept separate from a `fail` verdict:
   * "the text encoder would not load" and "the text encoder loaded but its
   * vectors are unrelated to the image vectors" are different findings with
   * different fallbacks.
   */
  readonly failure?: {
    readonly stage: Stage;
    readonly message: string;
    /** True when the failure looks like the `[1,77]` contract mismatch above. */
    readonly looksLikeInputContractMismatch: boolean;
  };
  readonly timings: {
    imageEncoderLoadMs?: number;
    textEncoderLoadMs?: number;
    meanImageEmbedMs?: number;
    meanTextEmbedMs?: number;
  };
  /**
   * The text model's declared input shapes, read from the loaded `.pte` via
   * `getInputShape`. This is the direct answer to the config-versus-runner
   * disagreement described at the top of this file: one `[1, 77]` input means
   * the published config is right and the generic runner is feeding the model
   * incorrectly; two dynamic-length inputs means the runner is right. Record
   * whatever appears here in the design's open questions.
   */
  readonly textModelInputShapes?: readonly (readonly number[])[];
}

/**
 * Heuristic, and labelled as one. Used only to point a human at the most likely
 * cause; it never changes the verdict.
 */
function looksLikeContractMismatch(message: string): boolean {
  return /input|shape|dimension|tensor|num.?inputs|77/i.test(message);
}

function toPixelData(rgb: Uint8Array): PixelData {
  return {
    dataPtr: rgb,
    sizes: [FIXTURE_SIZE, FIXTURE_SIZE, 3],
    scalarType: ScalarType.BYTE,
  };
}

export async function probeDevice(
  onProgress: (progress: ProbeProgress) => void
): Promise<DeviceProbeOutcome> {
  const timings: DeviceProbeOutcome['timings'] = {};
  let stage: Stage = 'idle';

  let textModelInputShapes: number[][] | undefined;

  const fail = (error: unknown): DeviceProbeOutcome => {
    const message = error instanceof Error ? error.message : String(error);
    onProgress({ stage: 'error', detail: message });
    return {
      timings,
      textModelInputShapes,
      failure: {
        stage,
        message,
        looksLikeInputContractMismatch: looksLikeContractMismatch(message),
      },
    };
  };

  let imageModule: ImageEmbeddingsModule;
  let textModule: TextEmbeddingsModule;

  try {
    stage = 'loading-image-encoder';
    onProgress({ stage, detail: 'CLIP image tower' });
    let started = Date.now();
    imageModule = await ImageEmbeddingsModule.fromModelName(
      CLIP_VIT_BASE_PATCH32_IMAGE,
      (downloadProgress) =>
        onProgress({ stage, detail: 'CLIP image tower', downloadProgress })
    );
    timings.imageEncoderLoadMs = Date.now() - started;

    // The load that task 0.1 exists to test.
    stage = 'loading-text-encoder';
    onProgress({ stage, detail: 'CLIP text tower' });
    started = Date.now();
    textModule = await TextEmbeddingsModule.fromModelName(
      CLIP_VIT_BASE_PATCH32_TEXT,
      (downloadProgress) =>
        onProgress({ stage, detail: 'CLIP text tower', downloadProgress })
    );
    timings.textEncoderLoadMs = Date.now() - started;

    textModelInputShapes = await readInputShapes(textModule);
  } catch (error) {
    return fail(error);
  }

  const imageDurations: number[] = [];
  const textDurations: number[] = [];

  const encoders: Encoders<PixelData> = {
    async embedImage(pixelData) {
      const started = Date.now();
      const vector = await imageModule.forward(pixelData);
      imageDurations.push(Date.now() - started);
      return vector;
    },
    async embedText(caption) {
      const started = Date.now();
      const vector = await textModule.forward(caption);
      textDurations.push(Date.now() - started);
      return vector;
    },
  };

  const cases: ProbeCase<PixelData>[] = FIXTURES.map((fixture) => ({
    id: fixture.id,
    caption: fixture.caption,
    image: toPixelData(renderRgb(fixture)),
  }));

  try {
    stage = 'embedding';
    onProgress({ stage, detail: `${cases.length} images and captions` });
    const report = await runCrossModalProbe(encoders, cases);
    timings.meanImageEmbedMs = average(imageDurations);
    timings.meanTextEmbedMs = average(textDurations);
    onProgress({ stage: 'done', detail: report.summary });
    return { report, timings, textModelInputShapes };
  } catch (error) {
    timings.meanImageEmbedMs = average(imageDurations);
    timings.meanTextEmbedMs = average(textDurations);
    return fail(error);
  } finally {
    // Embed is serialized at concurrency 1 in the design because the runtime
    // holds one model instance; release both so a re-run starts clean.
    imageModule.delete();
    textModule.delete();
  }
}

function average(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Reads the loaded text model's declared input shapes.
 *
 * `getInputShape` throws once the index runs past the model's input count,
 * which is the only way to discover that count through the public API. The
 * probe must not fail because of a diagnostic, so everything here is
 * best-effort: on any error we return what we have.
 */
async function readInputShapes(
  module: TextEmbeddingsModule,
  maxInputs = 4
): Promise<number[][] | undefined> {
  const shapes: number[][] = [];
  for (let index = 0; index < maxInputs; index++) {
    try {
      shapes.push(await module.getInputShape('forward', index));
    } catch {
      break;
    }
  }
  return shapes.length > 0 ? shapes : undefined;
}
