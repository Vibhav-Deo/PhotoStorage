/**
 * S3DirectUrlProvider tests — batch URL generation with local SigV4 signing,
 * no network calls (Requirements 12.3, 9.6).
 *
 * The provider generates pre-signed S3 GET URLs entirely locally. These tests
 * verify the URL structure, that `fetch` is never called, and that the batch
 * interface produces one URL per key.
 *
 * Requirements: 12.3, 9.6
 */

import { describe, expect, it, vi } from 'vitest';
import { thumbKey, previewKey } from '@photo-archive/core';
import { S3DirectUrlProvider } from './mediaUrlProvider.ts';
import type { AwsCredentials } from '../credentials/credentialProvider.ts';

const FAKE_CREDENTIALS: AwsCredentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'FQoGZXIvYXdzEExampleToken',
  expiration: Math.floor(Date.now() / 1000) + 3600,
};

const CONFIG = {
  bucket: 'my-photos-bucket',
  region: 'us-east-1',
  expiresIn: 3600,
};

function makeProvider(): S3DirectUrlProvider {
  return new S3DirectUrlProvider(CONFIG, () => Promise.resolve(FAKE_CREDENTIALS));
}

describe('S3DirectUrlProvider (task 5.3)', () => {
  it('returns an empty map for an empty key array without any network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = makeProvider();

    const urls = await provider.urlsFor([]);

    expect(urls.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('produces one URL per key passed in the batch', async () => {
    const hash = 'a'.repeat(64);
    const keys = [thumbKey('user123', hash), previewKey('user123', hash)];
    const provider = makeProvider();

    const urls = await provider.urlsFor(keys);

    expect(urls.size).toBe(keys.length);
    for (const key of keys) {
      expect(urls.has(key)).toBe(true);
    }
  });

  it('generated URLs are HTTPS and target the configured bucket', async () => {
    const key = thumbKey('user123', 'c'.repeat(64));
    const provider = makeProvider();

    const urls = await provider.urlsFor([key]);
    const url = urls.get(key);

    expect(url).toBeDefined();
    expect(url).toMatch(/^https:\/\/my-photos-bucket\.s3\.us-east-1\.amazonaws\.com\//);
  });

  it('signed URL contains all required SigV4 query parameters', async () => {
    const key = thumbKey('user123', 'd'.repeat(64));
    const provider = makeProvider();

    const urls = await provider.urlsFor([key]);
    const url = new URL(urls.get(key)!);
    const params = url.searchParams;

    expect(params.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(params.get('X-Amz-Credential')).toContain(FAKE_CREDENTIALS.accessKeyId);
    expect(params.get('X-Amz-Expires')).toBe('3600');
    expect(params.get('X-Amz-SignedHeaders')).toBe('host');
    expect(params.get('X-Amz-Signature')).toBeDefined();
    expect(params.get('X-Amz-Security-Token')).toBe(FAKE_CREDENTIALS.sessionToken);
  });

  it('does not call fetch — all signing is local', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = makeProvider();
    const keys = [thumbKey('user', 'e'.repeat(64)), previewKey('user', 'f'.repeat(64))];

    await provider.urlsFor(keys);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('different keys produce different URLs', async () => {
    const keyA = thumbKey('user', 'a'.repeat(64));
    const keyB = thumbKey('user', 'b'.repeat(64));
    const provider = makeProvider();

    const urls = await provider.urlsFor([keyA, keyB]);

    expect(urls.get(keyA)).not.toBe(urls.get(keyB));
  });
});
