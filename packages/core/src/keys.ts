/**
 * Object key derivation.
 *
 * Every key is a pure function of a tenant prefix and a content hash, so the client
 * computes keys on demand and no URL or absolute location is ever persisted anywhere
 * (Requirement 12.4). That is what keeps a CDN retrofit and a storage provider swap free of
 * data migration, and it is why nothing in this module reads configuration, consults a
 * clock, or touches I/O.
 *
 * **These functions are frozen.** A change to any of them does not fail loudly; it
 * relocates every object that every user has already stored, so previously uploaded bytes
 * become unreachable while re-upload appears to succeed. `keys.test.ts` pins the exact
 * output strings for known inputs for exactly this reason: the assertions are the record of
 * the layout, and editing them to match new behaviour is the mistake they exist to catch.
 * The layout table in `design.md` is the authority.
 *
 * | Key                                | Storage class        | Content                      |
 * | ---------------------------------- | -------------------- | ---------------------------- |
 * | `{prefix}/orig/{hash}`             | INTELLIGENT_TIERING  | Original bytes, never changed |
 * | `{prefix}/th/{hash}.webp`          | STANDARD             | 256 px thumbnail             |
 * | `{prefix}/pv/{hash}.webp`          | STANDARD             | 2048 px preview              |
 * | `{prefix}/vid/{hash}/720p.mp4`     | STANDARD             | Faststart MP4                |
 * | `{prefix}/vec/{modelId}/{shard}.bin` | STANDARD           | Packed coarse vectors        |
 * | `{prefix}/manifest/{yyyy-mm}.ndjson` | STANDARD           | Asset manifest               |
 *
 * The tenant prefix is the Cognito identity `sub`, which is also the IAM policy boundary —
 * the credential a client holds physically cannot name a key outside it (Requirement 13.3).
 * It is present even in the single-user case so that multi-tenant and bring-your-own-storage
 * deployments need no key restructuring (Requirement 3.4).
 *
 * Input is validated rather than trusted. A malformed hash would produce a key that is
 * syntactically fine and semantically wrong, and a prefix carrying `..` or an empty segment
 * would resolve outside the caller's own partition. Both fail closed here, where the error
 * names the offending value, instead of surfacing as an `AccessDenied` or a silently
 * misfiled object.
 */

/** Thrown when an input cannot produce a well-formed key. Always a programming error. */
export class KeyDerivationError extends Error {
  override readonly name = 'KeyDerivationError';
}

/** Lowercase SHA-256 hex. Uppercase is rejected rather than folded — see {@link assertHash}. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** A Cognito identity id looks like `us-east-1:{uuid}`, so the colon is permitted. */
const PREFIX_SEGMENT_PATTERN = /^[A-Za-z0-9._:-]+$/;

/** `EmbeddingModel.id` looks like `clip-vit-b32/pca256-v1`, so it may carry a `/`. */
const MODEL_ID_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Capture month, `yyyy-mm`, month 01-12. */
const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/**
 * Vector shard numbers are zero-padded to this width so that a bucket listing returns
 * shards in slot order. Lexicographic and numeric order coincide up to
 * {@link MAX_VECTOR_SHARD}; widening the padding is a key layout change and would orphan
 * every shard already uploaded.
 */
const SHARD_DIGITS = 5;

/**
 * Largest addressable vector shard. At 256 bytes per coarse vector even a modest shard
 * holds thousands of assets, so this is orders of magnitude beyond the 500,000 item / 2 TB
 * path the design targets. Exceeding it is a bug, not a scaling event.
 */
export const MAX_VECTOR_SHARD = 10 ** SHARD_DIGITS - 1;

/** True when `value` is a lowercase SHA-256 hex digest, and so usable as a content hash. */
export function isContentHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

/**
 * Uppercase hex is rejected rather than lowercased, because accepting both spellings means
 * the same bytes can produce two keys and therefore two stored objects, which defeats
 * deduplication (Requirement 3.2) and leaves verification comparing against the wrong
 * object. Callers normalize at the boundary where the digest is produced.
 */
function assertHash(hash: string): void {
  if (isContentHash(hash)) return;
  if (/^[0-9a-fA-F]{64}$/.test(hash)) {
    throw new KeyDerivationError(
      `content hash must be lowercase hex; got ${JSON.stringify(hash)} — lowercase it at the ` +
        'point the digest is produced, not here',
    );
  }
  throw new KeyDerivationError(
    `content hash must be 64 lowercase hex characters; got ${JSON.stringify(hash)}`,
  );
}

/**
 * Validates a slash-separated key component. Rejects empty segments, `.`, and `..`, all of
 * which would make the resulting key resolve somewhere other than where it reads.
 */
function assertSegments(label: string, value: string, segmentPattern: RegExp): void {
  if (value.length === 0) {
    throw new KeyDerivationError(`${label} must not be empty`);
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    throw new KeyDerivationError(
      `${label} must not start or end with '/'; got ${JSON.stringify(value)}`,
    );
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0) {
      throw new KeyDerivationError(
        `${label} must not contain an empty path segment; got ${JSON.stringify(value)}`,
      );
    }
    if (segment === '.' || segment === '..') {
      throw new KeyDerivationError(
        `${label} must not contain a relative path segment; got ${JSON.stringify(value)}`,
      );
    }
    if (!segmentPattern.test(segment)) {
      throw new KeyDerivationError(
        `${label} contains an unsupported character; got ${JSON.stringify(value)}`,
      );
    }
  }
}

function assertPrefix(prefix: string): void {
  assertSegments('tenant prefix', prefix, PREFIX_SEGMENT_PATTERN);
}

/** `{prefix}/orig/{hash}` — the original bytes. Intelligent-Tiering; never modified. */
export function origKey(prefix: string, hash: string): string {
  assertPrefix(prefix);
  assertHash(hash);
  return `${prefix}/orig/${hash}`;
}

/** `{prefix}/th/{hash}.webp` — 256 px long edge, the grid thumbnail. */
export function thumbKey(prefix: string, hash: string): string {
  assertPrefix(prefix);
  assertHash(hash);
  return `${prefix}/th/${hash}.webp`;
}

/** `{prefix}/pv/{hash}.webp` — 2048 px long edge, and the ceiling for routine reads. */
export function previewKey(prefix: string, hash: string): string {
  assertPrefix(prefix);
  assertHash(hash);
  return `${prefix}/pv/${hash}.webp`;
}

/**
 * `{prefix}/vid/{hash}/720p.mp4` — faststart MP4 for playback.
 *
 * The rendition sits in its own directory-shaped segment rather than in the filename, so
 * adding a second rendition later is an added key and not a rename of the existing one.
 */
export function videoKey(prefix: string, hash: string): string {
  assertPrefix(prefix);
  assertHash(hash);
  return `${prefix}/vid/${hash}/720p.mp4`;
}

/**
 * `{prefix}/vec/{modelId}/{shard}.bin` — packed coarse vectors, the backup that restores
 * search on a new device without re-running inference over the whole library
 * (Requirement 5.8).
 *
 * Keyed by `modelId` rather than by hash because a shard holds many assets, and because the
 * model identity is part of the vectors' meaning: vectors from two models do not share an
 * embedding space, so a model upgrade writes a new prefix and leaves the old shards
 * searchable until they are replaced (Requirement 5.9).
 */
export function vecKey(prefix: string, modelId: string, shard: number): string {
  assertPrefix(prefix);
  assertSegments('model id', modelId, MODEL_ID_SEGMENT_PATTERN);
  if (!Number.isInteger(shard) || shard < 0 || shard > MAX_VECTOR_SHARD) {
    throw new KeyDerivationError(
      `vector shard must be an integer in 0..${MAX_VECTOR_SHARD}; got ${String(shard)}`,
    );
  }
  return `${prefix}/vec/${modelId}/${String(shard).padStart(SHARD_DIGITS, '0')}.bin`;
}

/**
 * `{prefix}/manifest/{yyyy-mm}.ndjson` — the human-readable manifest for one capture month.
 *
 * Partitioned by month rather than by hash because this is the data-escape guarantee
 * (Requirements 10.3, 10.4): the manifest plus `rclone` and a JSON parser is enough to
 * reconstruct a meaningful library with no app involved, and a per-asset manifest would not
 * be readable that way.
 *
 * @param month `yyyy-mm` of the capture month, in the asset's own local time.
 */
export function manifestKey(prefix: string, month: string): string {
  assertPrefix(prefix);
  if (!MONTH_PATTERN.test(month)) {
    throw new KeyDerivationError(
      `capture month must be 'yyyy-mm' with a month in 01..12; got ${JSON.stringify(month)}`,
    );
  }
  return `${prefix}/manifest/${month}.ndjson`;
}
