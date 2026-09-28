/**
 * Enumerated state values.
 *
 * Every numeric value in this file is **persisted** — in the device SQLite database, in
 * the DynamoDB change log, and in `jobs.kind` — and is synced between devices running
 * different app versions. Values are therefore append-only: a new member gets the next
 * unused number, and an existing number is never reused or renumbered. Renaming a member
 * is safe; changing its value silently reinterprets every stored row.
 *
 * The values match the schema comments in `design.md` exactly. `states.test.ts` pins each
 * one so a drift shows up as a test failure rather than as corrupted metadata.
 *
 * These are `const` objects plus union types rather than TypeScript enums because
 * `erasableSyntaxOnly` is on repo-wide — see the conventions section of `README.md`.
 */

/**
 * `assets.kind`. `MotionComponent` is the MOV half of a Live Photo: a real asset with its
 * own hash and bytes, linked through `livePairHash`, but excluded from timeline queries so
 * a Live Photo appears once (design: Takeout metadata repair).
 */
export const AssetKind = {
  Image: 0,
  Video: 1,
  MotionComponent: 2,
} as const;
export type AssetKind = (typeof AssetKind)[keyof typeof AssetKind];

/**
 * `assets.captured_at_src` — provenance of `capturedAt`, stored rather than discarded so a
 * later correction pass can tell a trusted timestamp from a guess (Requirements 1.2, 1.3).
 *
 * Precedence when resolving: `TakeoutJson` beats `Exif` beats `FileMtime`, because Takeout
 * frequently strips or rewrites EXIF dates. `User` is an explicit manual correction and
 * outranks everything.
 */
export const CapturedAtSource = {
  Exif: 0,
  TakeoutJson: 1,
  FileMtime: 2,
  User: 3,
} as const;
export type CapturedAtSource = (typeof CapturedAtSource)[keyof typeof CapturedAtSource];

/**
 * `assets.remote_state` — what object storage is known to hold.
 *
 * `Verified` means the stored bytes have been confirmed to hash to the content hash. A
 * successful upload response alone only reaches `Uploading`; nothing but verification
 * advances past it, because `Verified` is a precondition for deleting the local original
 * (Requirement 6.2).
 */
export const RemoteState = {
  LocalOnly: 0,
  Uploading: 1,
  Verified: 2,
  Failed: 3,
} as const;
export type RemoteState = (typeof RemoteState)[keyof typeof RemoteState];

/**
 * `assets.local_state` — what the device photo library still holds.
 *
 * `PurgeEligible` requires `RemoteState.Verified` *and* the derivatives in
 * {@link PURGE_REQUIRED_DERIVATIVES}; `Purged` is only ever reached through an explicit
 * in-app confirmation plus the platform's own system prompt (Requirements 6.4-6.6).
 */
export const LocalState = {
  Absent: 0,
  Present: 1,
  PurgeEligible: 2,
  Purged: 3,
} as const;
export type LocalState = (typeof LocalState)[keyof typeof LocalState];

/**
 * `assets.tier_state` — retrieval latency of the stored original (Requirement 12.1).
 *
 * Present from the first release so that a non-instant original renders a restoring state
 * instead of looking broken. Originals sit in Intelligent-Tiering, which is `Instant`
 * today; this exists so moving them to an archive tier stays a possibility.
 */
export const TierState = {
  Instant: 0,
  Cold: 1,
  Restoring: 2,
} as const;
export type TierState = (typeof TierState)[keyof typeof TierState];

/**
 * `local_assets.platform` — which photo library API a local identifier came from.
 *
 * Persisted, and part of a source reference's identity: a `PHAsset.localIdentifier` and a
 * MediaStore `_ID` are drawn from different namespaces and could collide as bare strings.
 */
export const Platform = {
  Ios: 0,
  Android: 1,
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

/**
 * `local_assets.hash_state` — how far the `Hash` stage got with a local original.
 *
 * `Unreadable` is the design's specified handling for an original that cannot be read or
 * decoded — reached on Android below API 28 for HEIC (spike 0.2), and for any corrupt file.
 * It exists so such an item is surfaced in ingest status rather than silently skipped, which
 * matters because an asset that was never hashed can never be verified and so can never
 * become purge-eligible.
 *
 * `Done` means a digest was computed, not that it was recorded against an asset row.
 * `local_assets.hash` carries a foreign key into `assets`, and the asset row cannot exist
 * until `ExtractMeta` and `Derive` have supplied the columns the schema declares `NOT NULL`.
 * The digest therefore travels in the job row between those stages — see `ingest/dedupe.ts`.
 */
export const HashState = {
  Pending: 0,
  Done: 1,
  Unreadable: 2,
} as const;
export type HashState = (typeof HashState)[keyof typeof HashState];

/**
 * `purge_audit.verify_method` — how the stored bytes were confirmed (Requirement 6.8).
 *
 * `FullRedownloadSha256` is 0 because it is the value pinned by the schema comment in
 * `design.md`, and because it is the universal fallback: it works against any provider.
 * The checksum methods are *preferred* where available — S3 refuses to persist bytes that
 * do not match a supplied SHA-256, so corruption is caught before storage rather than
 * detected after — but they are numbered after the fallback to keep the one persisted
 * value the design fixes.
 *
 * Preference order at runtime is `S3ChecksumSha256`, then `S3CompositeSha256` for
 * multipart uploads, then `FullRedownloadSha256`. Order of preference is deliberately not
 * the numeric order; ranking belongs to the verification service (task 8.1).
 */
export const VerifyMethod = {
  /** Stream the object back and hash it. Costs full egress. Works everywhere. */
  FullRedownloadSha256: 0,
  /** Single-part upload: `x-amz-checksum-sha256`, confirmed via `HeadObject`. No egress. */
  S3ChecksumSha256: 1,
  /** Multipart upload: composite of per-part digests, computed locally and compared. */
  S3CompositeSha256: 2,
} as const;
export type VerifyMethod = (typeof VerifyMethod)[keyof typeof VerifyMethod];

/**
 * `jobs.kind` — one durable job row per pipeline stage, so ingest resumes from the last
 * completed stage across process death, reboot, and network loss (Requirements 1.9, 2.4).
 *
 * `Derive`, `Embed`, and `Ocr` all run before the upload stages, while the decoded bitmap
 * is still in hand. That ordering is what removes server-side media processing entirely
 * (Requirement 9.5) and is described in the ingest pipeline section of `design.md`; it is
 * not implied by these numbers, which are storage identifiers rather than a sequence.
 */
/**
 * `jobs.state` — where a durable job row is in its lifecycle.
 *
 * Persisted, but **device-local**: the queue is a work list for this machine, and nothing
 * here is published to the change log. It is still append-only for the same reason as
 * everything else in this file — the rows outlive the process that wrote them, which is the
 * entire point of a durable queue, and a renumbering would reinterpret the queue of every
 * install that upgrades mid-ingest.
 *
 * The values are the ones the schema comment in `design.md` fixes. Two of them are written
 * into DDL: `idx_jobs_runnable` is `WHERE state IN (0, 3)`, so {@link Pending} and
 * {@link Failed} being 0 and 3 is load-bearing rather than incidental, and `schema.test.ts`
 * asserts the predicate against these constants.
 *
 * `Failed` and `Dead` are different things, and the difference is whether anything will
 * happen next. `Failed` is a job waiting out its backoff — it is in the runnable index and
 * will be claimed again. `Dead` is a job that exhausted its attempts, and it is out of the
 * index for good; it surfaces in the per-item error view (Requirement 2.7) rather than
 * retrying forever. See `queue/jobQueue.ts`.
 */
export const JobState = {
  /** Enqueued, never claimed. */
  Pending: 0,
  /** Claimed by a worker. `next_attempt_at` is the lease deadline — see `queue/jobQueue.ts`. */
  Running: 1,
  /** Finished successfully. Terminal, and never retried. */
  Done: 2,
  /** Attempt failed, retry scheduled at `next_attempt_at`. Still in the runnable index. */
  Failed: 3,
  /** Attempts exhausted. Terminal until a user asks for a retry. */
  Dead: 4,
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

export const IngestStage = {
  /** Enumerate the device library or walk the Takeout archives. */
  Scan: 0,
  /** Stream original bytes to a sha256. Materializes non-resident iOS originals. */
  Hash: 1,
  /** EXIF plus sidecar to normalized metadata, with provenance. */
  ExtractMeta: 2,
  /** thumbhash, 256 px thumb, 2048 px preview, video poster. */
  Derive: 3,
  /** CLIP image vector, projected to a coarse slot plus the full vector. */
  Embed: 4,
  /** On-device text recognition into the FTS index. */
  Ocr: 5,
  /** INTELLIGENT_TIERING, with the sha256 checksum header. */
  UploadOriginal: 6,
  /** STANDARD. */
  UploadDerivatives: 7,
  /** Confirm the stored bytes match the content hash. */
  Verify: 8,
  /** Video only: 720p faststart MP4. Preferred on the desktop importer. */
  Transcode: 9,
  /** Append the NDJSON line for the capture month. */
  ManifestAppend: 10,
  /** Publish the record to the change log. */
  SyncPush: 11,
} as const;
export type IngestStage = (typeof IngestStage)[keyof typeof IngestStage];

/**
 * `assets.derivative_mask` — a bitfield of the derivatives confirmed to exist.
 *
 * A bitfield rather than one column per derivative because the set will grow, and because
 * the eligibility check is a single mask comparison. Confirmed means observed present, not
 * requested: purging a local original whose thumbnail or preview is missing would leave a
 * hole in the timeline that nothing can fill (Requirement 6.5).
 *
 * `Thumbhash` is included even though it lives in the database rather than object storage,
 * because it is the placeholder that keeps a grid cell from rendering empty (Requirement
 * 4.2) and it is what survives cache eviction (Requirement 4.5).
 *
 * New members take the next unused bit. Bits are never reused.
 */
export const DerivativeKind = {
  /** ~25 bytes in `assets.thumbhash`. Never evicted. */
  Thumbhash: 1,
  /** `{prefix}/th/{hash}.webp` — 256 px long edge. */
  Thumb: 2,
  /** `{prefix}/pv/{hash}.webp` — 2048 px long edge. */
  Preview: 4,
  /** `{prefix}/vid/{hash}/720p.mp4` — faststart, video only. */
  Video720p: 8,
} as const;
export type DerivativeKind = (typeof DerivativeKind)[keyof typeof DerivativeKind];

/**
 * A set of {@link DerivativeKind} bits. Distinct from `DerivativeKind` itself, which is a
 * single bit: a mask of `Thumb | Preview` is a valid mask but not a valid kind.
 */
export type DerivativeMask = number;

/** The empty mask. `assets.derivative_mask` defaults to this. */
export const NO_DERIVATIVES: DerivativeMask = 0;

/**
 * The derivatives that must be confirmed present before an asset can become
 * `LocalState.PurgeEligible` (design: reclamation invariant 2, Requirement 6.5).
 *
 * The video derivative is deliberately not required: a video with a thumbnail and a
 * preview still renders a complete timeline, and the 720p transcode is regenerable from
 * the original that object storage holds.
 */
export const PURGE_REQUIRED_DERIVATIVES: DerivativeMask =
  DerivativeKind.Thumb | DerivativeKind.Preview;

/** True when `mask` contains every bit in `kinds`. An empty `kinds` is trivially present. */
export function hasDerivatives(mask: DerivativeMask, kinds: DerivativeMask): boolean {
  return (mask & kinds) === kinds;
}

/** `mask` with every bit in `kinds` set. */
export function addDerivatives(mask: DerivativeMask, kinds: DerivativeMask): DerivativeMask {
  return mask | kinds;
}

/**
 * `mask` with every bit in `kinds` cleared. Used when a derivative is found missing or is
 * invalidated, which must be able to walk an asset back out of purge eligibility.
 */
export function removeDerivatives(mask: DerivativeMask, kinds: DerivativeMask): DerivativeMask {
  return mask & ~kinds;
}
