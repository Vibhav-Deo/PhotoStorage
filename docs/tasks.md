# Implementation Plan

## Sequencing rationale

Three decisions shape the order below.

**Spikes first.** Open question 1 from the design (on-device CLIP text encoder) can invalidate
Requirements 5.2 and 5.7. Resolving it costs a day; discovering it in month three costs a redesign.

**Local before cloud.** The `ObjectStore` seam allows a filesystem-backed implementation, so the
entire Takeout importer — including the metadata repair rules, which are the hardest logic and the
product's actual differentiator — is built and tested with zero AWS involvement. S3 gets swapped in
once the pipeline is proven.

**Importer before app.** The importer is independent of every mobile unknown, and it is what actually
gets photos out of Google. It delivers standalone value even if the app slips.

Reclamation is deliberately last among features. It is the only irreversible operation in the system
and it depends on verification, derivatives, and sync all being trustworthy.

---

## Phase 0: De-risk

- [x] 0.1 Spike the on-device CLIP text encoder
  - Build a throwaway Expo app that loads the CLIP image encoder and attempts text encoding on both
    iOS and Android via `react-native-executorch`
  - Verify that a text embedding and an image embedding of matching content produce high cosine
    similarity, confirming the two towers share an embedding space
  - If unavailable, evaluate in order: ONNX Runtime text encoder, separately bundled text tower
  - Record the outcome in the design's open questions section
  - _Blocks: 6.1. Could force a change to Requirements 5.2, 5.7_

- [x] 0.2 Spike FTS5 and HEIC handling
  - Confirm `expo-sqlite` exposes FTS5 on both platforms; if not, design a token-table fallback
  - Confirm a working HEIC decode and downscale path in React Native on both platforms
  - _Requirements: 5.4_

- [x] 0.3 Confirm model licensing
  - Verify the exact converted CLIP ViT-B/32 artifact shipped by the runtime carries a commercial-use
    license, and record the license text and provenance in the repo
  - _Requirements: 11.4_

---

## Phase 1: Shared core

Consumed by both the importer and the app. No cloud dependency.

- [x] 1.1 Monorepo scaffold
  - Workspaces: `packages/core`, `packages/importer`, `apps/mobile`, `infra`
  - TypeScript strict mode, shared tsconfig, Vitest, lint, formatter
  - _Requirements: none (foundation)_

- [x] 1.2 Domain types
  - `AssetRecord`, `AlbumRecord`, `IngestStage`, `RemoteState`, `LocalState`, `TierState`,
    `CapturedAtSource`, `VerifyMethod`, `DerivativeKind` as a bitfield
  - Key derivation functions: `origKey`, `thumbKey`, `previewKey`, `videoKey`, `vecKey`,
    `manifestKey`, all pure functions of hash and tenant prefix
  - Unit tests asserting key stability — a change here invalidates every stored object
  - _Requirements: 3.1, 3.3, 3.4, 12.4_

- [x] 1.3 SQLite schema and migration runner
  - Full schema from the design, including partial indexes
  - Forward-only migration runner keyed on `schema_meta`, with a test that migrates an empty database
    and a populated one
  - _Requirements: 3.5, 4.5_

- [x] 1.4 ObjectStore interface and local implementation
  - `ObjectStore` per the design, plus a `capabilities()` method reporting additional-checksum support
  - `LocalFsObjectStore`: filesystem-backed, records storage class as sidecar metadata, simulates
    multipart, reports no checksum support to exercise the fallback path
  - Conformance test suite runnable against any implementation
  - _Requirements: 10.1, 10.2, 10.5_

- [x] 1.5 Content hashing
  - Streaming SHA-256 over arbitrarily large files without full buffering
  - Dedupe resolution: same hash from two sources yields one asset with two source references
  - Tests using byte-identical fixtures arriving via different paths
  - _Requirements: 3.1, 3.2_

- [x] 1.6 Durable job queue
  - Enqueue, claim, complete, fail with exponential backoff and jitter, dead-letter after 5 attempts
  - Resumption: a test that kills the runner mid-stage and asserts no work is lost or duplicated
  - Injected clock so backoff is testable without waiting
  - _Requirements: 1.9, 2.4_

---

## Phase 2: Takeout importer

The highest-value component and the one with the most subtle failure modes.

- [x] 2.1 Build the Takeout fixture corpus
  - Check in directory structures covering: exact sidecars, `supplemental-metadata` sidecars,
    truncated filenames, `(n)` disambiguators in both positions, `-edited` variants including
    localized suffixes, HEIC+MOV Live Photo pairs, album folders with `metadata.json`,
    `Photos from YYYY` buckets, `Archive` and `Trash`, and unpaired media
  - Use tiny synthetic images so the corpus is small enough to version
  - This corpus is the regression suite for every rule below
  - _Requirements: 1.1–1.7_

- [x] 2.2 Multi-archive traversal
  - Treat a set of archive parts as one logical export; handle assets split across parts
  - _Requirements: 1.1_

- [x] 2.3 Sidecar pairing resolver
  - Implement the four-step resolution order: exact, truncated prefix, disambiguator swap, unique
    basename within directory
  - Unpaired media is imported with degraded provenance, never dropped
  - _Requirements: 1.4, 1.10_

- [x] 2.4 Timestamp provenance resolution
  - Precedence: sidecar `photoTakenTime`, then EXIF `DateTimeOriginal`, then mtime
  - Persist the chosen source in `captured_at_src`
  - Test the case where EXIF and sidecar disagree and assert the sidecar wins
  - _Requirements: 1.2, 1.3_

- [x] 2.5 Variant and Live Photo linking
  - `-edited` and localized equivalents resolve to `variant_of_hash`
  - Same-stem image plus MOV links via `live_pair_hash`; the MOV is `motion_component` and excluded
    from timeline queries
  - _Requirements: 1.5, 1.6_

- [x] 2.6 Album reconstruction
  - Named folders with `metadata.json` become albums; `Photos from YYYY` does not
  - Membership by reference, so multi-album assets are stored once
  - _Requirements: 1.7, 3.5_

- [x] 2.7 Derivative generation
  - thumbhash, 256 px thumbnail, 2048 px preview via `sharp`
  - Assert originals are byte-identical before and after processing
  - _Requirements: 1.8, 7.2_

- [x] 2.8 Video derivatives
  - Poster frame extraction, then 720p faststart MP4 via `ffmpeg`
  - _Requirements: 9.5_

- [x] 2.9 Embedding generation in Node
  - CLIP image embedding via `onnxruntime-node`, fixed PCA projection to 256 dims, int8 quantization
  - The projection matrix ships as a versioned static asset and must be byte-identical to the one the
    app uses, with a test asserting the importer and app produce comparable vectors
  - `coarse.bin` writer and slot allocator including free-slot reuse
  - _Requirements: 5.1, 11.2, 11.5, 12.5_

- [x] 2.10 Manifest writer
  - NDJSON per capture month, one line per asset
  - Test that the manifest alone is sufficient to reconstruct a timeline with dates, locations, and
    album membership
  - _Requirements: 10.3, 10.4_

- [x] 2.11 Wire the pipeline end-to-end
  - All stages against `LocalFsObjectStore`; resumable via the job queue
  - Integration test over the full fixture corpus asserting final database and object state
  - _Requirements: 1.9, 9.5_

- [x] 2.12 Reconciliation report
  - Counts for found, imported, deduplicated, skipped, failed, with a per-item reason for everything
    not imported
  - _Requirements: 1.10_

---

## Phase 3: Infrastructure

- [x] 3.1 CDK: storage
  - Bucket with Intelligent-Tiering configuration, public access blocked, versioning off for
    derivative prefixes, CORS for the mobile client
  - _Requirements: 9.2, 9.3, 10.6_

- [x] 3.2 CDK: identity
  - Cognito User Pool on the Essentials tier with Google, Apple, and Facebook as social providers
  - Identity Pool with an authenticated role whose policy scopes S3 to
    `${cognito-identity.amazonaws.com:sub}/*` exactly as specified in the design
  - _Requirements: 13.2, 13.3_

- [x] 3.3 CDK: metadata store
  - DynamoDB on-demand, single table, **LSI on `version` defined at creation** since it cannot be
    added later
  - _Requirements: 8.1, 12.6_

- [x] 3.4 CDK: sync Lambda
  - Function URL, JWT verification against the User Pool JWKS, atomic version counter increment,
    delta pull and push handlers
  - Reject any record whose key falls outside the caller's own partition
  - _Requirements: 8.1, 8.4, 11.3_

- [x] 3.5 S3ObjectStore implementation
  - SigV4 against STS credentials, multipart above 8 MB, `x-amz-checksum-sha256` on single-part put,
    per-part checksums plus locally computed composite for multipart
  - Must pass the Phase 1.4 conformance suite unmodified
  - _Requirements: 6.2, 10.1, 10.5_

- [x] 3.6 IAM isolation test
  - Integration test asserting `AccessDenied` when credentials scoped to one `sub` request a key
    under another
  - _Requirements: 13.3_

- [x] 3.7 Point the importer at S3
  - Swap `LocalFsObjectStore` for `S3ObjectStore` via configuration only, no importer code change
  - Re-run the full fixture integration test against a real bucket
  - _Requirements: 10.2, 10.5_

---

## Phase 4: App foundation

- [x] 4.1 Expo app scaffold
  - Prebuild with config plugins for full photo library access, background upload, and native modules
  - _Requirements: none (foundation)_

- [x] 4.2 Authentication
  - Sign-in with Google, Facebook, and Sign in with Apple, which is mandatory once other social
    providers are offered
  - _Requirements: 13.1_

- [x] 4.3 CredentialProvider
  - Token exchange for STS credentials, caching, refresh before expiry, and read-only-local
    degradation when refresh fails
  - _Requirements: 13.2, 13.4_

- [x] 4.4 On-device database
  - Schema and migration runner from Phase 1.3 running on the device
  - _Requirements: 4.1_

- [x] 4.5 Metadata sync client
  - Cursor-based delta pull and push, per-field last-writer-wins by `updated_at`, tombstones win
  - Two-simulated-device integration test covering conflicting edits and a propagated deletion
  - _Requirements: 8.1, 8.3, 8.4_

- [x] 4.6 New-device bootstrap
  - Reconstruct the full timeline from the change log plus the vector backup, without touching the
    photo library
  - _Requirements: 8.2, 5.8_

---

## Phase 5: Browse

- [x] 5.1 Thumbhash placeholder
  - Decode thumbhash to a renderable placeholder; grid cells never render empty
  - _Requirements: 4.2, 4.5_

- [x] 5.2 Timeline grid
  - `FlashList` with fixed cell geometry, reading only from local SQLite
  - _Requirements: 4.1, 4.3_

- [x] 5.3 MediaUrlProvider
  - `S3DirectUrlProvider` implementing the batch interface with local SigV4 and no network calls
  - Call sites must pass key arrays, so the later CloudFront swap touches nothing else
  - _Requirements: 12.3, 9.6_

- [x] 5.4 Bounded thumbnail cache
  - Size-capped LRU with `thumb_cache` accounting; eviction never removes thumbhashes
  - Test that exceeding the cap evicts in LRU order and that browse still renders after eviction
  - _Requirements: 4.4, 12.2_

- [x] 5.5 Asset detail
  - Preview fetch, pinch-zoom, metadata panel; must not fetch originals
  - _Requirements: 7.1, 7.2_

- [x] 5.6 Video playback
  - 720p derivative with range requests
  - _Requirements: 7.1_

- [x] 5.7 Albums and offline verification
  - Album browsing, plus an explicit test that browse and preview work with networking disabled
  - _Requirements: 3.5, 4.6_

---

## Phase 6: Search

- [x] 6.1 On-device embedding
  - `EmbeddingModel` implementation for image and text using the Phase 0.1 outcome
  - Assert the on-device projection matches the importer's for identical input
  - _Requirements: 5.1, 5.2, 11.2_

- [x] 6.2 Coarse index
  - `coarse.bin` read path, slot allocation, free-slot reuse, chunked reads for large buffers
  - _Requirements: 12.5_

- [x] 6.3 Two-stage retrieval
  - int32 dot-product scan with a bounded min-heap for top 500, then exact cosine rerank from
    `vector_full`
  - Recall test against exhaustive exact search over a labeled corpus, with a recall floor
  - _Requirements: 5.1, 5.3, 12.5_

- [x] 6.4 OCR
  - On-device text recognition into the FTS index, using the Phase 0.2 outcome
  - _Requirements: 5.4_

- [x] 6.5 Filters and fusion
  - Date, location, camera, and kind predicates applied to the candidate set; reciprocal rank fusion
    across vector, FTS, and filter signals
  - Raise the coarse candidate count when a filter is highly selective
  - _Requirements: 5.5, 5.6_

- [x] 6.6 Search UI and offline verification
  - Result grid with ranked ordering; explicit test that search works with networking disabled
  - _Requirements: 5.3, 5.7_

- [x] 6.7 Vector backup and restore
  - Upload packed shards to `{sub}/vec/{modelId}/`; restore on a fresh device without re-inferring
  - _Requirements: 5.8_

- [x] 6.8 Model version migration
  - Detect `model_id` mismatch at startup and enqueue incremental re-embedding; stale vectors stay
    searchable until replaced
  - _Requirements: 5.9, 11.5_

---

## Phase 7: Device ingest

- [x] 7.1 Library enumeration
  - PhotoKit and MediaStore enumeration into `local_assets`, incremental on subsequent runs
  - Handle limited-access authorization and communicate that the library is partial
  - _Requirements: 2.1, 2.3_

- [x] 7.2 Original materialization
  - Request non-resident iOS originals from iCloud with network access permitted before hashing
  - _Requirements: 2.2_

- [x] 7.3 On-device derivatives
  - thumbhash, thumbnail, preview, and video poster generated before upload while the decode is warm
  - _Requirements: 9.5_

- [x] 7.4 Upload
  - Bounded concurrency, multipart above 8 MB, checksums supplied on upload, resumable
  - _Requirements: 2.4, 2.5_

- [x] 7.5 Background execution
  - Background upload on both platforms, surviving termination and reboot
  - _Requirements: 2.4_

- [x] 7.6 Backpressure
  - Pause on thermal throttle, pause below 20% battery when not charging, defer on metered
    connections unless opted in
  - _Requirements: 2.6_

- [x] 7.7 Ingest status UI
  - Per-item state and a library-wide progress summary; dead-lettered items surfaced with reasons
  - _Requirements: 2.7_

---

## Phase 8: Verified reclamation

The only irreversible operation in the system. Built last, tested hardest.

- [x] 8.1 Verification service
  - All three methods: single-part checksum confirmed via `HeadObject`, multipart composite computed
    locally and compared, full re-download fallback
  - Automatic fallback when the provider reports no checksum support
  - Tests including a deliberately corrupted object that must fail verification
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 8.2 Eligibility state machine
  - Transitions exactly as specified, gated on verified remote state and confirmed thumbnail and
    preview presence
  - Exhaustive invalid-transition test matrix; assert that an HTTP 200 upload alone never produces
    eligibility
  - _Requirements: 6.2, 6.4, 6.5_

- [x] 8.3 Audit trail
  - `purge_audit` row written before any deletion is attempted, capturing hash, remote key, method,
    timestamp, byte size, and outcome
  - _Requirements: 6.8, 6.9_

- [x] 8.4 Reclaim UI
  - Discloses item count, bytes to be freed, and that deletion also removes items from iCloud Photos
    when sync is enabled
  - _Requirements: 6.6, 6.7_

- [x] 8.5 Batched deletion
  - One platform change request per batch so thousands of assets produce one system prompt
  - Record declined prompts as `declined` rather than failure
  - _Requirements: 6.6_

- [x] 8.6 Post-purge integrity and audit viewer
  - Verify the timeline stays complete after purge, using retained thumbhashes and derivatives
  - User-inspectable audit log that is never automatically pruned
  - _Requirements: 6.10, 6.11_

---

## Phase 9: Export

- [x] 9.1 Original fetch
  - Explicit user action only, with `tier_state` handling so a non-instant original renders a
    restoring state rather than appearing broken
  - _Requirements: 7.1, 12.1_

- [x] 9.2 Metadata injection
  - Corrected EXIF written into the exported copy; assert the stored original is untouched and still
    hashes to its key
  - _Requirements: 1.8, 7.4_

- [x] 9.3 Bulk export
  - Runs through the job queue, resumable, with transfer size disclosed beforehand from local
    `byte_size` values
  - _Requirements: 7.3_

---

## Phase 10: Hardening

- [x] 10.1 Synthetic library generator
  - Generate libraries at reference scale and 10× for performance work
  - _Requirements: 12 (all)_

- [x] 10.2 Performance benchmarks
  - Grid scroll frame rate, search latency, cold start, measured on a mid-tier physical device at
    both scales, with thresholds enforced in CI where feasible
  - _Requirements: 4.3, 5.3_

- [x] 10.3 Degradation paths
  - Implement and test every row of the design's error handling table, including SQLite corruption
    recovery from the change log and vector backup
  - _Requirements: 4.2, 4.6, 5.7, 6.3_

- [x] 10.4 Cost verification
  - Measure actual monthly spend at reference scale and confirm it is under the Requirement 9.1
    threshold; add a `DataTransfer-Out-Bytes` alarm at the 70 GB CloudFront migration trigger
  - _Requirements: 9.1, 9.4_

- [x] 10.5 Architectural invariant tests
  - These two properties are guarantees rather than features, so they need enforcement or they will
    drift silently as the codebase grows. Add as soon as the relevant paths exist rather than waiting
    for this phase.
  - **No pixel egress to developer infrastructure.** A test that intercepts all outbound requests
    during ingest, browse, search, and export, and asserts that any request carrying image or video
    bytes targets only the object storage endpoint — never the sync Lambda or any other
    developer-operated host. Pair with a static check that the sync client's request builder cannot
    accept binary payloads.
  - **Backend removability.** A test that runs browse, search, upload, and download with the sync and
    entitlement endpoints stubbed to unconditional failure, asserting all four paths still complete.
    This is the executable form of the claim that deleting the backend is subtraction rather than
    restructuring, and it is what keeps the BYO-storage option genuinely open.
  - _Requirements: 11.1, 11.3, 13.5_

---

## Deferred

Not part of v1. Listed so the design is not accidentally closed against them.

- Face detection, embedding, and people clustering
- Sharing between users
- CloudFront plus batch-signing Lambda — triggered at 70 GB/month sustained egress, with the two
  hazards from the design's scaling section as acceptance criteria
- BYO-storage onboarding via CloudFormation and `sts:AssumeRole` with `ExternalId`
- Purchase and entitlement flow via RevenueCat, plus Stripe for the desktop importer
- Web client
