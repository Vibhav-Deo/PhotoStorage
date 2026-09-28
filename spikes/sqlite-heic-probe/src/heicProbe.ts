/**
 * The HEIC half of task 0.2: is there a working HEIC decode and downscale path in
 * React Native, on iOS and on Android?
 *
 * ## What reading the published source already settled
 *
 * Decoding HEIC is not in doubt on either platform, and the libraries involved are
 * ordinary Expo modules rather than anything exotic:
 *
 * - **iOS.** `expo-image-manipulator@57`'s `loadImage(atUrl:)` reads a local file
 *   with `UIImage(data:)`, which is ImageIO, which has decoded HEIC since iOS 11.
 *   The source even carries the comment "Read local files directly so UIKit
 *   preserves HEIC/EXIF orientation metadata". The pod's minimum is iOS 16.4, so
 *   every supported version has the decoder.
 * - **Android.** `expo-image-manipulator` delegates to `expo-image-loader`, which
 *   is Glide 5.0.5 (`Glide.with(context).asBitmap()`). Glide decodes through
 *   `BitmapFactory`, which gained HEIF support in **API 28**, and Glide registers
 *   `ExifInterfaceImageHeaderParser` only on `O_MR1+` with the comment "Right now
 *   we're only using this parser for HEIF images, which are only supported on
 *   OMR1+".
 *
 * WebP output, which the design's derivative keys require, is also present on both:
 * `Bitmap.CompressFormat.WEBP` on Android, and `SDImageWebPCoder` — vendored into
 * `expo-image-manipulator`'s prebuilt frameworks — on iOS.
 *
 * So "can it decode HEIC" is not the interesting question. Two things that source
 * cannot settle are, and they are what this probe measures.
 *
 * ## Risk one: the naive path decodes at full resolution first
 *
 * `ImageManipulator.manipulate(uri).resize({ width: 256 })` decodes the *whole*
 * image and then scales the bitmap down. On Android, `CustomTarget`'s no-argument
 * constructor requests `SIZE_ORIGINAL`; on iOS, `UIImage(data:)` has no size
 * parameter to give. A 12 megapixel original is 48.8 MB as ARGB_8888 and a 48
 * megapixel one is 195 MB, and the design runs `Derive` at `min(4, cores-1)`
 * concurrency — four concurrent full-resolution decodes, before React Native's own
 * footprint. That is a plausible out-of-memory on a mid-tier Android device, and it
 * is pure waste: the output is 256 px on its longest edge.
 *
 * The mitigation is also visible in source, and is a supported API rather than a
 * workaround. `expo-image`'s `Image.loadAsync(uri, { maxWidth, maxHeight })`
 * constrains the decode itself:
 *
 * - iOS, `ImageLoader.swift`: sets `context[.imageThumbnailPixelSize]`, which
 *   SDWebImage implements with `CGImageSourceCreateThumbnailAtIndex` and
 *   `kCGImageSourceThumbnailMaxPixelSize` — confirmed present in the SDWebImage
 *   binary that ships inside `expo-image-manipulator`'s prebuilt xcframework. The
 *   full-resolution bitmap is never materialized.
 * - Android, `ImageLoadTask.kt`: `.submit(maxWidth, maxHeight)`, which Glide turns
 *   into `BitmapFactory`'s `inSampleSize`, so the decoder subsamples as it reads.
 *
 * The result is an `ImageRef`, and `ImageManipulator.manipulate` accepts
 * `string | SharedRef<'image'>` — on Android its native signature is
 * `EitherOfThree<Uri, SharedRef<Bitmap>, SharedRef<Drawable>>`. So the two modules
 * hand off without a second decode. This probe runs both paths so the difference is
 * a measurement rather than an argument.
 *
 * ## Risk two: Android redacts EXIF from MediaStore bytes
 *
 * Glide ships `QMediaStoreUriLoader` specifically because, quoting its own doc
 * comment, "HEIC images on Q cannot be decoded if they've gone through Android's
 * exif redaction, due to a bug in the implementation that corrupts the file", and
 * it says plainly that it "does not fix applications that target Q, do not opt in
 * to legacy storage and that don't have ACCESS_MEDIA_LOCATION".
 *
 * That is a HEIC decode blocker, but the redaction has a consequence well beyond
 * this task: redacted bytes are *different bytes*, so they hash differently. The
 * design is content-addressed (Requirement 3.1) and reclamation deletes local
 * originals only after verifying the stored object against that hash
 * (Requirement 6). Hashing redacted bytes would mean uploading and verifying a
 * silently altered copy while deleting the true original. `ACCESS_MEDIA_LOCATION`
 * is not requested by default — `expo-media-library`'s config plugin gates it
 * behind `isAccessMediaLocationEnabled`, default false — and `expo-media-library`
 * calls `MediaStore.setRequireOriginal` only when reading EXIF location, not when
 * handing out a URI to read bytes from.
 *
 * The photo-library source below exists to make this visible: it decodes a real
 * camera HEIC from the device's own library, which is the path production uses and
 * the only one where redaction can occur. The bundled fixture is read straight off
 * disk and cannot exercise it.
 */

import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { Image } from 'expo-image';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  Asset as LibraryAsset,
  AssetField,
  MediaType,
  Query,
  requestPermissionsAsync,
} from 'expo-media-library';
import { Platform } from 'react-native';

import heicFixture from '../assets/fixture-12mp.heic';
import jpegFixture from '../assets/fixture-12mp.jpg';
import {
  checkDownscale,
  decodedBytes,
  fitLongEdge,
  PREVIEW_LONG_EDGE,
  THUMB_LONG_EDGE,
  type DownscaleCheck,
  type Size,
} from '../../sqlite-heic-probe-core/src/index.ts';

/** The design's `Derive` concurrency ceiling. */
const DERIVE_CONCURRENCY = 4;

/** Matches the design's derivative table: 256 px thumb at q75, 2048 px preview at q82. */
const TARGETS = [
  { name: 'thumb' as const, longEdge: THUMB_LONG_EDGE, compress: 0.75 },
  { name: 'preview' as const, longEdge: PREVIEW_LONG_EDGE, compress: 0.82 },
];

export type Strategy =
  /** `manipulate(uri)` — decodes at full resolution, then scales the bitmap. */
  | 'full-decode'
  /** `Image.loadAsync(uri, { maxWidth, maxHeight })` — the decoder subsamples. */
  | 'subsampled-decode';

export interface DecodeAttempt {
  readonly strategy: Strategy;
  readonly target: 'thumb' | 'preview';
  readonly ok: boolean;
  readonly error?: string;
  /**
   * Pixel size the decoder handed back, before the resize.
   *
   * For `full-decode` this equals the source, which is the whole point. For
   * `subsampled-decode` it is whatever reduced size the codec could produce
   * cheaply — on Android a power-of-two reduction, so expect something between the
   * target and twice it, not the target exactly.
   */
  readonly decodedSize?: Size;
  readonly peakDecodedBytes?: number;
  readonly outputSize?: Size;
  readonly outputFileBytes?: number;
  readonly elapsedMs: number;
  readonly geometry?: DownscaleCheck;
}

export interface ConcurrencyOutcome {
  readonly concurrency: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly elapsedMs: number;
  readonly impliedPeakBytes: number;
}

export interface SourceOutcome {
  readonly label: string;
  readonly note: string;
  readonly skipped?: string;
  readonly uri?: string;
  readonly fileBytes?: number;
  readonly sourceSize?: Size;
  readonly attempts: readonly DecodeAttempt[];
}

export interface HeicProbeOutcome {
  readonly platform: string;
  readonly sources: readonly SourceOutcome[];
  readonly concurrency?: ConcurrencyOutcome;
  readonly verdict: 'pass' | 'partial' | 'fail';
  readonly summary: string;
}

export interface HeicProgress {
  readonly detail: string;
}

export async function probeHeic(
  onProgress: (progress: HeicProgress) => void,
  options: { includeConcurrencyStress: boolean }
): Promise<HeicProbeOutcome> {
  const sources: SourceOutcome[] = [];

  sources.push(
    await bundledSource(
      onProgress,
      'bundled HEIC 4032x3024',
      heicFixture,
      'Generated by the platform HEIF encoder via sips. Read straight off disk, so this ' +
        'isolates codec support from photo-library plumbing.'
    )
  );
  sources.push(
    await bundledSource(
      onProgress,
      'bundled JPEG 4032x3024 (control)',
      jpegFixture,
      'Same pixels, same dimensions, different codec. The gap between this and the HEIC ' +
        'timing is attributable to the codec and nothing else.'
    )
  );
  sources.push(await photoLibrarySource(onProgress));

  let concurrency: ConcurrencyOutcome | undefined;
  if (options.includeConcurrencyStress) {
    const heic = sources[0];
    if (heic?.uri !== undefined && heic.sourceSize !== undefined) {
      concurrency = await stressConcurrency(onProgress, heic.uri, heic.sourceSize);
    }
  }

  return finish(sources, concurrency);
}

async function bundledSource(
  onProgress: (progress: HeicProgress) => void,
  label: string,
  moduleRef: number,
  note: string
): Promise<SourceOutcome> {
  onProgress({ detail: `loading ${label}` });
  let uri: string;
  try {
    const asset = Asset.fromModule(moduleRef);
    await asset.downloadAsync();
    if (asset.localUri === null) throw new Error('asset has no localUri after download');
    uri = asset.localUri;
  } catch (error) {
    return {
      label,
      note,
      skipped:
        `could not materialize the bundled fixture: ${asMessage(error)}. ` +
        'Run `node scripts/make-fixtures.mjs` — fixtures are generated, not committed.',
      attempts: [],
    };
  }

  return measureSource(onProgress, label, note, uri);
}

/**
 * A real camera HEIC from the device's own library.
 *
 * Skipped rather than failed when permission is denied or the library holds no
 * HEIC, because both are ordinary states and neither says anything about decode
 * support. Reported as a skip so the outcome is never mistaken for a pass.
 */
async function photoLibrarySource(
  onProgress: (progress: HeicProgress) => void
): Promise<SourceOutcome> {
  const label = 'photo library HEIC';
  const note =
    'The path production uses. On Android this is the only source that can hit MediaStore ' +
    'EXIF redaction, and a real camera file is also the only way to exercise 10-bit HEIC and ' +
    'HDR gain maps, which a generated fixture does not contain.';

  onProgress({ detail: 'requesting photo library permission' });
  const permission = await requestPermissionsAsync();
  if (!permission.granted) {
    return { label, note, skipped: `permission not granted (${permission.status})`, attempts: [] };
  }
  if (permission.accessPrivileges === 'limited') {
    onProgress({ detail: 'limited library access; only shared assets are visible' });
  }

  onProgress({ detail: 'looking for a HEIC in the library' });
  // `exeForMetadata` reads filename and dimensions straight from the media store
  // without resolving file paths, so scanning 200 assets to find one HEIC costs
  // almost nothing. Resolving a URI is deferred to the single chosen asset.
  const candidates = await new Query()
    .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
    .orderBy({ key: AssetField.CREATION_TIME, ascending: false })
    .limit(200)
    .exeForMetadata();

  const candidate = candidates.find((asset) => /\.hei[cf]$/i.test(asset.filename ?? ''));
  if (candidate === undefined) {
    return {
      label,
      note,
      skipped: `no .heic/.heif among the ${candidates.length} most recent photos`,
      attempts: [],
    };
  }

  const asset = new LibraryAsset(candidate.id);
  // On iOS a non-resident original has to come down from iCloud before any of its
  // bytes can be read, which is the design's `Hash` stage bottleneck. Skipping
  // rather than silently timing a multi-second download keeps the numbers below
  // comparable to the bundled fixture's.
  let uri: string;
  try {
    if (Platform.OS === 'ios' && (await asset.getIsInCloud())) {
      return {
        label,
        note,
        skipped: `${candidate.filename} is in iCloud and not resident locally`,
        attempts: [],
      };
    }
    uri = await asset.getUri();
  } catch (error) {
    return { label, note, skipped: `could not resolve a URI: ${asMessage(error)}`, attempts: [] };
  }

  return measureSource(onProgress, `${label} (${candidate.filename})`, note, uri);
}

async function measureSource(
  onProgress: (progress: HeicProgress) => void,
  label: string,
  note: string,
  uri: string
): Promise<SourceOutcome> {
  const fileBytes = fileSize(uri);

  // Establishes the true source dimensions before any resize, so `checkDownscale`
  // has something trustworthy to compare against. Deliberately a full decode: this
  // is the one place the probe wants the real pixel size.
  let sourceSize: Size | undefined;
  let openError: string | undefined;
  try {
    const context = ImageManipulator.manipulate(uri);
    const rendered = await context.renderAsync();
    sourceSize = { width: rendered.width, height: rendered.height };
    rendered.release();
    context.release();
  } catch (error) {
    openError = asMessage(error);
  }

  if (sourceSize === undefined) {
    return {
      label,
      note,
      uri,
      fileBytes,
      skipped: `the image could not be decoded at all: ${openError ?? 'unknown'}`,
      attempts: [],
    };
  }

  const attempts: DecodeAttempt[] = [];
  for (const target of TARGETS) {
    for (const strategy of ['full-decode', 'subsampled-decode'] as const) {
      onProgress({ detail: `${label}: ${strategy} -> ${target.name}` });
      attempts.push(await attempt(uri, sourceSize, strategy, target));
    }
  }

  return { label, note, uri, fileBytes, sourceSize, attempts };
}

async function attempt(
  uri: string,
  sourceSize: Size,
  strategy: Strategy,
  target: { name: 'thumb' | 'preview'; longEdge: number; compress: number }
): Promise<DecodeAttempt> {
  const started = Date.now();
  const expected = fitLongEdge(sourceSize, target.longEdge);

  try {
    let decodedSize: Size;
    let context: ReturnType<typeof ImageManipulator.manipulate>;

    if (strategy === 'full-decode') {
      context = ImageManipulator.manipulate(uri);
      decodedSize = sourceSize;
    } else {
      const reference = await Image.loadAsync(
        { uri },
        { maxWidth: target.longEdge, maxHeight: target.longEdge }
      );
      // `ImageRef.width`/`height` are *logical* units. Pixels are logical times
      // `scale`, and on Android `scale` is bitmap density over screen density, so
      // it is routinely not 1. Reporting logical units here would understate the
      // decode by the square of the density and make the comparison meaningless.
      decodedSize = {
        width: Math.round(reference.width * reference.scale),
        height: Math.round(reference.height * reference.scale),
      };
      context = ImageManipulator.manipulate(reference);
      reference.release();
    }

    // Only the long edge is constrained; the other dimension is derived by the
    // library, which is what keeps the aspect ratio and what `checkDownscale`
    // then verifies independently.
    const resized =
      sourceSize.width >= sourceSize.height
        ? context.resize({ width: expected.width })
        : context.resize({ height: expected.height });

    const rendered = await resized.renderAsync();
    const outputSize: Size = { width: rendered.width, height: rendered.height };
    const saved = await rendered.saveAsync({
      format: SaveFormat.WEBP,
      compress: target.compress,
    });
    rendered.release();
    context.release();

    return {
      strategy,
      target: target.name,
      ok: true,
      decodedSize,
      peakDecodedBytes: decodedBytes(decodedSize),
      outputSize,
      outputFileBytes: fileSize(saved.uri),
      elapsedMs: Date.now() - started,
      geometry: checkDownscale(sourceSize, outputSize, target.longEdge),
    };
  } catch (error) {
    return {
      strategy,
      target: target.name,
      ok: false,
      error: asMessage(error),
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * Runs `DERIVE_CONCURRENCY` full-resolution decodes at once.
 *
 * Separated behind its own switch because the failure mode under test is an
 * out-of-memory kill, and a killed process reports nothing. Everything else has
 * already been recorded by the time this runs.
 */
async function stressConcurrency(
  onProgress: (progress: HeicProgress) => void,
  uri: string,
  sourceSize: Size
): Promise<ConcurrencyOutcome> {
  onProgress({
    detail: `${DERIVE_CONCURRENCY} concurrent full-resolution decodes — may be killed for memory`,
  });
  const started = Date.now();
  const impliedPeakBytes = decodedBytes(sourceSize) * DERIVE_CONCURRENCY;

  try {
    await Promise.all(
      Array.from({ length: DERIVE_CONCURRENCY }, async () => {
        const context = ImageManipulator.manipulate(uri);
        const rendered = await context.resize({ width: THUMB_LONG_EDGE }).renderAsync();
        rendered.release();
        context.release();
      })
    );
    return { concurrency: DERIVE_CONCURRENCY, ok: true, elapsedMs: Date.now() - started, impliedPeakBytes };
  } catch (error) {
    return {
      concurrency: DERIVE_CONCURRENCY,
      ok: false,
      error: asMessage(error),
      elapsedMs: Date.now() - started,
      impliedPeakBytes,
    };
  }
}

function finish(
  sources: readonly SourceOutcome[],
  concurrency: ConcurrencyOutcome | undefined
): HeicProbeOutcome {
  const heic = sources[0];
  const heicAttempts = heic?.attempts ?? [];
  const heicWorks = heicAttempts.length > 0 && heicAttempts.every((a) => a.ok && a.geometry?.ok);
  const anyHeic = heicAttempts.some((a) => a.ok);

  const verdict: HeicProbeOutcome['verdict'] = heicWorks ? 'pass' : anyHeic ? 'partial' : 'fail';

  const lines: string[] = [];
  lines.push(`${Platform.OS} ${String(Platform.Version)} · verdict ${verdict.toUpperCase()}`);
  if (heic?.skipped !== undefined) {
    lines.push(`HEIC fixture skipped: ${heic.skipped}`);
  }
  for (const source of sources) {
    if (source.skipped !== undefined) {
      lines.push(`${source.label}: skipped — ${source.skipped}`);
      continue;
    }
    lines.push(
      `${source.label}: ${source.sourceSize?.width}x${source.sourceSize?.height}, ` +
        `${source.fileBytes ?? '?'} bytes on disk`
    );
    for (const a of source.attempts) {
      lines.push(
        `  ${a.ok ? (a.geometry?.ok ? 'ok  ' : 'GEOM') : 'FAIL'} ` +
          `${a.strategy.padEnd(18)} ${a.target.padEnd(8)} ${String(a.elapsedMs).padStart(6)} ms` +
          (a.decodedSize ? `  decoded ${a.decodedSize.width}x${a.decodedSize.height}` : '') +
          (a.peakDecodedBytes ? ` (${mb(a.peakDecodedBytes)})` : '') +
          (a.outputSize ? `  out ${a.outputSize.width}x${a.outputSize.height}` : '') +
          (a.outputFileBytes ? ` ${a.outputFileBytes}B webp` : '') +
          (a.error ? `  ${a.error}` : '')
      );
      for (const reason of a.geometry?.reasons ?? []) lines.push(`       ${reason}`);
    }
  }
  if (concurrency !== undefined) {
    lines.push(
      `${concurrency.concurrency} concurrent full decodes: ${concurrency.ok ? 'survived' : 'FAILED'} ` +
        `in ${concurrency.elapsedMs} ms, implying ~${mb(concurrency.impliedPeakBytes)} of ` +
        `simultaneous bitmap` + (concurrency.error ? ` — ${concurrency.error}` : '')
    );
  }

  return { platform: `${Platform.OS} ${String(Platform.Version)}`, sources, concurrency, verdict, summary: lines.join('\n') };
}

function fileSize(uri: string): number | undefined {
  try {
    return new File(uri).size ?? undefined;
  } catch {
    return undefined;
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
