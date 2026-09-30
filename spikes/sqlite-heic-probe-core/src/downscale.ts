/**
 * Derivative geometry, and the grading rule for the HEIC decode probe.
 *
 * Pure, and off in this package rather than in the Expo app, so the arithmetic
 * the device probe grades itself against is unit-tested on a machine where tests
 * are cheap to run.
 *
 * ## Why the assertion is a tolerance and not an equality
 *
 * The device path is `Image.loadAsync(uri, { maxWidth, maxHeight })` followed by
 * `ImageManipulator.resize()`. The first step is a *subsampled* decode — on iOS
 * SDWebImage passes the size to `CGImageSourceCreateThumbnailAtIndex`, on Android
 * Glide turns it into `BitmapFactory`'s `inSampleSize` — and subsampling lands on
 * whatever size the codec can produce cheaply, which on Android is a power-of-two
 * reduction. So the intermediate is "not larger than requested, aspect preserved",
 * never exactly the requested size.
 *
 * Rounding then differs by a pixel between platforms: `expo-image-manipulator`
 * truncates the derived dimension on Android (`(width / ratio).toInt()`) while
 * iOS goes through `CGSize`. Asserting exact equality would produce a spike that
 * fails for reasons that do not matter, and a spike that cries wolf is worse than
 * no spike.
 *
 * What does matter, and is asserted: the long edge is the requested size, the
 * aspect ratio survives, and nothing is upscaled.
 */

/** Grid thumbnail long edge, from the design's S3 key table (`{sub}/th/{hash}.webp`). */
export const THUMB_LONG_EDGE = 256;

/** Preview long edge (`{sub}/pv/{hash}.webp`). Deliberately generous per Requirement 7.2. */
export const PREVIEW_LONG_EDGE = 2048;

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * Scales `size` so its long edge is at most `maxLongEdge`, preserving aspect
 * ratio and never upscaling.
 *
 * Not upscaling is a correctness requirement rather than an optimisation: a
 * 180 px screenshot blown up to a 2048 px "preview" would be larger to store,
 * slower to transfer, and no better to look at, and it would make
 * `derivative_mask` claim a preview exists that is worse than the original.
 */
export function fitLongEdge(size: Size, maxLongEdge: number): Size {
  if (size.width <= 0 || size.height <= 0) {
    throw new Error(`fitLongEdge needs positive dimensions, got ${size.width}x${size.height}`);
  }
  const longEdge = Math.max(size.width, size.height);
  if (longEdge <= maxLongEdge) return { width: size.width, height: size.height };

  const scale = maxLongEdge / longEdge;
  return {
    // At least 1 px: an extreme panorama scaled to a 256 px long edge can round
    // its short edge to zero, and a zero-dimension bitmap throws on both platforms.
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * EXIF orientations 5 through 8 involve a transpose, so the stored pixel
 * dimensions are swapped relative to how the image should be displayed.
 *
 * This is here because the design stores `orientation` on `assets` and injects it
 * back on export (Requirement 7.4) rather than rewriting originals. A derivative,
 * by contrast, must be baked upright — nothing downstream reads `orientation` when
 * rendering a thumbnail. Getting this backwards yields sideways thumbnails for
 * every portrait photo, which is the single most visible way a photo grid can look
 * broken.
 */
export function orientationSwapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

export function applyOrientation(size: Size, orientation: number): Size {
  return orientationSwapsAxes(orientation)
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

export interface DownscaleCheck {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

/**
 * Grades one decode-and-downscale result.
 *
 * `sourceAspect` is taken from the *source* rather than recomputed from the
 * output, so a decoder that silently stretched the image to a square is caught.
 */
export function checkDownscale(
  source: Size,
  actual: Size,
  maxLongEdge: number,
  aspectTolerance = 0.02
): DownscaleCheck {
  const reasons: string[] = [];
  const expected = fitLongEdge(source, maxLongEdge);

  const actualLongEdge = Math.max(actual.width, actual.height);
  const expectedLongEdge = Math.max(expected.width, expected.height);

  // One pixel of slack for the truncate-versus-round difference between platforms.
  if (Math.abs(actualLongEdge - expectedLongEdge) > 1) {
    reasons.push(
      `long edge is ${actualLongEdge} px, expected ${expectedLongEdge} px ` +
        `(source ${source.width}x${source.height}, target ${maxLongEdge})`
    );
  }
  if (actual.width > source.width || actual.height > source.height) {
    reasons.push(
      `output ${actual.width}x${actual.height} is larger than source ` +
        `${source.width}x${source.height}; something upscaled`
    );
  }

  const sourceAspect = source.width / source.height;
  const actualAspect = actual.width / actual.height;
  if (Math.abs(actualAspect - sourceAspect) / sourceAspect > aspectTolerance) {
    reasons.push(
      `aspect ratio changed from ${sourceAspect.toFixed(4)} to ${actualAspect.toFixed(4)}; ` +
        `the resize is stretching rather than fitting`
    );
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Bytes an ARGB_8888 / RGBA bitmap of this size occupies while decoded.
 *
 * Reported by the HEIC probe because it, not HEIC support, is the actual risk on
 * this path. A 12 megapixel iPhone HEIC is ~48 MB decoded and a 48 megapixel one
 * is ~190 MB, and the design runs `Derive` at `min(4, cores-1)` concurrency. Four
 * concurrent full-resolution decodes is enough to exhaust the heap on a mid-tier
 * Android device on its own, before React Native's own footprint is counted.
 */
export function decodedBytes(size: Size): number {
  return size.width * size.height * 4;
}
