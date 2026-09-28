/**
 * Pinned CLIP model artifacts and the on-device preprocessing configuration.
 *
 * Task 6.1. This module deliberately contains no runtime import of
 * `react-native-executorch` (only type-only imports, which are erased at
 * runtime), so it is testable in Node alongside the rest of the monorepo. The
 * ExecuTorch wrapper in `embeddingModel.ts` stays as thin as possible because
 * the runtime itself can only be exercised on a device.
 *
 * Pins, not registry lookups: the artifact URLs are spelled out at an exact
 * revision (`resolve/v0.10.0`, matching `react-native-executorch` 0.10.2's
 * `NEXT_VERSION_TAG`) because the library's version is what builds its model
 * URLs, and the licensing compliance record in `licenses/` is only meaningful
 * against a named revision. `models.imageEmbeddings.CLIP_VIT_BASE_PATCH32`
 * resolves to the same URLs but does not carry the normalization the importer
 * uses, so the config here is constructed explicitly.
 */

import { clipNormalizeOptions } from '@photo-archive/core';
import type { ImageEmbedderModel, TextEmbedderModel } from 'react-native-executorch';

const CLIP_MODEL_BASE =
  'https://huggingface.co/software-mansion/react-native-executorch-clip-vit-base-patch32';

/** Artifact revision; must match react-native-executorch's own NEXT_VERSION_TAG. */
export const CLIP_VERSION_TAG = 'resolve/v0.10.0';

/** Cross-platform XNNPACK fp32 image tower — the single artifact on iOS and Android. */
export const CLIP_IMAGE_MODEL_URL = `${CLIP_MODEL_BASE}/${CLIP_VERSION_TAG}/xnnpack/clip_vit_base_patch32_image_xnnpack_fp32.pte`;

/** Cross-platform XNNPACK fp32 text tower. */
export const CLIP_TEXT_MODEL_URL = `${CLIP_MODEL_BASE}/${CLIP_VERSION_TAG}/xnnpack/clip_vit_base_patch32_text_xnnpack_fp32.pte`;

/** Byte-level BPE tokenizer shared by both towers. */
export const CLIP_TOKENIZER_URL = `${CLIP_MODEL_BASE}/${CLIP_VERSION_TAG}/tokenizer.json`;

/**
 * Image embedder configuration for the ExecuTorch task API.
 *
 * The registry default for CLIP uses `normalizeOpts: { alpha: 1/255, beta: 0 }`
 * — a plain divide-by-255 with no channel normalization. Spike 0.1 measured
 * that convention as a ~21% retrieval-margin loss, and the importer's ONNX
 * path uses the full CLIP mean/std normalization. The alpha/beta arrays here
 * reproduce the importer's convention exactly, so vectors computed on-device
 * occupy the same space as vectors computed during desktop import
 * (Req 11.2, 11.5). `clipPreprocess.test.ts` in core asserts the algebra.
 */
export function clipImageEmbedderConfig(): ImageEmbedderModel {
  const { alpha, beta } = clipNormalizeOptions();
  return {
    modelPath: CLIP_IMAGE_MODEL_URL,
    modelOpts: {
      resizeMode: 'stretch',
      interpolation: 'linear',
      normalizeOpts: { alpha, beta },
    },
  };
}

/**
 * Text embedder configuration. No `defaultPrompt`: the CLIP text tower maps
 * the raw query into the joint space; a prompt prefix would change the space.
 */
export function clipTextEmbedderConfig(): TextEmbedderModel {
  return {
    modelPath: CLIP_TEXT_MODEL_URL,
    tokenizerPath: CLIP_TOKENIZER_URL,
  };
}
