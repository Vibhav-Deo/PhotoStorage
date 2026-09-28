/**
 * CLIP image embedding via onnxruntime-node.
 *
 * Uses the full CLIPModel ONNX export (`onnx/model_quantized.onnx` from
 * Xenova/clip-vit-base-patch32 @ d15189d7) which includes both projection
 * heads and produces vectors in the joint embedding space.
 *
 * Requirements:
 * - Task 2.9: CLIP image embedding, fixed PCA projection to 256 dims, int8 quantization.
 * - The projection matrix must be byte-identical to the one the app uses (Req 11.2, 11.5).
 * - Task 0.3: ONNX artifact must be fetched at the pinned commit sha with digest check.
 *
 * Preprocessing convention (from spike 0.1 findings):
 * - Resize to 224×224 with bilinear stretch (no aspect-preserving crop).
 * - CLIP channel normalization: mean=[0.48145466,0.4578275,0.40821073],
 *   std=[0.26862954,0.26130258,0.27577711].
 * - Layout: CHW float32, shape [1, 3, 224, 224].
 * - L2 normalize the raw 512-dim output before projection.
 */

import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { EmbeddingError, l2Normalize, projectAndQuantize, RAW_VECTOR_DIM } from './embeddings.ts';
import { CLIP_INPUT_SIZE, toClipPixelValues } from '@photo-archive/core';

/**
 * Re-exported for existing call sites and tests: the canonical definitions now
 * live in `@photo-archive/core` so the importer and the app share one
 * preprocessing convention (task 6.1).
 */
export { CLIP_INPUT_SIZE, toClipPixelValues };

export const CLIP_CONTEXT_LENGTH = 77;

/** Neutral token ids for the text tower when we only need image_embeds. */
function neutralTextInputs(): {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
} {
  // <|startoftext|> + <|endoftext|> padded to context length with endoftext (49407).
  const EOT = 49407n;
  const SOT = 49406n;
  const inputIds = new BigInt64Array(CLIP_CONTEXT_LENGTH).fill(EOT);
  const attentionMask = new BigInt64Array(CLIP_CONTEXT_LENGTH).fill(0n);
  inputIds[0] = SOT;
  inputIds[1] = EOT;
  attentionMask[0] = 1n;
  attentionMask[1] = 1n;
  return { inputIds, attentionMask };
}

/**
 * Resizes an image buffer to 224×224 (bilinear stretch, no crop) and returns
 * packed RGB bytes matching the convention the ONNX model was exported with.
 */
export async function resizeToClipInput(imageBuffer: Buffer | Uint8Array): Promise<Uint8Array> {
  const buf = Buffer.isBuffer(imageBuffer) ? imageBuffer : Buffer.from(imageBuffer);
  const { data } = await sharp(buf)
    .resize(CLIP_INPUT_SIZE, CLIP_INPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * Wraps an `onnxruntime-node` session for the full CLIPModel ONNX export.
 * Produces L2-normalized 512-dim image embeddings in the joint space.
 *
 * The session is expensive to create; callers should create one and reuse it.
 */
export class ClipOnnxSession {
  private readonly session: ort.InferenceSession;

  private constructor(session: ort.InferenceSession) {
    this.session = session;
  }

  static async create(modelPath: string): Promise<ClipOnnxSession> {
    try {
      const session = await ort.InferenceSession.create(modelPath);
      return new ClipOnnxSession(session);
    } catch (err) {
      throw new EmbeddingError(`Failed to load CLIP ONNX model from ${modelPath}`, err);
    }
  }

  /**
   * Embeds an image buffer and returns a raw L2-normalized 512-dim Float32Array.
   * The caller is responsible for projection and quantization.
   */
  async embedImageRaw(imageBuffer: Buffer | Uint8Array): Promise<Float32Array> {
    const rgb = await resizeToClipInput(imageBuffer);
    const pixelValues = toClipPixelValues(rgb);
    return this._runImageForward(pixelValues);
  }

  /**
   * Embeds pre-rendered 224×224 RGB bytes (HWC Uint8Array) directly.
   * Used by tests that need to match the spike's fixture rendering exactly.
   */
  async embedRgbBytes(rgb: Uint8Array): Promise<Float32Array> {
    const pixelValues = toClipPixelValues(rgb);
    return this._runImageForward(pixelValues);
  }

  private async _runImageForward(pixelValues: Float32Array): Promise<Float32Array> {
    const { inputIds, attentionMask } = neutralTextInputs();
    const feeds: Record<string, ort.Tensor> = {
      pixel_values: new ort.Tensor('float32', pixelValues, [
        1,
        3,
        CLIP_INPUT_SIZE,
        CLIP_INPUT_SIZE,
      ]),
      input_ids: new ort.Tensor('int64', inputIds, [1, CLIP_CONTEXT_LENGTH]),
      attention_mask: new ort.Tensor('int64', attentionMask, [1, CLIP_CONTEXT_LENGTH]),
    };

    let results: ort.InferenceSession.OnnxValueMapType;
    try {
      results = await this.session.run(feeds);
    } catch (err) {
      throw new EmbeddingError('CLIP ONNX inference failed', err);
    }

    const imageEmbeds = results['image_embeds'];
    if (!imageEmbeds) {
      throw new EmbeddingError(
        'CLIP ONNX model did not return image_embeds. ' +
          'Ensure you are using the full CLIPModel export, not vision_model.onnx.',
      );
    }

    const raw = new Float32Array(imageEmbeds.data as Float32Array);
    if (raw.length !== RAW_VECTOR_DIM) {
      throw new EmbeddingError(
        `Expected ${String(RAW_VECTOR_DIM)}-dim image embedding, got ${String(raw.length)}`,
      );
    }

    return l2Normalize(raw);
  }

  /**
   * Full pipeline: image buffer → 512-dim embedding → project to 256 dims → int8 quantize.
   */
  async embedImage(imageBuffer: Buffer | Uint8Array): Promise<Int8Array> {
    const raw = await this.embedImageRaw(imageBuffer);
    return projectAndQuantize(raw);
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}
