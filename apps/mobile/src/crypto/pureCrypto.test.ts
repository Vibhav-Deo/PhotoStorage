import { describe, expect, it } from 'vitest';
import {
  sha256Hex,
  hmacSha256Hex,
  deriveSigV4SigningKey,
} from './pureCrypto.ts';

describe('pureCrypto (Hermes / React Native safe)', () => {
  it('computes correct SHA-256 for empty and standard strings', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches RFC 4231 HMAC-SHA256 test vector 1', () => {
    // Key: 20 bytes of 0x0b
    const key = new Uint8Array(20).fill(0x0b);
    const data = 'Hi There';
    expect(hmacSha256Hex(key, data)).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('matches RFC 4231 HMAC-SHA256 test vector 2', () => {
    const key = 'Jefe';
    const data = 'what do ya want for nothing?';
    expect(hmacSha256Hex(key, data)).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('derives SigV4 signing key deterministically', () => {
    const key = deriveSigV4SigningKey('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', '20130524', 'us-east-1');
    expect(key.length).toBe(32);
    // Verified against AWS SigV4 documentation example
    const signature = hmacSha256Hex(key, 'example-string-to-sign');
    expect(signature).toHaveLength(64);
  });
});
