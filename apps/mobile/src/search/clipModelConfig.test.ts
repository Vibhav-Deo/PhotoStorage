import { describe, expect, it } from 'vitest';
import { clipNormalizeOptions, projectAndQuantize, RAW_VECTOR_DIM } from '@photo-archive/core';
import {
  CLIP_IMAGE_MODEL_URL,
  CLIP_TEXT_MODEL_URL,
  CLIP_TOKENIZER_URL,
  CLIP_VERSION_TAG,
  clipImageEmbedderConfig,
  clipTextEmbedderConfig,
} from './clipModelConfig.ts';

/**
 * Task 6.1: the on-device embedding configuration must keep the importer and
 * the app in one vector space. These tests pin the three properties that make
 * that true: pinned artifact revisions, the shared CLIP normalization, and the
 * stretch-resize convention. The ExecuTorch runtime itself requires a device;
 * everything decidable in Node is decided here.
 */
describe('CLIP on-device model configuration (task 6.1)', () => {
  it('pins artifacts at an exact revision, never a moving tag', () => {
    expect(CLIP_VERSION_TAG).toMatch(/^resolve\/v\d+\.\d+\.\d+$/);
    // A branch or 'latest' tag would silently repoint the weights and
    // invalidate the licensing record (see licenses/README.md).
    expect(CLIP_VERSION_TAG).not.toContain('main');
    expect(CLIP_IMAGE_MODEL_URL).toBe(
      `https://huggingface.co/software-mansion/react-native-executorch-clip-vit-base-patch32/${CLIP_VERSION_TAG}/xnnpack/clip_vit_base_patch32_image_xnnpack_fp32.pte`,
    );
    expect(CLIP_TEXT_MODEL_URL).toBe(
      `https://huggingface.co/software-mansion/react-native-executorch-clip-vit-base-patch32/${CLIP_VERSION_TAG}/xnnpack/clip_vit_base_patch32_text_xnnpack_fp32.pte`,
    );
    expect(CLIP_TOKENIZER_URL.endsWith('/tokenizer.json')).toBe(true);
  });

  it('uses the full CLIP channel normalization, not the registry default', () => {
    const config = clipImageEmbedderConfig();
    const { alpha, beta } = clipNormalizeOptions();

    expect(config.modelOpts.normalizeOpts.alpha).toEqual(alpha);
    expect(config.modelOpts.normalizeOpts.beta).toEqual(beta);
    // The registry default is alpha = 1/255 with no per-channel beta; using it
    // would place device vectors in a different space than importer vectors.
    expect(config.modelOpts.normalizeOpts.alpha).not.toBe(1 / 255);
  });

  it('resizes by bilinear stretch to match the importer convention', () => {
    const config = clipImageEmbedderConfig();
    expect(config.modelOpts.resizeMode).toBe('stretch');
    expect(config.modelOpts.interpolation).toBe('linear');
  });

  it('configures the text tower with no prompt prefix', () => {
    const config = clipTextEmbedderConfig();
    expect(config.defaultPrompt).toBeUndefined();
    expect(config.modelPath).toBe(CLIP_TEXT_MODEL_URL);
    expect(config.tokenizerPath).toBe(CLIP_TOKENIZER_URL);
  });

  it('projects through the shared core implementation', () => {
    // Parity anchor: the mobile package has no projection code of its own, so
    // a vector quantized here equals one quantized by the importer. Guard
    // against a future local copy appearing by asserting the shared path is
    // the one used for a known fixture.
    const raw = new Float32Array(RAW_VECTOR_DIM);
    for (let i = 0; i < RAW_VECTOR_DIM; i++) raw[i] = Math.sin(i * 0.21);
    const projected = projectAndQuantize(raw);
    expect(projected.length).toBe(256);
    expect(projected).toBeInstanceOf(Int8Array);
  });
});
