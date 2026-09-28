import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';

/**
 * Result of generating image derivatives for a photo asset.
 */
export interface ImageDerivativesResult {
  /** ~25 byte thumbhash binary payload for the SQLite `thumbhash` BLOB column. */
  thumbhash: Uint8Array;
  /** WebP image buffer scaled to max 256 px long edge. */
  thumb: Buffer;
  /** WebP image buffer scaled to max 2048 px long edge. */
  preview: Buffer;
  /** Width of the original image in pixels (after EXIF orientation transform). */
  width: number;
  /** Height of the original image in pixels (after EXIF orientation transform). */
  height: number;
}

/**
 * Error thrown when derivative generation fails due to corrupt or unsupported image data.
 */
export class DerivativeGenerationError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DerivativeGenerationError';
    this.cause = cause;
  }
}

/**
 * Generates thumbhash (~25 bytes BLOB), 256px WebP thumbnail, and 2048px WebP preview
 * from an original image buffer.
 *
 * Requirements:
 * - Originals MUST remain byte-identical (input buffer is strictly read, never mutated).
 * - Thumbnail is capped at 256 px long edge in WebP format.
 * - Preview is capped at 2048 px long edge in WebP format.
 * - Thumbhash is computed from downscaled RGBA pixels (max 100x100).
 *
 * @param input Buffer or Uint8Array containing original image data.
 */
export async function generateImageDerivatives(
  input: Buffer | Uint8Array,
): Promise<ImageDerivativesResult> {
  const inputBuffer = Buffer.isBuffer(input) ? input : Buffer.from(input);

  if (inputBuffer.byteLength === 0) {
    throw new DerivativeGenerationError('Input buffer is empty');
  }

  try {
    // Pipeline 1: Auto-oriented image metadata & dimensions
    const pipeline = sharp(inputBuffer).rotate();
    const metadata = await pipeline.metadata();

    if (!metadata.width || !metadata.height) {
      throw new DerivativeGenerationError('Unable to determine image dimensions');
    }

    const width = metadata.width;
    const height = metadata.height;

    // Pipeline 2: Downscaled RGBA for Thumbhash (max 100x100)
    const { data: rgbaData, info: rgbaInfo } = await sharp(inputBuffer)
      .rotate()
      .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const thumbhashBytes = rgbaToThumbHash(
      rgbaInfo.width,
      rgbaInfo.height,
      new Uint8Array(rgbaData.buffer, rgbaData.byteOffset, rgbaData.byteLength),
    );

    // Pipeline 3: 256px WebP Thumbnail
    const thumb = await sharp(inputBuffer)
      .rotate()
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    // Pipeline 4: 2048px WebP Preview
    const preview = await sharp(inputBuffer)
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();

    return {
      thumbhash: thumbhashBytes,
      thumb,
      preview,
      width,
      height,
    };
  } catch (err) {
    if (err instanceof DerivativeGenerationError) {
      throw err;
    }
    throw new DerivativeGenerationError(
      `Failed to generate image derivatives: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}
