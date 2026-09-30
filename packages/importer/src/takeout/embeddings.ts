/**
 * Embedding primitives re-exported from `@photo-archive/core`.
 *
 * Task 6.1 moved the canonical implementation into the shared core
 * (`packages/core/src/embed/`) so the importer and the app project and quantize
 * with byte-identical code — the design requires the fixed PCA matrix to be
 * identical on both sides, and a copy is not identical by construction
 * (Req 11.2, 11.5). This module remains as the importer's import surface so
 * existing call sites (`clipOnnx.ts`, tests) are unchanged.
 */

export {
  COARSE_VECTOR_DIM,
  CoarseVectorBuffer,
  DEFAULT_MODEL_ID,
  EmbeddingError,
  RAW_VECTOR_DIM,
  l2Normalize,
  projectAndQuantize,
  projectVector256,
  quantizeInt8,
} from '@photo-archive/core';
export type { CoarseVectorHeader } from '@photo-archive/core';
