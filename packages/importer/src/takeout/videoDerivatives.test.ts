import { describe, expect, it } from 'vitest';
import {
  detectFfmpeg,
  extractVideoPosterFrame,
  resolveFfmpegPath,
  transcodeVideo720p,
  VideoDerivativeError,
} from './videoDerivatives.ts';

describe('videoDerivatives', () => {
  it('resolves ffmpeg path from parameter, env, or default', () => {
    expect(resolveFfmpegPath('/usr/local/bin/ffmpeg')).toBe('/usr/local/bin/ffmpeg');

    const prevEnv = process.env.FFMPEG_PATH;
    try {
      process.env.FFMPEG_PATH = '/opt/bin/ffmpeg';
      expect(resolveFfmpegPath()).toBe('/opt/bin/ffmpeg');
    } finally {
      process.env.FFMPEG_PATH = prevEnv;
    }

    delete process.env.FFMPEG_PATH;
    expect(resolveFfmpegPath()).toBe('ffmpeg');
  });

  it('detectFfmpeg returns false for invalid binary path', async () => {
    const isAvailable = await detectFfmpeg('/nonexistent/path/to/ffmpeg');
    expect(isAvailable).toBe(false);
  });

  it('extractVideoPosterFrame throws VideoDerivativeError for invalid binary or corrupt input', async () => {
    await expect(
      extractVideoPosterFrame('nonexistent-file.mp4', {
        ffmpegPath: '/nonexistent/path/to/ffmpeg',
      }),
    ).rejects.toThrow(VideoDerivativeError);
  });

  it('transcodeVideo720p throws VideoDerivativeError for invalid binary or corrupt input', async () => {
    await expect(
      transcodeVideo720p('nonexistent-file.mp4', '/tmp/out.mp4', {
        ffmpegPath: '/nonexistent/path/to/ffmpeg',
      }),
    ).rejects.toThrow(VideoDerivativeError);
  });
});
