/**
 * On-device CLIP embedding model (task 6.1), wrapping `react-native-executorch`.
 *
 * Implements the `EmbeddingModel` seam from `@photo-archive/core`:
 * - image and text both embed into the joint 512-dim space (Req 5.1, 5.2);
 * - outputs are L2-normalized here, because spike 0.1 verified by reading the
 *   runtime source that neither tower normalizes natively — the normalize step
 *   is load-bearing, not defensive (and idempotent if a future runtime bakes
 *   it in);
 * - `project()` delegates to the shared core implementation, so the coarse
 *   vectors this device writes are byte-comparable with the importer's
 *   (Req 11.2, 11.5).
 *
 * This module is the thin runtime boundary: everything testable without a
 * device lives in `clipModelConfig.ts` and in the core. Calls are serialized
 * internally because the ExecuTorch runtime holds one model instance per
 * tower and throws `RESOURCE_BUSY` on concurrent use — the design's "Embed
 * concurrency: 1" constraint (see the ingest pipeline table).
 */

import {
  COARSE_VECTOR_DIM,
  DEFAULT_MODEL_ID,
  EmbeddingError,
  RAW_VECTOR_DIM,
  l2Normalize,
  projectAndQuantize,
} from '@photo-archive/core';
import type { EmbeddingModel, ImageSource } from '@photo-archive/core';
import { createImageEmbedder, createTextEmbedder } from 'react-native-executorch';
import type { ImageEmbedder, TextEmbedder } from 'react-native-executorch';
import { clipImageEmbedderConfig, clipTextEmbedderConfig } from './clipModelConfig.ts';

/** Options accepted by `ExecuTorchEmbeddingModel.create`. */
export interface ExecuTorchEmbeddingOptions {
  /**
   * Local path or remote URL overriding the pinned image tower artifact.
   * Tests and offline flows may point this at a pre-downloaded `.pte`.
   */
  readonly imageModelPath?: string;
  /** Local path or remote URL overriding the pinned text tower artifact. */
  readonly textModelPath?: string;
  /** Local path or remote URL overriding the pinned tokenizer. */
  readonly tokenizerPath?: string;
}

export class ExecuTorchEmbeddingModel implements EmbeddingModel {
  readonly id = DEFAULT_MODEL_ID;
  readonly nativeDim = RAW_VECTOR_DIM;
  readonly coarseDim = COARSE_VECTOR_DIM;

  private readonly imageEmbedder: ImageEmbedder;
  private readonly textEmbedder: TextEmbedder;
  /** Serializes forward passes; the runtime allows one model instance each. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(imageEmbedder: ImageEmbedder, textEmbedder: TextEmbedder) {
    this.imageEmbedder = imageEmbedder;
    this.textEmbedder = textEmbedder;
  }

  /**
   * Loads both CLIP towers. Downloads the pinned artifacts on first use
   * (~351 MB image, ~254 MB text, ~2.2 MB tokenizer) and caches them; callers
   * should surface download progress through the UI for first run.
   */
  static async create(options: ExecuTorchEmbeddingOptions = {}): Promise<ExecuTorchEmbeddingModel> {
    const imageConfig = clipImageEmbedderConfig();
    const textConfig = clipTextEmbedderConfig();

    try {
      const [imageEmbedder, textEmbedder] = await Promise.all([
        createImageEmbedder({
          modelPath: options.imageModelPath ?? imageConfig.modelPath,
          modelOpts: imageConfig.modelOpts,
        }),
        createTextEmbedder({
          modelPath: options.textModelPath ?? textConfig.modelPath,
          tokenizerPath: options.tokenizerPath ?? textConfig.tokenizerPath,
        }),
      ]);
      return new ExecuTorchEmbeddingModel(imageEmbedder, textEmbedder);
    } catch (err) {
      throw new EmbeddingError('Failed to load the on-device CLIP model', err);
    }
  }

  async embedImage(src: ImageSource): Promise<Float32Array> {
    if (src.data.length !== src.width * src.height * 3) {
      throw new EmbeddingError(
        `ImageSource must be packed RGB (3 bytes/px); got ${String(src.data.length)} ` +
          `bytes for ${String(src.width)}×${String(src.height)}`,
      );
    }
    const raw = await this.run(() =>
      this.imageEmbedder.embed({
        data: src.data,
        width: src.width,
        height: src.height,
        format: 'rgb',
        layout: 'hwc',
      }),
    );
    if (raw.length !== RAW_VECTOR_DIM) {
      throw new EmbeddingError(
        `Expected ${String(RAW_VECTOR_DIM)}-dim image embedding, got ${String(raw.length)}`,
      );
    }
    return l2Normalize(raw);
  }

  async embedText(query: string): Promise<Float32Array> {
    if (query.length === 0) {
      throw new EmbeddingError('Query text must not be empty');
    }
    const raw = await this.run(() => this.textEmbedder.embed(query));
    if (raw.length !== RAW_VECTOR_DIM) {
      throw new EmbeddingError(
        `Expected ${String(RAW_VECTOR_DIM)}-dim text embedding, got ${String(raw.length)}`,
      );
    }
    return l2Normalize(raw);
  }

  project(v: Float32Array): Int8Array {
    return projectAndQuantize(v);
  }

  /** Releases both native model instances. The model cannot be used afterwards. */
  dispose(): void {
    this.imageEmbedder.dispose();
    this.textEmbedder.dispose();
  }

  /**
   * Chains `op` onto the serialization queue so overlapping callers wait
   * rather than hitting the runtime's `RESOURCE_BUSY` error.
   */
  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {
      // Swallow only the queue-chaining error; the caller still sees `next` reject.
    });
    return next;
  }
}
