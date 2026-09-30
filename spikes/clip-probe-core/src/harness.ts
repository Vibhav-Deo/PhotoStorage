/**
 * Cross-modal probe harness for photo-archive task 0.1.
 *
 * The question this answers: do the CLIP image tower and the CLIP text tower,
 * as actually exposed by a given runtime, produce vectors in the *same* space?
 *
 * ## Why this measures ranking rather than an absolute cosine threshold
 *
 * The task text asks to confirm that matching text and image embeddings produce
 * "high cosine similarity". Taken literally that is the wrong test. CLIP's
 * contrastive objective optimizes a *softmax over a temperature-scaled
 * similarity matrix*, not the absolute value of any single cosine. The learned
 * temperature compresses the usable range: for correctly matched pairs in
 * OpenAI CLIP ViT-B/32, cosine typically lands around 0.25-0.35, and mismatched
 * pairs land around 0.10-0.20. An absolute threshold of, say, 0.8 would reject a
 * perfectly working model; a threshold of 0.15 would accept a broken one.
 *
 * What is diagnostic is *separation and ranking*: for a given caption, does the
 * matching image outrank every non-matching image? That is also exactly the
 * property Requirement 5.1 and 5.3 depend on, since search returns a ranked
 * list. So the harness reports the raw cosine matrix for inspection but bases
 * its verdict on retrieval accuracy.
 *
 * If the two towers did *not* share a space, retrieval accuracy would collapse
 * to chance (1/n) even though individual cosines might look superficially
 * plausible. That is the failure this is built to catch.
 */

import { cosine, mean, rankDescending } from './vectors.ts';

/**
 * One image paired with the caption that describes it.
 *
 * Generic over the image representation so the same cases and the same scoring
 * can drive the on-device runtime (which takes `PixelData`) and the Node
 * reference (which takes a Float32Array tensor) without either side reshaping
 * the other's data.
 */
export interface ProbeCase<TImage> {
  /** Stable id used in the report. */
  readonly id: string;
  readonly image: TImage;
  /** The caption that should match this image and no other. */
  readonly caption: string;
}

export interface Encoders<TImage> {
  embedImage(image: TImage): Promise<Float32Array>;
  embedText(text: string): Promise<Float32Array>;
}

export type Verdict = 'pass' | 'partial' | 'fail';

export interface ProbeReport {
  readonly verdict: Verdict;
  /** Human-readable reason, safe to surface directly in the spike UI. */
  readonly summary: string;
  readonly imageDim: number;
  readonly textDim: number;
  readonly caseIds: readonly string[];
  /** `matrix[i][j]` = cosine(image i, caption j). */
  readonly matrix: readonly (readonly number[])[];
  /** Fraction of captions whose top-ranked image is the correct one. */
  readonly textToImageTop1: number;
  /** Fraction of images whose top-ranked caption is the correct one. */
  readonly imageToTextTop1: number;
  /** Accuracy expected from random ranking, for comparison. */
  readonly chanceAccuracy: number;
  readonly meanMatchedCosine: number;
  readonly meanMismatchedCosine: number;
  /** `meanMatchedCosine - meanMismatchedCosine`. Positive is the signal. */
  readonly separation: number;
  /** Per-caption detail, in `caseIds` order. */
  readonly perCaption: readonly {
    readonly caption: string;
    readonly matchedCosine: number;
    readonly rankOfCorrectImage: number;
    readonly topImageId: string;
  }[];
}

/**
 * Runs every image against every caption and scores the result.
 *
 * Requires at least two cases: with one case, retrieval accuracy is trivially
 * 1.0 whatever the encoders do, so a single pair cannot distinguish a shared
 * space from an unrelated one.
 */
export async function runCrossModalProbe<TImage>(
  encoders: Encoders<TImage>,
  cases: readonly ProbeCase<TImage>[]
): Promise<ProbeReport> {
  if (cases.length < 2) {
    throw new Error(
      `the probe needs at least 2 cases to be meaningful, got ${cases.length}`
    );
  }

  const imageVectors: Float32Array[] = [];
  for (const probeCase of cases) {
    imageVectors.push(await encoders.embedImage(probeCase.image));
  }
  const textVectors: Float32Array[] = [];
  for (const probeCase of cases) {
    textVectors.push(await encoders.embedText(probeCase.caption));
  }

  const imageDim = imageVectors[0]!.length;
  const textDim = textVectors[0]!.length;
  const caseIds = cases.map((c) => c.id);

  if (imageDim !== textDim) {
    // Not a shared space by construction. Report rather than throw, so the
    // spike UI can show the dimensions that were actually produced.
    return {
      verdict: 'fail',
      summary:
        `Image embeddings are ${imageDim}-dimensional but text embeddings are ` +
        `${textDim}-dimensional, so the two towers cannot share an embedding ` +
        `space. Either the wrong text model is loaded, or its projection into ` +
        `the joint space is missing.`,
      imageDim,
      textDim,
      caseIds,
      matrix: [],
      textToImageTop1: 0,
      imageToTextTop1: 0,
      chanceAccuracy: 1 / cases.length,
      meanMatchedCosine: Number.NaN,
      meanMismatchedCosine: Number.NaN,
      separation: Number.NaN,
      perCaption: [],
    };
  }

  const matrix: number[][] = imageVectors.map((imageVector) =>
    textVectors.map((textVector) => cosine(imageVector, textVector))
  );

  const matched: number[] = [];
  const mismatched: number[] = [];
  for (let i = 0; i < cases.length; i++) {
    for (let j = 0; j < cases.length; j++) {
      (i === j ? matched : mismatched).push(matrix[i]![j]!);
    }
  }

  // text -> image: for caption j, rank images by matrix[*][j]. This is the
  // direction the product uses: a typed query ranks the library.
  let textToImageHits = 0;
  const perCaption = cases.map((probeCase, j) => {
    const column = matrix.map((row) => row[j]!);
    const ranking = rankDescending(column);
    const rankOfCorrectImage = ranking.indexOf(j) + 1;
    if (rankOfCorrectImage === 1) textToImageHits++;
    return {
      caption: probeCase.caption,
      matchedCosine: matrix[j]![j]!,
      rankOfCorrectImage,
      topImageId: caseIds[ranking[0]!]!,
    };
  });

  // image -> text: the transpose. Reported because an asymmetric result is a
  // strong hint that one tower is misconfigured rather than the space differing.
  let imageToTextHits = 0;
  for (let i = 0; i < cases.length; i++) {
    if (rankDescending(matrix[i]!)[0] === i) imageToTextHits++;
  }

  const textToImageTop1 = textToImageHits / cases.length;
  const imageToTextTop1 = imageToTextHits / cases.length;
  const chanceAccuracy = 1 / cases.length;
  const meanMatchedCosine = mean(matched);
  const meanMismatchedCosine = mean(mismatched);
  const separation = meanMatchedCosine - meanMismatchedCosine;

  const verdict = judge({
    textToImageTop1,
    imageToTextTop1,
    chanceAccuracy,
    separation,
  });

  return {
    verdict,
    summary: describe(verdict, {
      textToImageTop1,
      imageToTextTop1,
      chanceAccuracy,
      separation,
      meanMatchedCosine,
      meanMismatchedCosine,
      caseCount: cases.length,
    }),
    imageDim,
    textDim,
    caseIds,
    matrix,
    textToImageTop1,
    imageToTextTop1,
    chanceAccuracy,
    meanMatchedCosine,
    meanMismatchedCosine,
    separation,
    perCaption,
  };
}

interface JudgeInput {
  textToImageTop1: number;
  imageToTextTop1: number;
  chanceAccuracy: number;
  separation: number;
}

/**
 * `pass` requires perfect retrieval in the direction search actually uses, plus
 * a positive margin between matched and mismatched pairs. Perfect retrieval on a
 * small deliberately-distinct fixture set is a low bar; anything less than
 * perfect on such a set is a signal worth investigating before Phase 6 depends
 * on it.
 *
 * `partial` means the towers are clearly related but something is degrading the
 * signal — plausible causes are a quantized artifact, image preprocessing that
 * does not match what the model was trained on, or truncated tokenization.
 */
function judge({
  textToImageTop1,
  imageToTextTop1,
  chanceAccuracy,
  separation,
}: JudgeInput): Verdict {
  if (separation <= 0) return 'fail';
  if (textToImageTop1 <= chanceAccuracy) return 'fail';
  if (textToImageTop1 === 1 && imageToTextTop1 === 1) return 'pass';
  return 'partial';
}

function describe(
  verdict: Verdict,
  m: JudgeInput & {
    meanMatchedCosine: number;
    meanMismatchedCosine: number;
    caseCount: number;
  }
): string {
  const numbers =
    `text->image top-1 ${pct(m.textToImageTop1)}, ` +
    `image->text top-1 ${pct(m.imageToTextTop1)} ` +
    `(chance ${pct(m.chanceAccuracy)} over ${m.caseCount} cases); ` +
    `matched cosine ${m.meanMatchedCosine.toFixed(4)} vs mismatched ` +
    `${m.meanMismatchedCosine.toFixed(4)}, separation ` +
    `${m.separation.toFixed(4)}`;

  switch (verdict) {
    case 'pass':
      return `Shared embedding space confirmed: ${numbers}.`;
    case 'partial':
      return (
        `Towers appear related but retrieval is imperfect: ${numbers}. ` +
        `Investigate image preprocessing, tokenizer padding, and whether a ` +
        `quantized artifact is in use before treating this as a pass.`
      );
    case 'fail':
      return (
        `No usable cross-modal signal: ${numbers}. The text embeddings are ` +
        `not comparable to the image embeddings.`
      );
  }
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
