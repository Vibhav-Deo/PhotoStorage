/**
 * Two-stage vector retrieval engine (Task 6.3).
 *
 * Implements:
 * Stage 1: Exhaustive streaming scan over packed int8 vectors in `coarse.bin`.
 *          Computes dot products in an int32 accumulator and maintains the
 *          top-K candidate slots via a bounded min-heap.
 * Stage 2: Exact cosine rerank of surviving candidates using full-precision
 *          fp16/fp32 vectors from `vector_full`.
 *
 * Requirements:
 * - 5.1, 5.3: Sub-300ms two-stage search over local embeddings.
 * - 12.5: Sublinear memory overhead; scan chunks coarse vectors without full residency.
 */

import {
  COARSE_VECTOR_DIM,
  RAW_VECTOR_DIM,
  l2Normalize,
  projectAndQuantize,
} from './embedding.ts';
import type { CoarseIndex } from './coarseIndex.ts';
import type { SqlDriver } from '../db/driver.ts';

/** A candidate result produced by Stage 1 coarse scanning. */
export interface CoarseCandidate {
  readonly slot: number;
  readonly score: number; // Raw int32 dot product
}

/** Final reranked result with asset hash and exact cosine similarity [-1.0..1.0]. */
export interface ScoredVectorResult {
  readonly hash: string;
  readonly score: number;
  readonly coarseScore: number;
  readonly slot: number;
}

/**
 * Stage 1: Computes the dot product between two 256-dimensional int8 vectors
 * using an int32 accumulator.
 */
export function dotProductInt8(a: Int8Array, b: Int8Array): number {
  let sum = 0;
  // Unrolled or tight loop over 256 dimensions
  for (let i = 0; i < COARSE_VECTOR_DIM; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

/**
 * Computes exact cosine similarity between two float32 vectors.
 * Assumes vectors are already L2-normalized, in which case cosine similarity
 * is simply the dot product. If not, normalizes on the fly.
 */
export function cosineSimilarityFloat32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const va = a[i] ?? 0;
    const vb = b[i] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom < 1e-12) return 0;
  return dot / denom;
}

/**
 * Bounded min-heap maintaining the top K candidates by score.
 */
export class BoundedMinHeap<T extends { readonly score: number }> {
  private readonly capacity: number;
  private readonly heap: T[] = [];

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error(`BoundedMinHeap capacity must be > 0; got ${String(capacity)}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.heap.length;
  }

  get minScore(): number | undefined {
    return this.heap[0]?.score;
  }

  push(item: T): void {
    if (this.heap.length < this.capacity) {
      this.heap.push(item);
      this.bubbleUp(this.heap.length - 1);
    } else if (item.score > (this.heap[0]?.score ?? -Infinity)) {
      this.heap[0] = item;
      this.bubbleDown(0);
    }
  }

  /**
   * Returns items sorted descending by score.
   */
  toArraySorted(): T[] {
    const copy = [...this.heap];
    copy.sort((a, b) => b.score - a.score);
    return copy;
  }

  private bubbleUp(idx: number): void {
    let current = idx;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.heap[current]!.score < this.heap[parent]!.score) {
        const tmp = this.heap[current]!;
        this.heap[current] = this.heap[parent]!;
        this.heap[parent] = tmp;
        current = parent;
      } else {
        break;
      }
    }
  }

  private bubbleDown(idx: number): void {
    let current = idx;
    const length = this.heap.length;
    while (true) {
      const left = (current << 1) + 1;
      const right = left + 1;
      let smallest = current;

      if (left < length && this.heap[left]!.score < this.heap[smallest]!.score) {
        smallest = left;
      }
      if (right < length && this.heap[right]!.score < this.heap[smallest]!.score) {
        smallest = right;
      }

      if (smallest !== current) {
        const tmp = this.heap[current]!;
        this.heap[current] = this.heap[smallest]!;
        this.heap[smallest] = tmp;
        current = smallest;
      } else {
        break;
      }
    }
  }
}

/**
 * Stage 1: Streams through all live slots in `coarse.bin` and returns the top K candidate slots.
 */
export async function scanCoarseIndex(
  coarseIndex: CoarseIndex,
  queryInt8: Int8Array,
  candidateLimit = 500,
): Promise<CoarseCandidate[]> {
  const heap = new BoundedMinHeap<CoarseCandidate>(candidateLimit);

  for await (const slotVec of coarseIndex.scanSlots()) {
    const score = dotProductInt8(queryInt8, slotVec.vector);
    heap.push({ slot: slotVec.slot, score });
  }

  return heap.toArraySorted();
}

/**
 * Decodes a raw binary blob (stored in `vector_full.vec`) to Float32Array.
 * If the stored blob is fp16, converts from IEEE 754 half-precision to fp32.
 * If stored directly as fp32 (RAW_VECTOR_DIM * 4 bytes = 2048 bytes), extracts float32 directly.
 */
export function decodeVectorFullBlob(bytes: Uint8Array): Float32Array {
  // If 512 fp32 floats: 2048 bytes
  if (bytes.byteLength === RAW_VECTOR_DIM * 4) {
    const copy = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    return copy;
  }

  // If 512 fp16 floats: 1024 bytes
  if (bytes.byteLength === RAW_VECTOR_DIM * 2) {
    const out = new Float32Array(RAW_VECTOR_DIM);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < RAW_VECTOR_DIM; i++) {
      out[i] = decodeFloat16(view.getUint16(i * 2, true));
    }
    return out;
  }

  // Fallback: view as float32 array
  const floatCount = Math.floor(bytes.byteLength / 4);
  const out = new Float32Array(floatCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < floatCount; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/**
 * Encodes a Float32Array to 16-bit half-precision floating point bytes (fp16).
 */
export function encodeFloat16Blob(floats: Float32Array): Uint8Array {
  const bytes = new Uint8Array(floats.length * 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < floats.length; i++) {
    view.setUint16(i * 2, encodeFloat16(floats[i] ?? 0), true);
  }
  return bytes;
}

function decodeFloat16(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;

  if (e === 0) {
    return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  } else if (e === 0x1f) {
    return f ? NaN : (s ? -1 : 1) * Infinity;
  }
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function encodeFloat16(val: number): number {
  if (Number.isNaN(val)) return 0x7e00;
  if (!Number.isFinite(val)) return val > 0 ? 0x7c00 : 0xfc00;
  if (val === 0) return 1 / val === -Infinity ? 0x8000 : 0x0000;

  const sign = val < 0 ? 1 : 0;
  const abs = Math.abs(val);

  // Clamp subnormals and extremes
  if (abs < Math.pow(2, -24)) return sign << 15;
  if (abs >= 65504) return (sign << 15) | 0x7c00;

  let exponent = Math.floor(Math.log2(abs));
  let mantissa = abs / Math.pow(2, exponent) - 1;

  if (exponent < -14) {
    mantissa = abs / Math.pow(2, -14);
    exponent = -15;
  }

  const expBits = (exponent + 15) & 0x1f;
  const mantBits = Math.floor(mantissa * 1024) & 0x3ff;
  return (sign << 15) | (expBits << 10) | mantBits;
}

/**
 * Stage 2: Reranks coarse candidate slots using point lookups into `vector_full`.
 *
 * For each coarse candidate:
 * 1. Resolves candidate slot -> hash via `vector_slots`.
 * 2. Fetches full vector blob from `vector_full` for the matching hash.
 * 3. Computes exact cosine similarity with query float32 vector.
 * 4. Sorts descending by exact cosine score.
 */
export async function rerankCandidates(
  driver: SqlDriver,
  queryRaw512: Float32Array,
  candidates: readonly CoarseCandidate[],
  modelId: string,
): Promise<ScoredVectorResult[]> {
  if (candidates.length === 0) return [];

  // Query normalized vector for exact cosine dot product
  const queryNormalized = l2Normalize(new Float32Array(queryRaw512));

  // Batch query slot-to-hash mappings
  const slots = candidates.map((c) => c.slot);
  const placeholders = slots.map(() => '?').join(',');

  const slotRows = await driver.all<{ slot: number; hash: string }>(
    `SELECT slot, hash FROM vector_slots WHERE model_id = ? AND slot IN (${placeholders})`,
    [modelId, ...slots],
  );

  const slotToHash = new Map<number, string>();
  for (const r of slotRows) {
    slotToHash.set(r.slot, r.hash);
  }

  const hashesToFetch: string[] = [];
  const coarseCandidateByHash = new Map<string, CoarseCandidate>();

  for (const cand of candidates) {
    const hash = slotToHash.get(cand.slot);
    if (hash) {
      hashesToFetch.push(hash);
      coarseCandidateByHash.set(hash, cand);
    }
  }

  if (hashesToFetch.length === 0) return [];

  // Fetch full precision vectors from vector_full
  const hashPlaceholders = hashesToFetch.map(() => '?').join(',');
  const fullRows = await driver.all<{ hash: string; vec: Uint8Array }>(
    `SELECT hash, vec FROM vector_full WHERE model_id = ? AND hash IN (${hashPlaceholders})`,
    [modelId, ...hashesToFetch],
  );

  const results: ScoredVectorResult[] = [];

  for (const row of fullRows) {
    const cand = coarseCandidateByHash.get(row.hash);
    if (!cand) continue;

    const fullVec = decodeVectorFullBlob(row.vec);
    const exactScore = cosineSimilarityFloat32(queryNormalized, fullVec);

    results.push({
      hash: row.hash,
      score: exactScore,
      coarseScore: cand.score,
      slot: cand.slot,
    });
  }

  // Sort descending by exact cosine similarity
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * End-to-end Two-Stage Retrieval Query:
 * Runs coarse int8 scan + exact full vector rerank.
 */
export async function executeTwoStageVectorSearch(
  coarseIndex: CoarseIndex,
  driver: SqlDriver,
  queryRaw512: Float32Array,
  options: {
    candidateLimit?: number;
    finalLimit?: number;
  } = {},
): Promise<ScoredVectorResult[]> {
  const candidateLimit = options.candidateLimit ?? 500;
  const finalLimit = options.finalLimit ?? 100;

  // 1. Project and quantize raw query vector
  const queryInt8 = projectAndQuantize(queryRaw512);

  // 2. Stage 1: Coarse scan over coarse.bin
  const coarseCandidates = await scanCoarseIndex(coarseIndex, queryInt8, candidateLimit);

  // 3. Stage 2: Exact rerank
  const reranked = await rerankCandidates(
    driver,
    queryRaw512,
    coarseCandidates,
    coarseIndex.modelId,
  );

  return reranked.slice(0, finalLimit);
}
