/**
 * Pure JavaScript cryptographic utilities (SHA-256 & HMAC-SHA256).
 *
 * Runs anywhere without depending on `globalThis.crypto` or `crypto.subtle`,
 * ensuring 100% reliability in React Native / Expo Go on Hermes and JSC.
 *
 * Implements FIPS 180-4 and RFC 2104 / RFC 4231 HMAC-SHA256.
 */

import { PortableSha256 } from '@photo-archive/core';

const BLOCK_SIZE = 64;

function toBytes(data: Uint8Array | string): Uint8Array {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data);
  }
  return data;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Computes lowercase 64-hex SHA-256 of data.
 */
export function sha256Hex(data: Uint8Array | string): string {
  const hasher = new PortableSha256();
  hasher.update(toBytes(data));
  return hasher.digest();
}

/**
 * Computes raw 32-byte SHA-256 of data.
 */
export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return hexToBytes(sha256Hex(data));
}

/**
 * Computes raw 32-byte HMAC-SHA256 per RFC 2104 / RFC 4231.
 */
export function hmacSha256Bytes(
  key: Uint8Array | string,
  message: Uint8Array | string,
): Uint8Array {
  const keyBytes = toBytes(key);
  const msgBytes = toBytes(message);

  let keyBlock = new Uint8Array(BLOCK_SIZE);

  if (keyBytes.length > BLOCK_SIZE) {
    const hashedKey = sha256Bytes(keyBytes);
    keyBlock.set(hashedKey);
  } else {
    keyBlock.set(keyBytes);
  }

  const ipad = new Uint8Array(BLOCK_SIZE);
  const opad = new Uint8Array(BLOCK_SIZE);

  for (let i = 0; i < BLOCK_SIZE; i++) {
    const k = keyBlock[i] ?? 0;
    ipad[i] = k ^ 0x36;
    opad[i] = k ^ 0x5c;
  }

  // Inner hash: H(ipad || message)
  const innerHasher = new PortableSha256();
  innerHasher.update(ipad);
  innerHasher.update(msgBytes);
  const innerDigestBytes = hexToBytes(innerHasher.digest());

  // Outer hash: H(opad || innerDigest)
  const outerHasher = new PortableSha256();
  outerHasher.update(opad);
  outerHasher.update(innerDigestBytes);
  return hexToBytes(outerHasher.digest());
}

/**
 * Computes lowercase 64-hex HMAC-SHA256.
 */
export function hmacSha256Hex(
  key: Uint8Array | string,
  message: Uint8Array | string,
): string {
  return bytesToHex(hmacSha256Bytes(key, message));
}

/**
 * Derives AWS SigV4 signing key using the standard 4-step HMAC-SHA256 chain.
 * kDate    = HMAC("AWS4" + secretKey, datestamp)
 * kRegion  = HMAC(kDate, region)
 * kService = HMAC(kRegion, service)
 * kSigning = HMAC(kService, "aws4_request")
 */
export function deriveSigV4SigningKey(
  secretKey: string,
  datestamp: string,
  region: string,
  service = 's3',
): Uint8Array {
  const kSecret = `AWS4${secretKey}`;
  const kDate = hmacSha256Bytes(kSecret, datestamp);
  const kRegion = hmacSha256Bytes(kDate, region);
  const kService = hmacSha256Bytes(kRegion, service);
  return hmacSha256Bytes(kService, 'aws4_request');
}
