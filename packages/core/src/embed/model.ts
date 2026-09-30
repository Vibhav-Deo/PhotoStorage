/**
 * The `EmbeddingModel` seam, from the design's "Key seams" section.
 *
 * Model identity is explicit so a model change is detectable and migratable
 * (Req 11.5, 5.9). The fixed projection is part of the model's identity: the
 * PCA matrix must be identical across devices and the importer, which is why
 * `project()` delegates to the shared implementation in `embedding.ts` rather
 * than accepting a per-instance matrix.
 *
 * This interface is implemented by the app's ExecuTorch wrapper
 * (`apps/mobile/src/search/embeddingModel.ts`) and by test doubles. The
 * importer's ONNX session exposes the same stages (`embedImageRaw` →
 * `projectAndQuantize`) without implementing this interface, because its
 * inputs are encoded image buffers rather than decoded pixels.
 */

/**
 * A decoded image ready for embedding: packed RGB bytes in HWC layout with
 * exactly 3 channels per pixel. Callers decode (sharp in the importer,
 * expo-image on the device) before reaching this seam; the model runtime
 * handles resize and normalization from there.
 */
export interface ImageSource {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Provider-agnostic embedding model over the joint CLIP image/text space. */
export interface EmbeddingModel {
  /** e.g. 'clip-vit-b32/pca256-v1'. Recorded per vector; mismatch triggers re-embed. */
  readonly id: string;
  /** Raw embedding dimension (512 for CLIP ViT-B/32). */
  readonly nativeDim: number;
  /** Coarse (projected, quantized) dimension (256). */
  readonly coarseDim: number;
  /** Embeds a decoded image into the joint space, L2-normalized. */
  embedImage(src: ImageSource): Promise<Float32Array>;
  /** Embeds a query string into the joint space, L2-normalized. */
  embedText(query: string): Promise<Float32Array>;
  /**
   * Projects a raw L2-normalized vector to the coarse int8 representation via
   * the fixed, versioned matrix. Must be identical across devices and the
   * importer — never fitted per-user.
   */
  project(v: Float32Array): Int8Array;
}
