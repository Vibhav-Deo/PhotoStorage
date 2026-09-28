import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { thumbHashToRGBA } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import { DerivativeGenerationError, generateImageDerivatives } from './derivatives.ts';

function sha256(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('generateImageDerivatives', () => {
  it('generates thumbhash, 256px thumbnail, and 2048px preview for large images', async () => {
    // 3000 x 2000 test image
    const rawImage = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: { r: 100, g: 150, b: 200 },
      },
    })
      .png()
      .toBuffer();

    const initialHash = sha256(rawImage);

    const result = await generateImageDerivatives(rawImage);

    // Assert originals are byte-identical before and after processing
    expect(sha256(rawImage)).toBe(initialHash);

    // Assert dimensions
    expect(result.width).toBe(3000);
    expect(result.height).toBe(2000);

    // Assert thumbhash is valid and decodable (~25 bytes)
    expect(result.thumbhash).toBeInstanceOf(Uint8Array);
    expect(result.thumbhash.byteLength).toBeGreaterThan(10);
    expect(result.thumbhash.byteLength).toBeLessThan(40);

    const decodedThumbhash = thumbHashToRGBA(result.thumbhash);
    expect(decodedThumbhash.w).toBeGreaterThan(0);
    expect(decodedThumbhash.h).toBeGreaterThan(0);
    expect(decodedThumbhash.rgba).toBeInstanceOf(Uint8Array);

    // Assert 256px thumbnail WebP
    const thumbMeta = await sharp(result.thumb).metadata();
    expect(thumbMeta.format).toBe('webp');
    expect(thumbMeta.width).toBe(256);
    expect(thumbMeta.height).toBe(171); // 3000x2000 aspect ratio (256 * 2000 / 3000)

    // Assert 2048px preview WebP
    const previewMeta = await sharp(result.preview).metadata();
    expect(previewMeta.format).toBe('webp');
    expect(previewMeta.width).toBe(2048);
    expect(previewMeta.height).toBe(1365); // 3000x2000 aspect ratio (2048 * 2000 / 3000)
  });

  it('does not upscale small images smaller than target derivative dimensions', async () => {
    // 150 x 100 small image
    const smallImage = await sharp({
      create: {
        width: 150,
        height: 100,
        channels: 3,
        background: { r: 50, g: 100, b: 150 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await generateImageDerivatives(smallImage);

    expect(result.width).toBe(150);
    expect(result.height).toBe(100);

    // Thumbnail (max 256px, withoutEnlargement) should remain 150x100
    const thumbMeta = await sharp(result.thumb).metadata();
    expect(thumbMeta.width).toBe(150);
    expect(thumbMeta.height).toBe(100);

    // Preview (max 2048px, withoutEnlargement) should remain 150x100
    const previewMeta = await sharp(result.preview).metadata();
    expect(previewMeta.width).toBe(150);
    expect(previewMeta.height).toBe(100);
  });

  it('throws DerivativeGenerationError for empty buffers', async () => {
    await expect(generateImageDerivatives(new Uint8Array(0))).rejects.toThrow(
      DerivativeGenerationError,
    );
  });

  it('throws DerivativeGenerationError for corrupt buffers', async () => {
    const corruptBuffer = Buffer.from('not an image data string');
    await expect(generateImageDerivatives(corruptBuffer)).rejects.toThrow(
      DerivativeGenerationError,
    );
  });
});
