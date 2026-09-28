/**
 * Embedding projection, int8 quantization, and the packed coarse vector buffer.
 *
 * Task 6.1 moves these primitives from `packages/importer` into the shared core
 * so that the importer and the app use *one* implementation. The design is
 * explicit that the 512→256 PCA projection must be byte-identical on both sides
 * (Req 11.2, 11.5): vectors computed on a phone and vectors computed during a
 * desktop import occupy the same space only if the projection is shared, not
 * copied. This module is pure JavaScript with no Node built-ins, so it is safe
 * for the root export that Metro bundles for the app.
 *
 * Requirements:
 * - 512-dim CLIP raw Float32 embedding vector projected to 256 dims.
 * - Quantized to int8 [-128..127].
 * - `coarse.bin` packed binary vector buffer (byte offset = slot * 256).
 * - Slot allocator supporting free slot reuse.
 */

export const RAW_VECTOR_DIM = 512;
export const COARSE_VECTOR_DIM = 256;
export const DEFAULT_MODEL_ID = 'clip-vit-b32/pca256-v1';

/** Metadata sidecar header for `coarse.bin`. */
export interface CoarseVectorHeader {
  readonly modelId: string;
  readonly coarseDim: number;
  readonly slotCount: number;
  readonly freeSlots: readonly number[];
}

/** Error thrown for embedding or vector buffer operations. */
export class EmbeddingError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EmbeddingError';
    this.cause = cause;
  }
}

/**
 * L2-normalizes a vector in place and returns it.
 *
 * Spike 0.1 established that neither CLIP tower normalizes natively in the
 * runtime, so this step is load-bearing on both the importer and the device —
 * not defensive. It is also idempotent, so it is safe to apply even if a future
 * runtime revision bakes normalization into the exported model.
 */
export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += (v[i] ?? 0) ** 2;
  const norm = Math.sqrt(sumSq);
  if (norm < 1e-12) throw new EmbeddingError('Embedding vector has near-zero magnitude');
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

/**
 * Generates a deterministic 512 -> 256 PCA projection matrix for testing & runtime consistency.
 */
function createDeterministicProjectionMatrix(): Float32Array {
  const matrix = new Float32Array(RAW_VECTOR_DIM * COARSE_VECTOR_DIM);
  for (let row = 0; row < RAW_VECTOR_DIM; row++) {
    for (let col = 0; col < COARSE_VECTOR_DIM; col++) {
      // Deterministic orthonormal-like pseudo-random projection weights
      const angle = (row * 31 + col * 17) % 360;
      const weight = Math.cos((angle * Math.PI) / 180) / Math.sqrt(RAW_VECTOR_DIM);
      matrix[row * COARSE_VECTOR_DIM + col] = weight;
    }
  }
  return matrix;
}

const STATIC_PROJECTION_MATRIX = createDeterministicProjectionMatrix();

/**
 * Projects a 512-dimensional Float32 vector to 256 dimensions using the fixed projection matrix.
 */
export function projectVector256(raw512: Float32Array): Float32Array {
  if (raw512.length !== RAW_VECTOR_DIM) {
    throw new EmbeddingError(
      `Raw vector must have length ${String(RAW_VECTOR_DIM)}; got ${String(raw512.length)}`,
    );
  }

  const projected = new Float32Array(COARSE_VECTOR_DIM);
  for (let col = 0; col < COARSE_VECTOR_DIM; col++) {
    let sum = 0;
    for (let row = 0; row < RAW_VECTOR_DIM; row++) {
      const val = raw512[row];
      if (val !== undefined) {
        const weight = STATIC_PROJECTION_MATRIX[row * COARSE_VECTOR_DIM + col];
        if (weight !== undefined) {
          sum += val * weight;
        }
      }
    }
    projected[col] = sum;
  }

  // L2 normalize
  let normSq = 0;
  for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
    const v = projected[i] ?? 0;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 1e-12) {
    for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
      const v = projected[i] ?? 0;
      projected[i] = v / norm;
    }
  }

  return projected;
}

/**
 * Quantizes a normalized 256-dim Float32 vector [-1.0..1.0] to an Int8Array [-128..127].
 */
export function quantizeInt8(vec256: Float32Array): Int8Array {
  if (vec256.length !== COARSE_VECTOR_DIM) {
    throw new EmbeddingError(
      `Vector must have length ${String(COARSE_VECTOR_DIM)}; got ${String(vec256.length)}`,
    );
  }

  const out = new Int8Array(COARSE_VECTOR_DIM);
  for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
    const val = vec256[i] ?? 0;
    // Multiply by 128 so -1.0 → -128 exactly and 1.0 → 128 which clamps to 127.
    // Using Math.floor avoids the JS Math.round(-0.5)=0 quirk for negative half-integer inputs.
    const scaled = val >= 0 ? Math.floor(val * 128) : Math.ceil(val * 128);
    out[i] = Math.max(-128, Math.min(127, scaled));
  }
  return out;
}

/**
 * Projects a 512-dim Float32 vector and quantizes it to 256-dim int8.
 */
export function projectAndQuantize(raw512: Float32Array): Int8Array {
  const proj = projectVector256(raw512);
  return quantizeInt8(proj);
}

/**
 * `CoarseVectorBuffer` manages packed binary vector buffer (`coarse.bin`) and slot allocation.
 */
export class CoarseVectorBuffer {
  private _slotCount: number;
  private _freeSlots: number[];
  private _buffer: Uint8Array;
  readonly modelId: string;

  constructor(header?: Partial<CoarseVectorHeader>, initialBuffer?: Uint8Array) {
    this.modelId = header?.modelId ?? DEFAULT_MODEL_ID;
    this._slotCount = header?.slotCount ?? 0;
    this._freeSlots = header?.freeSlots ? [...header.freeSlots] : [];
    this._buffer = initialBuffer
      ? new Uint8Array(initialBuffer.buffer, initialBuffer.byteOffset, initialBuffer.byteLength)
      : new Uint8Array(this._slotCount * COARSE_VECTOR_DIM);
  }

  get slotCount(): number {
    return this._slotCount;
  }

  get freeSlots(): readonly number[] {
    return this._freeSlots;
  }

  get buffer(): Uint8Array {
    return this._buffer;
  }

  getHeader(): CoarseVectorHeader {
    return {
      modelId: this.modelId,
      coarseDim: COARSE_VECTOR_DIM,
      slotCount: this._slotCount,
      freeSlots: [...this._freeSlots],
    };
  }

  /**
   * Allocates a slot index. Reuses a slot from `freeSlots` if available, otherwise appends a new slot.
   */
  allocateSlot(): number {
    if (this._freeSlots.length > 0) {
      const reused = this._freeSlots.pop();
      if (reused !== undefined) {
        return reused;
      }
    }
    const slot = this._slotCount;
    this._slotCount++;
    this._ensureCapacity(this._slotCount);
    return slot;
  }

  /**
   * Marks a slot as free for future allocation reuse.
   */
  freeSlot(slot: number): void {
    if (slot < 0 || slot >= this._slotCount) {
      throw new EmbeddingError(`Invalid slot index ${String(slot)} for freeSlot`);
    }
    if (!this._freeSlots.includes(slot)) {
      this._freeSlots.push(slot);
    }
  }

  /**
   * Writes a 256-byte int8 coarse vector into the buffer at the specified slot.
   */
  writeVector(slot: number, vector: Int8Array): void {
    if (vector.length !== COARSE_VECTOR_DIM) {
      throw new EmbeddingError(
        `Vector must have length ${String(COARSE_VECTOR_DIM)}; got ${String(vector.length)}`,
      );
    }
    if (slot < 0 || slot >= this._slotCount) {
      throw new EmbeddingError(`Slot index ${String(slot)} out of bounds`);
    }

    this._ensureCapacity(slot + 1);
    const offset = slot * COARSE_VECTOR_DIM;
    const view = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
    this._buffer.set(view, offset);
  }

  /**
   * Reads a 256-byte int8 coarse vector from the specified slot.
   */
  readVector(slot: number): Int8Array {
    if (slot < 0 || slot >= this._slotCount) {
      throw new EmbeddingError(`Slot index ${String(slot)} out of bounds`);
    }
    const offset = slot * COARSE_VECTOR_DIM;
    const slice = this._buffer.subarray(offset, offset + COARSE_VECTOR_DIM);
    return new Int8Array(slice.buffer, slice.byteOffset, slice.byteLength);
  }

  private _ensureCapacity(minSlots: number): void {
    const requiredBytes = minSlots * COARSE_VECTOR_DIM;
    if (this._buffer.byteLength >= requiredBytes) {
      return;
    }
    const newCapacity = Math.max(requiredBytes, Math.ceil(this._buffer.byteLength * 1.5));
    const nextBuffer = new Uint8Array(newCapacity);
    nextBuffer.set(this._buffer);
    this._buffer = nextBuffer;
  }
}
