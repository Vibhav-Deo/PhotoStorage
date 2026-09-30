import { describe, expect, it } from 'vitest';

import { FIXTURES, renderRgb, FIXTURE_SIZE } from './fixtures.ts';
import { runCrossModalProbe, type Encoders, type ProbeCase } from './harness.ts';

/**
 * Fake encoders whose behaviour we control, so the harness's verdict logic can
 * be tested without a model. `n` cases map onto `n` orthogonal basis directions.
 *
 * `textOffset` shifts which basis direction a caption lands on:
 *   0 -> captions align with their own image  (a working shared space)
 *   1 -> captions align with the *next* image (a systematically wrong space)
 */
function basisEncoders(
  n: number,
  { textOffset = 0, dim = n, textDim }: { textOffset?: number; dim?: number; textDim?: number } = {}
): Encoders<number> {
  const basis = (index: number, size: number): Float32Array => {
    const v = new Float32Array(size);
    v[index % size] = 1;
    return v;
  };
  return {
    async embedImage(index) {
      return basis(index, dim);
    },
    async embedText(caption) {
      const index = Number(caption);
      return basis(index + textOffset, textDim ?? dim);
    },
  };
}

/**
 * Byte comparison without `Buffer`. This package is imported by the React
 * Native app as well as by Node, and `Buffer` is not a global there.
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Case list whose caption is just the index, matching `basisEncoders`. */
function indexCases(n: number): ProbeCase<number>[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `case-${i}`,
    image: i,
    caption: String(i),
  }));
}

describe('runCrossModalProbe', () => {
  it('refuses to run with fewer than two cases', async () => {
    // With one case, top-1 accuracy is 1.0 no matter what the encoders do, so a
    // single pair cannot distinguish a shared space from an unrelated one.
    await expect(
      runCrossModalProbe(basisEncoders(1), indexCases(1))
    ).rejects.toThrow(/at least 2 cases/);
  });

  it('passes when captions align with their own images', async () => {
    const report = await runCrossModalProbe(basisEncoders(5), indexCases(5));
    expect(report.verdict).toBe('pass');
    expect(report.textToImageTop1).toBe(1);
    expect(report.imageToTextTop1).toBe(1);
    expect(report.separation).toBeGreaterThan(0);
    expect(report.chanceAccuracy).toBeCloseTo(0.2, 6);
  });

  it('fails when captions align with the wrong images', async () => {
    const report = await runCrossModalProbe(
      basisEncoders(5, { textOffset: 1 }),
      indexCases(5)
    );
    expect(report.verdict).toBe('fail');
    expect(report.textToImageTop1).toBe(0);
    // Matched pairs are orthogonal while some mismatched pairs are identical,
    // so separation goes negative. That is the signature of a wrong space.
    expect(report.separation).toBeLessThan(0);
  });

  it('fails on a dimension mismatch without attempting comparisons', async () => {
    const report = await runCrossModalProbe(
      basisEncoders(3, { dim: 512, textDim: 384 }),
      indexCases(3)
    );
    expect(report.verdict).toBe('fail');
    expect(report.imageDim).toBe(512);
    expect(report.textDim).toBe(384);
    expect(report.matrix).toEqual([]);
    expect(report.summary).toMatch(/cannot share an embedding space/);
  });

  it('reports the rank of the correct image per caption', async () => {
    const report = await runCrossModalProbe(basisEncoders(4), indexCases(4));
    expect(report.perCaption).toHaveLength(4);
    for (const row of report.perCaption) {
      expect(row.rankOfCorrectImage).toBe(1);
    }
    expect(report.perCaption.map((r) => r.topImageId)).toEqual([
      'case-0',
      'case-1',
      'case-2',
      'case-3',
    ]);
  });

  it('produces a square cosine matrix indexed [image][caption]', async () => {
    const report = await runCrossModalProbe(basisEncoders(3), indexCases(3));
    expect(report.matrix).toHaveLength(3);
    for (const row of report.matrix) expect(row).toHaveLength(3);
    // Diagonal is the matching pair, and for orthonormal fakes it is exactly 1.
    for (let i = 0; i < 3; i++) expect(report.matrix[i]![i]!).toBeCloseTo(1, 6);
  });

  it('grades a partially working space as partial, not pass or fail', async () => {
    // One caption deliberately collides with another image's direction, so
    // retrieval is better than chance but not perfect.
    const encoders: Encoders<number> = {
      async embedImage(index) {
        const v = new Float32Array(3);
        v[index] = 1;
        return v;
      },
      async embedText(caption) {
        const index = Number(caption);
        const v = new Float32Array(3);
        v[index] = 1;
        // Caption 2 leans hard toward image 0, losing its own image.
        if (index === 2) v[0] = 2;
        return v;
      },
    };
    const report = await runCrossModalProbe(encoders, indexCases(3));
    expect(report.verdict).toBe('partial');
    expect(report.textToImageTop1).toBeGreaterThan(report.chanceAccuracy);
    expect(report.textToImageTop1).toBeLessThan(1);
  });

  it('surfaces a degenerate encoder as an error, not a quiet fail', async () => {
    const encoders: Encoders<number> = {
      async embedImage() {
        return new Float32Array(512); // all zeros: model never loaded
      },
      async embedText() {
        return new Float32Array(512).fill(0.1);
      },
    };
    await expect(runCrossModalProbe(encoders, indexCases(3))).rejects.toThrow(
      /zero magnitude/
    );
  });
});

describe('fixtures', () => {
  it('defines at least five distinct cases with unique ids and captions', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length);
    expect(new Set(FIXTURES.map((f) => f.caption)).size).toBe(FIXTURES.length);
  });

  it('renders tightly packed RGB of the expected length', () => {
    const rgb = renderRgb(FIXTURES[0]!);
    expect(rgb).toBeInstanceOf(Uint8Array);
    expect(rgb.length).toBe(FIXTURE_SIZE * FIXTURE_SIZE * 3);
  });

  it('renders deterministically, so device and reference see the same bytes', () => {
    // This is the property that lets a device/reference divergence be blamed on
    // the runtime rather than on differing input pixels.
    expect(bytesEqual(renderRgb(FIXTURES[1]!), renderRgb(FIXTURES[1]!))).toBe(
      true
    );
  });

  it('renders visibly different images for different fixtures', () => {
    expect(bytesEqual(renderRgb(FIXTURES[0]!), renderRgb(FIXTURES[1]!))).toBe(
      false
    );
  });

  it('actually draws the described shape rather than a blank frame', () => {
    // A fixture that renders all-white would still pass the tests above while
    // making the probe meaningless.
    for (const fixture of FIXTURES) {
      const rgb = renderRgb(fixture);
      const distinct = new Set<string>();
      for (let i = 0; i < rgb.length; i += 3) {
        distinct.add(`${rgb[i]},${rgb[i + 1]},${rgb[i + 2]}`);
        if (distinct.size > 1) break;
      }
      expect(distinct.size, `${fixture.id} is a flat image`).toBeGreaterThan(1);
    }
  });
});
