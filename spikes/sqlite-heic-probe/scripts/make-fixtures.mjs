/**
 * Generates the HEIC fixture the device probe decodes, plus a JPEG twin.
 *
 *     node scripts/make-fixtures.mjs
 *
 * Following spike 0.1's convention, fixtures are generated rather than committed,
 * and `spikes/.gitignore` keeps the output out of the repo.
 *
 * ## Why a JPEG twin
 *
 * "HEIC decode is slow" and "decoding a 12 megapixel image is slow" are different
 * findings with different consequences. The twin is the same dimensions and the
 * same pixels, so the difference between the two timings is attributable to the
 * codec and nothing else. Without a control, a slow HEIC number would be
 * uninterpretable.
 *
 * ## Why 4032x3024 and why noise
 *
 * 4032x3024 is what an iPhone's main camera writes, and it is the size that makes
 * the memory question real: 48.8 MB as a decoded ARGB_8888 bitmap. A smooth
 * gradient would encode to a few kilobytes and misrepresent both file size and
 * entropy, so deterministic noise is mixed in. The PRNG is seeded, so the fixture
 * is byte-reproducible and two machines grade the same input.
 *
 * ## Encoder
 *
 * macOS `sips` drives the platform HEIF encoder, so the fixture is written by
 * Apple's own encoder rather than a third-party library. That is a deliberate
 * choice for the iOS half of the probe and a mild weakness for the Android half:
 * see the README for how to produce a fixture with `heif-enc` or `ffmpeg` instead,
 * and why testing a real camera file matters more than either.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const WIDTH = 4032;
const HEIGHT = 3024;
const SEED = 0x5eed_0002;

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'assets');

function crc32(buffer) {
  let table = crc32.table;
  if (table === undefined) {
    table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[index] = value;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([header, body, checksum]);
}

/** xorshift32. Deterministic and fast enough for 36 MB of pixels. */
function makeRandom(seed) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function writePng(path) {
  const random = makeRandom(SEED);
  // One filter byte per scanline plus three bytes per pixel.
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 3));
  let offset = 0;
  for (let y = 0; y < HEIGHT; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < WIDTH; x++) {
      // A diagonal gradient so the image has large-scale structure a codec can
      // exploit, plus noise so it cannot exploit all of it.
      const base = ((x / WIDTH) * 160 + (y / HEIGHT) * 60) | 0;
      const noise = (random() * 48) | 0;
      raw[offset++] = Math.min(255, base + noise);
      raw[offset++] = Math.min(255, 40 + ((y / HEIGHT) * 180 + noise) | 0);
      raw[offset++] = Math.min(255, 200 - base + noise);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

function convert(source, destination, format) {
  try {
    execFileSync('sips', ['-s', 'format', format, source, '--out', destination], {
      stdio: 'pipe',
    });
  } catch (error) {
    throw new Error(
      `sips could not write ${format}. sips ships with macOS; on Linux use ` +
        `heif-enc or ffmpeg instead (see spikes/README.md). Original error: ${error.message}`
    );
  }
}

mkdirSync(assets, { recursive: true });
const png = join(assets, 'fixture.png');
const heic = join(assets, 'fixture-12mp.heic');
const jpeg = join(assets, 'fixture-12mp.jpg');

console.log(`generating ${WIDTH}x${HEIGHT} source…`);
writePng(png);
convert(png, heic, 'heic');
convert(png, jpeg, 'jpeg');
rmSync(png);

for (const path of [heic, jpeg]) {
  console.log(`  ${path.split('/').slice(-1)[0]}  ${statSync(path).size} bytes`);
}
console.log(`decoded as ARGB_8888 either one is ${WIDTH * HEIGHT * 4} bytes.`);
