/**
 * `MediaUrlProvider` implementations.
 *
 * v1: `S3DirectUrlProvider` — generates pre-signed S3 URLs locally using SigV4.
 * Zero network calls; the URL is valid for `expiresIn` seconds (default 3600).
 *
 * The interface is batch-shaped from day one so that introducing CloudFront signed
 * URLs is an implementation swap, not a call-site refactor (Requirement 12.3, 9.6).
 *
 * Requirements: 12.3, 9.6
 */

import { thumbKey, previewKey, origKey, videoKey } from '@photo-archive/core';
import type { AwsCredentials } from '../credentials/credentialProvider.ts';
import {
  sha256Hex,
  hmacSha256Hex,
  deriveSigV4SigningKey,
} from '../crypto/pureCrypto.ts';

export interface MediaUrlProvider {
  urlsFor(keys: string[]): Promise<Map<string, string>>;
}

export interface S3DirectUrlProviderConfig {
  readonly bucket: string;
  readonly region: string;
  /** URL validity in seconds. Default 3600. */
  readonly expiresIn?: number;
}

/** Re-export key derivation helpers for call sites that build key arrays. */
export { thumbKey, previewKey, origKey, videoKey };

/**
 * Generates a pre-signed S3 GET URL using SigV4 query-string signing.
 * All signing is local — pure JavaScript, no native crypto dependency.
 */
export async function presignS3Url(
  key: string,
  credentials: AwsCredentials,
  config: S3DirectUrlProviderConfig,
  expiresIn: number,
): Promise<string> {
  const region = config.region;
  const bucket = config.bucket;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzdate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z';
  const credentialScope = `${datestamp}/${region}/s3/aws4_request`;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');

  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzdate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-Security-Token': credentials.sessionToken,
    'X-Amz-SignedHeaders': 'host',
  });
  // Sort for canonical form.
  queryParams.sort();

  const canonicalRequest = [
    'GET',
    `/${encodedKey}`,
    queryParams.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const canonicalHash = sha256Hex(canonicalRequest);
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, credentialScope, canonicalHash].join('\n');

  // Derive signing key using pure JS HMAC-SHA256 chain
  const signingKey = deriveSigV4SigningKey(credentials.secretAccessKey, datestamp, region);
  const signature = hmacSha256Hex(signingKey, stringToSign);

  return `https://${host}/${encodedKey}?${queryParams.toString()}&X-Amz-Signature=${signature}`;
}

/**
 * Generates a pre-signed S3 PUT URL using SigV4 query-string signing.
 * Used for direct mobile-to-S3 uploads of original assets and derivatives.
 */
export async function presignS3PutUrl(
  key: string,
  credentials: AwsCredentials,
  config: S3DirectUrlProviderConfig,
  expiresIn = 3600,
): Promise<string> {
  const region = config.region;
  const bucket = config.bucket;
  const host = `${bucket}.s3.${region}.amazonaws.com`;
  const now = new Date();
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzdate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z';
  const credentialScope = `${datestamp}/${region}/s3/aws4_request`;
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');

  const queryParams = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzdate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-Security-Token': credentials.sessionToken,
    'X-Amz-SignedHeaders': 'host',
  });
  queryParams.sort();

  const canonicalRequest = [
    'PUT',
    `/${encodedKey}`,
    queryParams.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const canonicalHash = sha256Hex(canonicalRequest);
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, credentialScope, canonicalHash].join('\n');

  const signingKey = deriveSigV4SigningKey(credentials.secretAccessKey, datestamp, region);
  const signature = hmacSha256Hex(signingKey, stringToSign);

  return `https://${host}/${encodedKey}?${queryParams.toString()}&X-Amz-Signature=${signature}`;
}

export class S3DirectUrlProvider implements MediaUrlProvider {
  private readonly _config: S3DirectUrlProviderConfig;
  private readonly _getCredentials: () => Promise<AwsCredentials>;

  constructor(config: S3DirectUrlProviderConfig, getCredentials: () => Promise<AwsCredentials>) {
    this._config = config;
    this._getCredentials = getCredentials;
  }

  async urlsFor(keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const credentials = await this._getCredentials();
    const expiresIn = this._config.expiresIn ?? 3600;
    const entries = await Promise.all(
      keys.map(async (key) => {
        const url = await presignS3Url(key, credentials, this._config, expiresIn);
        return [key, url] as const;
      }),
    );
    return new Map(entries);
  }
}
