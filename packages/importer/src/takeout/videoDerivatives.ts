import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { generateImageDerivatives, type ImageDerivativesResult } from './derivatives.ts';

const execFileAsync = promisify(execFile);

/**
 * Error thrown when video derivative processing fails.
 */
export class VideoDerivativeError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'VideoDerivativeError';
    this.cause = cause;
  }
}

/** Options for video derivative functions. */
export interface VideoDerivativeOptions {
  /** Explicit path to `ffmpeg` binary. Defaults to `process.env.FFMPEG_PATH` or `'ffmpeg'`. */
  readonly ffmpegPath?: string;
  /** Timeout in milliseconds for ffmpeg execution. Defaults to 60000 (60s). */
  readonly timeoutMs?: number;
}

/**
 * Resolves the ffmpeg executable path.
 */
export function resolveFfmpegPath(customPath?: string): string {
  if (customPath && customPath.trim() !== '') {
    return customPath.trim();
  }
  if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim() !== '') {
    return process.env.FFMPEG_PATH.trim();
  }
  return 'ffmpeg';
}

/**
 * Checks if the `ffmpeg` binary is available and executable.
 */
export async function detectFfmpeg(customPath?: string): Promise<boolean> {
  const ffmpegBin = resolveFfmpegPath(customPath);
  try {
    const { stdout } = await execFileAsync(ffmpegBin, ['-version'], {
      timeout: 5000,
    });
    return stdout.includes('ffmpeg version') || stdout.includes('Hyper fast');
  } catch {
    return false;
  }
}

/**
 * Extracts a poster frame from a video at offset 00:00:00 and generates image derivatives
 * (`thumbhash`, 256px WebP `thumb`, 2048px WebP `preview`).
 *
 * @param input Video file path (string) or raw video Buffer / Uint8Array.
 * @param options VideoDerivativeOptions
 */
export async function extractVideoPosterFrame(
  input: string | Buffer | Uint8Array,
  options?: VideoDerivativeOptions,
): Promise<ImageDerivativesResult> {
  const ffmpegBin = resolveFfmpegPath(options?.ffmpegPath);
  const timeout = options?.timeoutMs ?? 60000;

  let inputPath: string;
  let tempFilePath: string | undefined;

  if (typeof input === 'string') {
    inputPath = input;
  } else {
    // Write buffer to a temporary file for reliable ffmpeg demuxing
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-video-'));
    tempFilePath = path.join(tempDir, 'input.tmp');
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    await fs.writeFile(tempFilePath, buffer);
    inputPath = tempFilePath;
  }

  try {
    // Extract single frame at start as JPEG to stdout
    const { stdout } = await execFileAsync(
      ffmpegBin,
      [
        '-ss',
        '00:00:00',
        '-i',
        inputPath,
        '-vframes',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      {
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024,
        timeout,
      },
    );

    const frameBuffer = stdout as unknown as Buffer;
    if (!frameBuffer || frameBuffer.byteLength === 0) {
      throw new VideoDerivativeError(
        'ffmpeg produced empty frame output for video poster extraction',
      );
    }

    return await generateImageDerivatives(frameBuffer);
  } catch (err) {
    if (err instanceof VideoDerivativeError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new VideoDerivativeError(`Failed to extract poster frame from video: ${msg}`, err);
  } finally {
    if (tempFilePath) {
      try {
        await fs.rm(path.dirname(tempFilePath), {
          recursive: true,
          force: true,
        });
      } catch {
        // Ignore temp cleanup errors
      }
    }
  }
}

/**
 * Transcodes a video file to a 720p faststart MP4 file.
 *
 * Requirements:
 * - Scaled to max 720p height (-vf scale='min(1280,iw)':-2).
 * - Faststart flag (-movflags +faststart) for instant playback.
 * - H.264 video codec (libx264) and AAC audio codec (aac).
 *
 * @param input Video file path (string) or raw video Buffer / Uint8Array.
 * @param outputPath Target destination file path for 720p faststart MP4.
 * @param options VideoDerivativeOptions
 */
export async function transcodeVideo720p(
  input: string | Buffer | Uint8Array,
  outputPath: string,
  options?: VideoDerivativeOptions,
): Promise<void> {
  const ffmpegBin = resolveFfmpegPath(options?.ffmpegPath);
  const timeout = options?.timeoutMs ?? 120000;

  let inputPath: string;
  let tempFilePath: string | undefined;

  if (typeof input === 'string') {
    inputPath = input;
  } else {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pa-video-tr-'));
    tempFilePath = path.join(tempDir, 'input.tmp');
    const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
    await fs.writeFile(tempFilePath, buffer);
    inputPath = tempFilePath;
  }

  try {
    await execFileAsync(
      ffmpegBin,
      [
        '-y', // Overwrite destination file if exists
        '-i',
        inputPath,
        '-movflags',
        '+faststart',
        '-vf',
        "scale='min(1280,iw)':-2",
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        outputPath,
      ],
      { timeout },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new VideoDerivativeError(`Failed to transcode video to 720p faststart MP4: ${msg}`, err);
  } finally {
    if (tempFilePath) {
      try {
        await fs.rm(path.dirname(tempFilePath), {
          recursive: true,
          force: true,
        });
      } catch {
        // Ignore temp cleanup errors
      }
    }
  }
}
