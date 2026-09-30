/**
 * Synthetic probe fixtures, generated from source rather than checked in.
 *
 * Two reasons for generating rather than bundling photographs:
 *
 * 1. The Node reference run and the on-device run must see *byte-identical*
 *    pixels. Otherwise a difference in result could be a JPEG decoder
 *    difference rather than a runtime difference, and the spike would prove
 *    nothing about the runtime. Generating from the same pure function on both
 *    sides removes that variable entirely.
 * 2. No licensing question. Requirement 11.4 is about model weights, but the
 *    same instinct applies to test fixtures.
 *
 * The tradeoff, stated plainly: CLIP was trained on web photographs, not on flat
 * synthetic shapes, so absolute cosine values here will be lower and less
 * representative than they would be on real photos. That is acceptable because
 * the verdict rests on *relative* ranking (see harness.ts). It does mean a
 * `partial` result on these fixtures should be retried with a handful of real
 * photos before being treated as a runtime defect.
 */

/** CLIP ViT-B/32 native input resolution. Generating at exactly this size
 *  avoids the runtime's resize step, removing another source of divergence. */
export const FIXTURE_SIZE = 224;

export interface SyntheticFixture {
  readonly id: string;
  /** The caption that should match this image and no other. */
  readonly caption: string;
  /** Returns the RGB colour at `x, y`, origin top-left. */
  readonly shade: (x: number, y: number) => readonly [number, number, number];
}

const WHITE = [255, 255, 255] as const;
const RED = [220, 30, 30] as const;
const BLUE = [30, 60, 210] as const;
const GREEN = [30, 160, 60] as const;
const BLACK = [15, 15, 15] as const;
const YELLOW = [240, 210, 40] as const;

/**
 * Five deliberately distinct fixtures. Five gives a 20% chance baseline, low
 * enough that perfect retrieval is not plausibly luck, while keeping a device
 * run to ten forward passes.
 *
 * Colour and shape are varied together so that a runtime which somehow returned
 * a constant or shape-blind vector still fails.
 */
export const FIXTURES: readonly SyntheticFixture[] = [
  {
    id: 'red-circle',
    caption: 'a red circle on a white background',
    shade: (x, y) =>
      inCircle(x, y, FIXTURE_SIZE / 2, FIXTURE_SIZE / 2, FIXTURE_SIZE * 0.35)
        ? RED
        : WHITE,
  },
  {
    id: 'blue-square',
    caption: 'a blue square on a white background',
    shade: (x, y) =>
      inSquare(x, y, FIXTURE_SIZE * 0.2, FIXTURE_SIZE * 0.8) ? BLUE : WHITE,
  },
  {
    id: 'green-triangle',
    caption: 'a green triangle on a white background',
    shade: (x, y) => (inTriangle(x, y) ? GREEN : WHITE),
  },
  {
    id: 'black-stripes',
    caption: 'black and white horizontal stripes',
    shade: (_x, y) => (Math.floor(y / 16) % 2 === 0 ? BLACK : WHITE),
  },
  {
    id: 'yellow-cross',
    caption: 'a yellow cross on a white background',
    shade: (x, y) => (inCross(x, y) ? YELLOW : WHITE),
  },
];

function inCircle(
  x: number,
  y: number,
  cx: number,
  cy: number,
  r: number
): boolean {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inSquare(x: number, y: number, lo: number, hi: number): boolean {
  return x >= lo && x <= hi && y >= lo && y <= hi;
}

/** Upward-pointing isoceles triangle inscribed in the frame. */
function inTriangle(x: number, y: number): boolean {
  const apexX = FIXTURE_SIZE / 2;
  const top = FIXTURE_SIZE * 0.15;
  const bottom = FIXTURE_SIZE * 0.85;
  if (y < top || y > bottom) return false;
  const progress = (y - top) / (bottom - top);
  const halfWidth = progress * (FIXTURE_SIZE * 0.4);
  return Math.abs(x - apexX) <= halfWidth;
}

function inCross(x: number, y: number): boolean {
  const lo = FIXTURE_SIZE * 0.42;
  const hi = FIXTURE_SIZE * 0.58;
  const inArm = (v: number) => v >= lo && v <= hi;
  const inSpan = (v: number) => v >= FIXTURE_SIZE * 0.15 && v <= FIXTURE_SIZE * 0.85;
  return (inArm(x) && inSpan(y)) || (inArm(y) && inSpan(x));
}

/**
 * Renders a fixture to a tightly packed RGB byte array, `height * width * 3`.
 * This is the format `react-native-executorch`'s `PixelData` expects, and the
 * Node reference converts from it, so both sides start from the same bytes.
 */
export function renderRgb(
  fixture: SyntheticFixture,
  size: number = FIXTURE_SIZE
): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  let offset = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = fixture.shade(x, y);
      out[offset++] = r;
      out[offset++] = g;
      out[offset++] = b;
    }
  }
  return out;
}
