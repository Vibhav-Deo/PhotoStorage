/**
 * Vector helpers for the CLIP two-tower probe.
 *
 * These live in the spike rather than in `packages/core` because the spike is
 * throwaway. If the spike's outcome is adopted, the equivalents belong next to
 * `EmbeddingModel` (design.md, "Key seams").
 *
 * Note on where normalization happens: the `react-native-executorch` native
 * layer returns the raw first output tensor of the `.pte` with no pooling and
 * no L2 normalization (verified in
 * `common/rnexecutorch/models/embeddings/BaseEmbeddings.cpp`). Normalization is
 * therefore the caller's job, on both the image and the text side.
 */

/** Thrown when a vector is unusable, rather than silently producing NaN. */
export class DegenerateVectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegenerateVectorError';
  }
}

/**
 * Returns a unit-length copy of `v`.
 *
 * Rejects zero, NaN, and Infinity rather than propagating them. A silently
 * NaN-poisoned vector would make every cosine comparison NaN, and NaN loses
 * every `>` comparison, so a broken encoder would look like a ranking failure
 * instead of a load failure. Failing loudly here keeps the spike's verdict
 * honest.
 */
export function l2Normalize(v: Float32Array | number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (!Number.isFinite(x)) {
      throw new DegenerateVectorError(
        `vector contains a non-finite value (${x}) at index ${i}`
      );
    }
    sumSquares += x * x;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    throw new DegenerateVectorError('vector has zero magnitude');
  }
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]! / norm;
  }
  return out;
}

/**
 * Cosine similarity. Normalizes both operands, so it is correct whether or not
 * the caller has already normalized.
 */
export function cosine(
  a: Float32Array | number[],
  b: Float32Array | number[]
): number {
  if (a.length !== b.length) {
    throw new DegenerateVectorError(
      `dimension mismatch: ${a.length} vs ${b.length}`
    );
  }
  const na = l2Normalize(a);
  const nb = l2Normalize(b);
  let dot = 0;
  for (let i = 0; i < na.length; i++) {
    dot += na[i]! * nb[i]!;
  }
  // Guard against floating-point drift pushing |cos| just past 1.
  return Math.min(1, Math.max(-1, dot));
}

/** Indices of `scores`, highest first. Ties keep their original relative order. */
export function rankDescending(scores: readonly number[]): number[] {
  return scores
    .map((score, index) => ({ score, index }))
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .map((entry) => entry.index);
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((acc, x) => acc + x, 0) / xs.length;
}
