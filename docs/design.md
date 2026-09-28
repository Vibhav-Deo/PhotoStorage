# Design

## Overview

The system is **local-first with a credential-vending backend**. The device holds the authoritative
copy of all browse and search state in SQLite; object storage holds the durable bytes; the backend
exists only to issue scoped credentials and to relay a metadata change log between devices.

Three properties drive nearly every decision below:

1. **No developer-operated compute in the data path.** Cognito Identity Pools vend short-lived AWS
   credentials scoped by IAM to a single user's S3 key prefix, so the client reads and writes S3
   directly. This is what makes Requirement 9 (cost) and Requirement 13 (BYO-storage) achievable at
   the same time — the backend can be deleted without restructuring anything.
2. **Content addressing.** Keys are `sha256` of original bytes (Requirement 3.1, 3.3), so
   deduplication is free, integrity is verifiable, and no URL is ever persisted. This is what makes
   Requirement 10 (portability) and Requirement 12.4 (CDN retrofit) cheap. It matters most for this
   product because the same photo usually exists in *both* Google Photos and iCloud, so a large
   fraction of a two-source import collapses on ingest (Requirement 3.2).
3. **Derivatives are a regenerable cache.** 99% of reads hit derivatives, which are ~8-10% of total
   bytes and live in a hot tier. Originals are never read during browse, which is what permits them
   to sit in an infrequent-access tier.

### Technology selections

| Concern | Selection | Rationale |
|---|---|---|
| Client | React Native + Expo (prebuild) | Requirement: iOS + Android. Config plugins needed for full photo library access and background upload. |
| On-device inference | `react-native-executorch` | Cross-platform ExecuTorch runtime; ships CLIP ViT-B/32 with a text encoder path. |
| Embedding model | OpenAI CLIP ViT-B/32 (MIT) | Commercial use permitted (Req 11.4); artifact inventory, pinned revisions, digests, and verbatim license text in `licenses/`. Apple MobileCLIP weights are research-only by license and are explicitly excluded. |
| Local store | SQLite via `expo-sqlite` | Timeline, metadata, job queue, FTS5 for OCR. |
| Grid | `@shopify/flash-list` | Fixed-cell recycling required for 60 fps at scale (Req 4.3). |
| Image loading | `expo-image` | Disk cache with size cap, thumbhash placeholder support. |
| Auth | Cognito User Pool, Essentials tier | Social IdPs (Google/Apple/Facebook) count against the 10,000 MAU allowance, not the 50 MAU federation allowance. |
| Credentials | Cognito Identity Pool | Vends STS credentials scoped by IAM policy variable. The load-bearing choice. |
| Originals | S3 Intelligent-Tiering | Millisecond retrieval, no retrieval fee, no minimum storage duration. |
| Derivatives | S3 Standard | Small and hot; below the 128 KB auto-tiering threshold monitoring would be wasted. |
| Metadata sync | DynamoDB on-demand | Scales to zero; 25 GB perpetually free; LSI gives ordered delta pulls. |
| Control plane | Lambda function URLs | No API Gateway needed. Sync relay and entitlement only. |
| Payments | StoreKit / Play Billing via RevenueCat | Stripe cannot be used for in-app digital purchases. Stripe is reserved for the desktop importer. |
| Importer | Node CLI | Bulk ingest must not depend on the mobile device (Req 12.7). |

Sign in with Apple is mandatory once Google or Facebook sign-in is offered (App Store Guideline 4.8).

---

## Architecture

```
┌──────────────────────── DEVICE (authoritative for browse/search) ─────────────────────────┐
│                                                                                            │
│  UI            Timeline · Search · Asset detail · Reclaim space · Audit log                │
│                                    │                                                       │
│  Domain        LibraryService   SearchService   IngestService   ReclaimService             │
│                                    │                                                       │
│  Seams         ObjectStore   MediaUrlProvider   EmbeddingModel   MetadataSync              │
│                                    │                                                       │
│  Local         SQLite (assets, jobs, FTS5, audit)  ·  coarse.bin  ·  thumb cache (LRU)     │
└────────────────────────────────────┼───────────────────────────────────────────────────────┘
                                     │
              ┌──────────────────────┼───────────────────────┐
              │ STS creds            │ direct S3 (SigV4)     │ change log
              ▼                      ▼                       ▼
    ┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐
    │ Cognito          │   │ S3                 │   │ Lambda URL       │
    │  User Pool       │   │  {sub}/orig/  IT   │   │  sync relay      │
    │  Identity Pool   │   │  {sub}/th/    Std  │   │  entitlement     │
    │                  │   │  {sub}/pv/    Std  │   │        │         │
    │  IAM policy      │   │  {sub}/vec/   Std  │   │        ▼         │
    │  scopes to       │   │  {sub}/manifest/   │   │   DynamoDB       │
    │  {sub}/*         │   └────────────────────┘   │   change log     │
    └──────────────────┘                            └──────────────────┘

┌──────────────────── DESKTOP IMPORTER (Node CLI, bulk path) ───────────────────┐
│  Takeout reader → metadata repair → hash → derive → embed → upload → verify   │
│  Same ObjectStore + EmbeddingModel contracts. Writes the same change log.      │
└───────────────────────────────────────────────────────────────────────────────┘
```

Note what is absent: no server touches an image, no server signs per-object URLs, and no server is
required for browse, search, upload, or download.

---

## Credential flow

```
1. User signs in            → Cognito User Pool (Google / Apple / Facebook / email)
2. User Pool issues         → ID token (JWT)
3. Client exchanges token   → Identity Pool GetCredentialsForIdentity
4. Identity Pool returns    → STS AccessKeyId + SecretKey + SessionToken (1h)
5. Client signs S3 requests → SigV4, directly against the bucket
```

The authenticated role's policy is the security boundary:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::${BUCKET}/${cognito-identity.amazonaws.com:sub}/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::${BUCKET}",
      "Condition": {
        "StringLike": { "s3:prefix": "${cognito-identity.amazonaws.com:sub}/*" }
      }
    }
  ]
}
```

Isolation is enforced by IAM, not by application code (Requirement 13.3). A client bug cannot read
another user's objects because the credential does not permit it. This property is lost the moment a
signing Lambda is introduced, which is why that migration carries an explicit authorization
requirement (see Scaling).

**BYO-storage variant.** The same client code path applies with credentials sourced from
`sts:AssumeRole` against a role in the *user's own* AWS account, established by a CloudFormation
template with an `ExternalId`. `CredentialProvider` is the only component that differs.

---

## Components

### Client

| Component | Responsibility | Notes |
|---|---|---|
| `LibraryService` | Timeline queries, album membership, asset mutations | Reads SQLite only; never network |
| `SearchService` | Query embedding, two-stage vector retrieval, FTS, fusion | Fully offline |
| `IngestService` | Library enumeration, job queue drain, upload orchestration | Bounded concurrency, resumable |
| `DerivativeService` | Thumbnail, preview, poster frame, thumbhash generation | On-device, no server |
| `EmbeddingService` | Image and text embedding, PCA projection, quantization | Wraps `EmbeddingModel` |
| `ReclaimService` | Verification, eligibility, confirmed deletion, audit | Highest-consequence path |
| `SyncService` | Delta pull/push against the change log, conflict resolution | Cursor-based |
| `CredentialProvider` | Token exchange, STS credential caching and refresh | Only component aware of tenancy model |

### Backend

| Component | Responsibility | Notes |
|---|---|---|
| Cognito User Pool | Identity, social federation | Essentials tier |
| Cognito Identity Pool | STS credential vending | The reason for choosing AWS-native auth |
| DynamoDB table | Metadata change log | Single table, on-demand, LSI for delta |
| `sync` Lambda URL | Delta pull/push relay | Verifies JWT; metadata only, never bytes |
| `entitlement` Lambda URL | Purchase state check | RevenueCat webhook receiver |

### Importer

| Component | Responsibility |
|---|---|
| `TakeoutReader` | Multi-archive traversal, sidecar pairing, variant and Live Photo detection |
| `MetadataRepair` | Timestamp provenance resolution, album reconstruction |
| `IngestPipeline` | Shares the same stage contracts as the client ingest |

---

## Key seams

Four interfaces isolate every decision identified as likely to change.

```ts
/** Provider-agnostic S3. Swapping providers must not require client changes (Req 10.1, 10.5). */
interface ObjectStore {
  put(key: string, body: Blob | ReadableStream, opts?: PutOptions): Promise<{ etag: string }>;
  get(key: string, range?: ByteRange): Promise<ReadableStream>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;
  createMultipart(key: string, opts?: PutOptions): Promise<MultipartHandle>;
}

interface PutOptions {
  contentType?: string;
  /** 'INTELLIGENT_TIERING' for originals, 'STANDARD' for derivatives (Req 9.2, 9.3). */
  storageClass?: StorageClass;
}

/**
 * Resolves content keys to fetchable URLs. Batch-shaped from day one so that introducing
 * CloudFront signed URLs is an implementation swap, not a call-site refactor (Req 12.3).
 * v1 impl: S3DirectUrlProvider — local SigV4, zero network calls.
 * Later impl: CloudFrontUrlProvider — batches to a signing Lambda, caches until expiry.
 */
interface MediaUrlProvider {
  urlsFor(keys: string[]): Promise<Map<string, string>>;
}

/** Model identity is explicit so a model change is detectable and migratable (Req 11.5, 5.9). */
interface EmbeddingModel {
  readonly id: string;            // e.g. 'clip-vit-b32/pca256-v1'
  readonly nativeDim: number;     // 512
  readonly coarseDim: number;     // 256
  embedImage(src: ImageSource): Promise<Float32Array>;
  embedText(query: string): Promise<Float32Array>;
  /** Fixed projection matrix shipped with the model bundle — must be identical across
      devices or vectors are not comparable. Never fitted per-user. */
  project(v: Float32Array): Int8Array;
}

/** Metadata-only relay. Deliberately narrow so removing the backend is subtraction (Req 13.5). */
interface MetadataSync {
  pull(cursor: number, limit: number): Promise<{ records: AssetRecord[]; cursor: number }>;
  push(records: AssetRecord[]): Promise<{ cursor: number }>;
}
```

`CredentialProvider` is a fifth seam, isolating managed-tenancy from BYO:

```ts
interface CredentialProvider {
  /** Cached; refreshed before expiry. */
  credentials(): Promise<AwsCredentials>;
  /** Key prefix this credential is scoped to. */
  prefix(): Promise<string>;
}
```

### Why `project()` uses a fixed matrix

PCA reduction from 512 to 256 dimensions must use the same projection on every device and in the
importer, otherwise coarse vectors computed on a phone and vectors computed during desktop import
occupy different spaces and cannot be compared. The matrix is therefore fitted offline against a
public corpus, versioned as part of `EmbeddingModel.id`, and shipped as a static asset. Fitting PCA
per-user is explicitly rejected.

---

## Data model

### S3 key layout

All keys are namespaced under the Cognito identity `sub` (Requirement 3.4), which is also the IAM
policy boundary. The prefix is present even in the single-user case so that multi-tenant and
BYO-storage deployments need no key restructuring.

| Key pattern | Storage class | Content |
|---|---|---|
| `{sub}/orig/{hash}` | INTELLIGENT_TIERING | Original bytes, never modified |
| `{sub}/th/{hash}.webp` | STANDARD | Grid thumbnail, 256 px long edge, q75, ~20 KB |
| `{sub}/pv/{hash}.webp` | STANDARD | Preview, 2048 px long edge, q82, ~300 KB |
| `{sub}/vid/{hash}/720p.mp4` | STANDARD | Faststart MP4 for playback |
| `{sub}/vec/{modelId}/{shard}.bin` | STANDARD | Packed coarse vectors, backup for device reset |
| `{sub}/manifest/{yyyy-mm}.ndjson` | STANDARD | Human-readable asset manifest |

Every derivative key is a pure function of `hash`, so the client computes keys and never persists a
URL (Requirement 12.4). Originals get Intelligent-Tiering because it reaches the same ~$0.004/GB
floor as Glacier Instant Retrieval with no retrieval fee and no minimum storage duration — the
minimum duration specifically matters during first import, when re-runs and dedupe corrections are
most likely. Derivatives stay in Standard because objects under 128 KB are never auto-tiered anyway,
so monitoring charges would buy nothing.

### Manifest

One NDJSON line per asset, partitioned by capture month. This is the data-escape guarantee
(Requirement 10.3, 10.4) — sufficient to reconstruct a meaningful library with `rclone` and a JSON
parser, no app required.

```json
{"hash":"a3f1…","file":"IMG_1234.HEIC","kind":"image","bytes":3841204,
 "capturedAt":"2019-07-04T18:22:31-07:00","capturedAtSource":"takeout_json",
 "lat":37.7749,"lon":-122.4194,"camera":"Apple iPhone 11 Pro",
 "albums":["Summer 2019"],"livePairHash":"b7c2…"}
```

### Device SQLite schema

```sql
-- One row per unique piece of content. Content-addressed, so this is the dedupe boundary.
CREATE TABLE assets (
  hash              TEXT PRIMARY KEY,          -- sha256 hex of original bytes
  kind              INTEGER NOT NULL,          -- 0=image 1=video 2=motion_component
  byte_size         INTEGER NOT NULL,
  mime              TEXT NOT NULL,
  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,                   -- video only
  captured_at       INTEGER NOT NULL,          -- epoch ms, authoritative
  captured_at_src   INTEGER NOT NULL,          -- 0=exif 1=takeout_json 2=file_mtime 3=user
  tz_offset_min     INTEGER,
  lat               REAL,
  lon               REAL,
  camera_make       TEXT,
  camera_model      TEXT,
  orientation       INTEGER,
  thumbhash         BLOB NOT NULL,             -- ~25 bytes, never evicted (Req 4.5)
  live_pair_hash    TEXT,                      -- companion asset for Live Photos
  variant_of_hash   TEXT,                      -- set for '-edited' Takeout variants (Req 1.5)
  favorite          INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                   -- tombstone; never hard-deleted (Req 8.3)
  remote_state      INTEGER NOT NULL,          -- 0=local_only 1=uploading 2=verified 3=failed
  local_state       INTEGER NOT NULL,          -- 0=absent 1=present 2=purge_eligible 3=purged
  tier_state        INTEGER NOT NULL DEFAULT 0,-- 0=instant 1=cold 2=restoring (Req 12.1)
  derivative_mask   INTEGER NOT NULL DEFAULT 0,-- bitfield of derivatives confirmed present
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0 -- server-assigned sync version
);

-- Timeline is the hottest query. Partial index excludes tombstones from the scan.
CREATE INDEX idx_assets_timeline ON assets(captured_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_version  ON assets(version);
CREATE INDEX idx_assets_pending  ON assets(remote_state) WHERE remote_state <> 2;
CREATE INDEX idx_assets_purgable ON assets(local_state)  WHERE local_state = 2;

-- Platform photo library identifiers. Separate table because one hash may map to several
-- local ids (camera roll duplicates), and local ids are device-scoped and never sync.
CREATE TABLE local_assets (
  local_id     TEXT PRIMARY KEY,               -- PHAsset.localIdentifier | MediaStore _ID
  hash         TEXT REFERENCES assets(hash),   -- NULL until hashed
  platform     INTEGER NOT NULL,               -- 0=ios 1=android
  hash_state   INTEGER NOT NULL,               -- 0=pending 1=done 2=unreadable
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);
CREATE INDEX idx_local_unhashed ON local_assets(hash_state) WHERE hash_state = 0;

-- Slot mapping into the packed coarse vector buffer. The vectors themselves are NOT stored
-- as rows — see coarse.bin below.
CREATE TABLE vector_slots (
  slot      INTEGER PRIMARY KEY,               -- byte offset = slot * coarse_dim
  hash      TEXT NOT NULL UNIQUE REFERENCES assets(hash),
  model_id  TEXT NOT NULL
);
CREATE INDEX idx_vector_slots_model ON vector_slots(model_id);

-- Full-precision vectors, used only to rerank the coarse candidate set. Point lookups only,
-- never scanned. Nullable and evictable; the coarse buffer is what search depends on.
CREATE TABLE vector_full (
  hash      TEXT PRIMARY KEY REFERENCES assets(hash),
  model_id  TEXT NOT NULL,
  vec       BLOB NOT NULL                      -- fp16, nativeDim
);

CREATE VIRTUAL TABLE ocr_fts USING fts5(hash UNINDEXED, text, tokenize='unicode61 remove_diacritics 2');

CREATE TABLE albums (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  deleted_at INTEGER,
  version    INTEGER NOT NULL DEFAULT 0
);
-- Membership is by reference, so an asset in many albums is still stored once (Req 3.5).
CREATE TABLE album_members (
  album_id TEXT NOT NULL REFERENCES albums(id),
  hash     TEXT NOT NULL REFERENCES assets(hash),
  position INTEGER,
  PRIMARY KEY (album_id, hash)
);

-- Durable work queue. Every pipeline stage is a job so ingest is resumable across process
-- death, reboot, and network loss (Req 2.4, 1.9).
CREATE TABLE jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            INTEGER NOT NULL,            -- see IngestStage
  hash            TEXT,
  local_id        TEXT,
  priority        INTEGER NOT NULL DEFAULT 100,-- lower runs first
  state           INTEGER NOT NULL DEFAULT 0,  -- 0=pending 1=running 2=done 3=failed 4=dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_jobs_runnable ON jobs(priority, next_attempt_at) WHERE state IN (0, 3);

-- Bounded thumbnail cache accounting. Managed explicitly rather than delegated to the image
-- library, because a hard size cap and LRU eviction are required from first release (Req 12.2).
CREATE TABLE thumb_cache (
  key           TEXT PRIMARY KEY,              -- object key
  bytes         INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL
);
CREATE INDEX idx_thumb_cache_lru ON thumb_cache(last_accessed);

-- Deletion audit trail. User-inspectable, never auto-pruned (Req 6.8, 6.10).
CREATE TABLE purge_audit (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  hash               TEXT NOT NULL,
  local_id           TEXT NOT NULL,
  remote_key         TEXT NOT NULL,
  remote_etag        TEXT,
  byte_size          INTEGER NOT NULL,
  verify_method      INTEGER NOT NULL,         -- 0=full_redownload_sha256
  verified_at        INTEGER NOT NULL,
  purge_requested_at INTEGER,
  purge_confirmed_at INTEGER,
  outcome            INTEGER                   -- 0=purged 1=declined 2=failed
);

CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);
```

### `coarse.bin` — packed vector buffer

Coarse vectors are stored in a flat file rather than SQLite rows, because search scans *all* of them
on every query and per-row overhead dominates at scale.

```
Layout:  int8[slot][coarseDim]     byte offset = slot * coarseDim
Header:  separate sidecar JSON — { modelId, coarseDim, slotCount, freeSlots[] }
```

| Library size | coarse.bin | vector_full |
|---|---|---|
| 6,000 items | 1.5 MB | 6 MB |
| 500,000 items | 128 MB | 512 MB |

At reference scale the whole buffer is read into a typed array at startup. At 500k it is read
incrementally in chunks; the scan is streaming and does not require full residency. `vector_full` is
never scanned, only point-queried for the rerank candidate set, so its size does not affect query
latency.

Deleted assets leave a hole; slots are recorded in `freeSlots` and reused rather than compacting.

### DynamoDB change log

Single table, on-demand capacity, one logical partition per user.

| | Attribute | Notes |
|---|---|---|
| PK | `U#{sub}` | One partition per user |
| SK | `A#{hash}` | Asset record; also `ALB#{id}`, `META#counter` |
| LSI1 SK | `version` (Number) | Ordered delta pulls |

Delta pull is a single query:

```
PK = U#{sub} AND version > :cursor,  ScanIndexForward = true,  Limit = 500   [on LSI1]
```

Version numbers are assigned by the `sync` Lambda via an atomic `ADD` on the `META#counter` item,
which serializes writes per user. That is acceptable for a personal library and guarantees a total
order for delta pulls.

Design constraints to respect:

- **An LSI cannot be added after table creation.** It must exist in the initial CDK definition.
- LSI partitions are capped at 10 GB. At 500k assets × ~400 bytes the projection is ~200 MB.
- Nothing large goes in DynamoDB: no vectors, no thumbhashes, no OCR text (Requirement 12.6).
  Those live on the device and in the bucket. DynamoDB carries only the fields needed to
  reconstruct a timeline row.
- Tombstones are retained indefinitely rather than hard-deleted, so a device that has been offline
  for a long time still learns about deletions.

---

## Ingest pipeline

Every stage is a durable job row. Nothing is held only in memory, so process death, reboot, or
network loss resumes from the last completed stage (Requirements 1.9, 2.4).

```ts
enum IngestStage {
  Scan = 0,              // enumerate library / walk Takeout archives
  Hash = 1,              // stream original bytes → sha256  (materializes iCloud originals)
  ExtractMeta = 2,       // EXIF + sidecar → normalized metadata with provenance
  Derive = 3,            // thumbhash, 256px thumb, 2048px preview, video poster
  Embed = 4,             // CLIP image vector → project → coarse slot + full vector
  Ocr = 5,               // on-device text recognition → FTS index
  UploadOriginal = 6,    // INTELLIGENT_TIERING, with sha256 checksum header
  UploadDerivatives = 7, // STANDARD
  Verify = 8,            // confirm stored bytes match the content hash
  Transcode = 9,         // video only: 720p faststart MP4 (importer preferred)
  ManifestAppend = 10,   // append NDJSON line
  SyncPush = 11,         // publish record to change log
}
```

### Ordering and rationale

```
Scan → Hash → ExtractMeta → Derive → { Embed, Ocr } → UploadOriginal
                                 ↓                         ↓
                          UploadDerivatives ─────────→ Verify → ManifestAppend → SyncPush
```

`Derive`, `Embed`, and `Ocr` all run **before** upload, while the decoded bitmap is already in hand.
This is what removes server-side media processing entirely (Requirement 9.5) — the bytes are only
ever decoded once, on the machine that already has them.

`Hash` is the expensive stage on iOS: if Optimize Storage is enabled the original is not resident and
must be pulled from iCloud first (`isNetworkAccessAllowed = true`). That download is unavoidable —
there is no way to obtain the original bytes otherwise — and it is why bulk migration belongs on the
desktop importer.

### Concurrency and scheduling

| Stage | Concurrency | Constraint |
|---|---|---|
| Hash | 2 | I/O bound, iCloud materialization is the bottleneck |
| Derive | `min(4, cores-1)` | CPU bound, thermal sensitive |
| Embed | 1 | Serialized; the ExecuTorch runtime holds one model instance |
| Upload* | 4–6 | Network bound; multipart above 8 MB |
| Verify | 4 | Metadata calls only in the common path |

Backpressure rules: pause on thermal throttle notification, pause when battery is below 20% and not
charging, defer all upload stages on metered connections unless the user opted in (Requirement 2.6).

Retries use exponential backoff with jitter via `next_attempt_at`. After 5 attempts a job moves to
`dead` and surfaces in a per-item error view rather than retrying forever.

---

## Takeout metadata repair

Takeout is lossy in specific documented ways. These rules exist because getting them wrong silently
corrupts an archive, and because this module is the most differentiated part of the product.

### Sidecar pairing

Google emits sidecars as `<media>.json` or `<media>.supplemental-metadata.json`, truncates the total
filename to roughly 51 characters, and places `(n)` disambiguators inconsistently — `IMG_1234(1).jpg`
pairs with `IMG_1234.jpg(1).json`.

Resolution order, first match wins:

1. Exact: `{name}.{ext}.json`, then `{name}.{ext}.supplemental-metadata.json`
2. Truncated: longest sidecar whose stem is a prefix of the media filename
3. Disambiguator swap: extract `(n)` from the media stem, probe `{name}.{ext}({n}).json`
4. Unique basename match within the same directory

Unpaired media is imported with EXIF-or-mtime provenance and reported, never dropped
(Requirement 1.10).

### Timestamp provenance

Precedence is `sidecar.photoTakenTime` → EXIF `DateTimeOriginal` → file mtime, recorded in
`captured_at_src`. Takeout frequently strips or rewrites EXIF dates, so the sidecar wins even when
EXIF disagrees (Requirement 1.2). Provenance is stored rather than discarded so a future correction
pass can distinguish a trusted timestamp from a guess.

### Variants, pairs, and folders

| Pattern | Handling |
|---|---|
| `-edited` and localized equivalents (`-bearbeitet`, `-modifié`, `-editado`) | Separate asset with `variant_of_hash` pointing at the base |
| `IMG_1234.HEIC` + `IMG_1234.MOV`, same stem | Linked via `live_pair_hash`; the MOV is `kind = motion_component` and hidden from the timeline |
| `Photos from YYYY/` | Not an album. Chronological bucket only |
| Any other named folder with `metadata.json` | Album; title from the JSON, membership from folder contents |
| `Archive/`, `Trash/` | Imported but flagged; Trash is opt-in |

Originals are never rewritten. All corrections live in the database and the manifest
(Requirement 1.8), so the stored bytes always hash to their key.

---

## Search

Two-stage retrieval: a cheap exhaustive scan over quantized vectors, then exact rerank over a small
candidate set. This keeps index size sublinear in library size (Requirement 12.5) without an ANN
structure whose memory footprint is impractical on mobile.

```
query text
   │
   ├─ embedText → Float32Array(512) → L2 normalize
   │      └─ project() → Int8Array(256)                        [same fixed PCA matrix]
   │             └─ scan coarse.bin, int32 dot product
   │                    └─ top 500 via bounded min-heap        Stage 1: coarse
   │                           └─ load vector_full for 500
   │                                  └─ exact cosine, re-sort Stage 2: rerank
   │
   ├─ ocr_fts MATCH ────────────────────────────────► ranked list
   │
   └─ assets predicate (date, geo, camera, kind) ───► filter set
                             │
                             ▼
              reciprocal rank fusion (k = 60) → final ranking
```

Quantization is symmetric int8 over L2-normalized vectors with a per-model scale constant, so a dot
product in an int32 accumulator approximates cosine similarity. Because vectors are normalized before
projection, no per-vector scale needs storing.

Metadata predicates are applied as a **filter on the candidate set**, not as a pre-filter on the
scan, so a narrow date range does not change scan cost but does change how many candidates survive.
When a filter is highly selective the coarse candidate count is raised so the reranked set is not
starved.

Fusion uses reciprocal rank fusion rather than weighted score addition because CLIP cosine scores and
FTS5 BM25 scores are not on comparable scales and RRF needs no per-signal calibration.

### Model versioning

`vector_slots.model_id` and `vector_full.model_id` carry the model identity. On startup, a mismatch
between the bundled `EmbeddingModel.id` and the stored `model_id` enqueues incremental `Embed` jobs
for affected assets rather than invalidating search (Requirement 5.9). Stale-model vectors remain
searchable until replaced, so search degrades gradually instead of going dark.

Vectors are backed up to `{sub}/vec/{modelId}/{shard}.bin` so a device reset restores search without
re-running inference over the whole library (Requirement 5.8) — the single most expensive thing to
recompute.

---

## Verified space reclamation

The highest-consequence flow in the product. On iOS, deleting from the photo library also removes the
asset from iCloud Photos when sync is enabled, and becomes irreversible once the 30-day Recently
Deleted window closes.

### Verification

Verification asks one question: do the bytes now in object storage hash to the content hash we
recorded? Three methods, in preference order:

| Method | Applies to | Mechanism | Egress |
|---|---|---|---|
| `s3_checksum_sha256` | Single-part uploads | Send `x-amz-checksum-sha256` on `PutObject`; S3 recomputes server-side and **rejects** on mismatch. Confirm via `HeadObject` with `ChecksumMode=ENABLED`. | none |
| `s3_composite_sha256` | Multipart uploads | Per-part SHA-256 validated by S3 on each part. Compute the composite (`base64(sha256(concat(part digests)))-N`) locally with fixed part sizes and compare to `HeadObject`. | none |
| `full_redownload_sha256` | Fallback | Stream the object back and hash it. Used when the provider lacks additional checksum support, and available as an explicit paranoid mode. | full object |

The checksum methods are stronger than re-downloading, not weaker: S3 refuses to persist bytes that
do not match the supplied SHA-256, so corruption is caught before storage rather than detected after.

`ObjectStore` exposes a capability flag for additional-checksum support; S3-compatible providers that
lack it fall back to `full_redownload_sha256` automatically. This keeps Requirement 10.5 (provider
swap without client change) intact.

### State machine

```
  UploadOriginal ok           ┌────────────────────────────────────┐
        │                     │ verification failed or mismatch    │
        ▼                     ▼                                    │
  remote_state = uploading ──► remote_state = failed  ──► surfaced, never eligible
        │
        │ verify ok
        ▼
  remote_state = verified  +  purge_audit row written (verified_at, method, etag, bytes)
        │
        │ AND derivative_mask has thumb | preview
        ▼
  local_state = purge_eligible
        │
        │ user opens Reclaim, sees count + bytes + iCloud consequence, confirms
        ▼
  PhotoKit / MediaStore batched deletion request  ──► system confirmation prompt
        │                                    │
        │ granted                            │ declined
        ▼                                    ▼
  local_state = purged                 outcome = declined
  outcome = purged, purge_confirmed_at
```

Invariants:

1. A successful upload response never advances state past `uploading`. Only verification does
   (Requirement 6.2).
2. Derivatives must be confirmed present before eligibility. Purging a local original without a
   thumbnail and preview would leave a hole in the timeline (Requirement 6.5).
3. Deletion is never automatic. It requires an explicit in-app confirmation *and* the platform's own
   system prompt (Requirement 6.6).
4. The confirmation screen discloses item count, bytes to be freed, and that iCloud copies are
   removed when sync is enabled (Requirement 6.7).
5. `purge_audit` rows are written **before** deletion is attempted (Requirement 6.9), carry the full
   verification record (Requirement 6.8), and are never automatically pruned (Requirement 6.10).
6. Thumbhash, thumbnail, preview, and all metadata survive purge, so the timeline stays complete
   (Requirement 6.11).

Deletion is batched: PhotoKit accepts a batch of local identifiers in one change request and shows a
single system prompt, so reclaiming thousands of assets does not mean thousands of prompts.

---

## Original access and export

Originals are the only objects in an infrequent-access tier, and the only ones whose retrieval costs
meaningful egress. The read path is therefore designed so that nothing routine ever touches them.

### Access tiers by intent

| User intent | Fetches | Typical bytes |
|---|---|---|
| Scroll the timeline | thumbhash (local), then 256 px thumb | ~20 KB |
| Open an asset, pinch-zoom | 2048 px preview | ~300 KB |
| Play a video | 720p faststart MP4, range requests | streamed |
| Share casually | preview | ~300 KB |
| **Export, edit, or print** | **original** | full size |

The 2048 px preview is deliberately generous so that the fourth row covers the overwhelming majority
of real use (Requirement 7.2). Only the last row escalates to an original, and only on explicit user
action (Requirement 7.1). Breaking this discipline — letting the grid or the detail view reach for
originals — invalidates the storage class choice and the entire cost model.

### Export

Export applies corrected metadata at write time rather than mutating anything stored
(Requirement 7.4). The stored original always hashes to its key, so:

```
GET {sub}/orig/{hash}  →  verify sha256 matches key  →  write file
                                                      └─ inject corrected EXIF from `assets`:
                                                         captured_at + tz_offset_min, lat/lon,
                                                         orientation, camera make/model
```

Metadata injection happens on the copy being written out, never on the source object. This is what
lets the Takeout repair work (Requirement 1.8, originals never modified) coexist with usable exports:
the correction lives in the database, and materializes only into files leaving the system.

Export of a Live Photo writes both components and preserves the pairing convention so the target
platform can recombine them.

### Bulk export disclosure

Before a multi-asset export the app resolves total bytes from `assets.byte_size` — no network calls
needed, since sizes are already local — and discloses the transfer volume (Requirement 7.3). This
matters because egress is the one cost in this design that can be run up quickly by accident: the
free allowance is generous relative to a 20 GB library, but a full-library export at 2 TB is a real
bill.

Bulk export runs through the same job queue as ingest, so it is resumable and rate-limited rather
than a single long transaction.

---

## Scaling

Reference scale is 20 GB / ~6,000 items. The 2 TB / ~500,000 item path must be an upgrade, not a
rewrite (Requirement 12).

### Built now, because retrofitting is expensive

| Decision | Cost now | Cost if deferred |
|---|---|---|
| `tier_state` on assets and a non-instant original state in the UI | One column, one UI state | Archive tiers become unusable; all savings forfeited |
| Size-capped LRU thumbnail cache with thumbhash fallback | `thumb_cache` table, eviction pass | 500k thumbnails is ~10 GB on device, defeating the product's purpose |
| Batch-shaped `MediaUrlProvider.urlsFor(keys[])` | Array parameter | Refactor every call site plus an N+1 network problem |
| Computed keys, never persisted URLs | Already implied by content addressing | Data migration across every user's device |
| Tenant prefix in every key | A constant in the single-user case | Restructure the entire bucket |

### Swapped later, with explicit triggers

| Component | v1 | Trigger | Replacement |
|---|---|---|---|
| Vector search | Exhaustive int8 scan | >150k assets, or query p95 >300 ms | Already two-stage; raise coarse candidate count, chunk the scan, consider IVF partitioning by date |
| Read path | Direct S3 with STS credentials | `DataTransfer-Out-Bytes` >70 GB/month sustained | CloudFront + batch signing Lambda |
| Video transcode | Desktop importer (ffmpeg) | Ongoing captures only | On-device transcode for new video; bulk stays on desktop |
| Metadata store | Single DynamoDB table | Per-user projection nearing 10 GB LSI cap | Nothing large is stored there by design; shard per user if ever needed |
| Bulk ingest | Desktop importer | Always the primary path above ~100 GB | Unchanged; mobile is never the only route (Req 12.7) |

### The CloudFront migration, specified now so it stays cheap

When the egress trigger fires, the change is one `MediaUrlProvider` implementation plus
infrastructure. Two hazards to encode as acceptance criteria at that time:

1. **Authorization moves from IAM to application code.** Today the STS credential physically cannot
   name another user's key. Once a Lambda mints signed URLs, that Lambda becomes the only thing
   preventing an IDOR. Every requested key must be validated against the caller's prefix, with a test
   asserting cross-prefix denial.
2. **`Expires`, `Signature`, and `Key-Pair-Id` must be excluded from the CloudFront cache key.**
   Leaving them in makes every request a cache miss, producing a CDN that adds cost and latency while
   delivering nothing.

Signed cookies were considered and rejected: they authorize a path prefix with one credential and
avoid per-object signing, but `expo-image` delegates to native platform image loaders and attaching
cookies reliably across both platforms is not tractable.

---

## Error handling and degradation

The design goal is that no single failure blocks browsing, and no failure ever risks data.

| Failure | Behavior |
|---|---|
| No network | Browse, search, and cached previews fully functional (Req 4.6, 5.7). Ingest and sync jobs stay `pending` |
| STS credentials expired | Transparent refresh; on refresh failure the app enters read-only-local mode rather than erroring |
| Thumbnail fetch fails | Thumbhash placeholder persists. Cell never blank (Req 4.2) |
| Preview fetch fails | Offer original fetch with an explicit size disclosure |
| Embedding fails for an asset | Asset remains browsable and metadata-searchable; `Embed` job retries |
| OCR fails | Asset remains searchable by content vector and metadata |
| Original cannot be decoded | `local_assets.hash_state = unreadable`; surfaced in ingest status, never silently skipped. Reached on Android below API 28 for HEIC (see spike 0.2) and for any corrupt file |
| Upload fails | Backoff and retry to 5 attempts, then `dead` and surfaced per-item. Never silently dropped |
| Verification fails | `remote_state = failed`. **Never** becomes purge-eligible. Surfaced prominently |
| Sync conflict | Per-field last-writer-wins by `updated_at`; deletions win as tombstones (Req 8.3) |
| Corrupt local SQLite | Rebuild from the change log plus the vector backup; originals in the bucket are the durable copy |
| Takeout item unpairable | Imported with degraded provenance and listed in the reconciliation report. Never dropped (Req 1.10) |

Data-safety failures are treated categorically differently from convenience failures: anything
touching verification or deletion fails closed, and everything else fails soft.

---

## Testing strategy

| Layer | What is tested | How |
|---|---|---|
| Takeout repair | Sidecar pairing, truncation, `(n)` disambiguators, `-edited` variants, Live Photo pairing, album reconstruction, timestamp precedence | Fixture corpus of real Takeout directory shapes, checked in. The highest-value test suite in the project |
| Content addressing | Identical bytes from different sources converge on one asset; keys are stable | Unit, with byte-identical fixtures from distinct paths |
| Verification | Each of the three methods; mismatch detection; composite checksum computation matches S3's | Unit against recorded S3 responses, plus an integration test against a real bucket |
| Reclamation | Eligibility gating on every invariant; audit row written before deletion; declined prompt recorded | Unit on the state machine with an exhaustive invalid-transition matrix |
| Job queue | Resumption after simulated process death mid-stage; retry backoff; dead-lettering | Unit with an injected clock |
| Search | Recall of two-stage retrieval vs exhaustive exact search; quantization error bounds; RRF ordering | Golden-set evaluation over a labeled image corpus |
| Sync | Delta cursor correctness, tombstone propagation, per-field conflict resolution | Unit plus a two-simulated-device integration test |
| Performance | Grid scroll frame rate, search latency, cold start, at reference scale and at 10× | Instrumented runs on a mid-tier physical device against a synthetic library |
| IAM isolation | Cross-prefix access denial | Integration test asserting `AccessDenied` for another `sub`'s key |

The reclamation state machine and the Takeout repair rules get the most rigorous treatment. One is
where irreversible data loss lives, the other is the product's actual differentiator.

---

## Open questions to resolve before implementation

These are unverified assumptions, not settled decisions. Each is a phase-0 spike.

1. **CLIP text encoder availability in `react-native-executorch`.** *Partially resolved by spike 0.1
   — see "Spike 0.1 outcome" below. Risk to Requirements 5.2 and 5.7 is now assessed as low, and no
   requirement change is warranted. One item still needs a device.*
2. **FTS5 availability in `expo-sqlite`.** *Largely resolved by spike 0.2 — see "Spike 0.2 outcome"
   below. FTS5 is compiled in by default on both platforms and the token-table fallback is now
   implemented and measured to rank identically. Risk to Requirement 5.4 is low. One item needs a
   device, and one genuine defect was found in `unicode61`'s handling of CJK.*
3. **Android motion photos.** Android embeds motion data inside the JPEG rather than pairing separate
   files as iOS does. The `live_pair_hash` model assumes pairs and may need a third representation.
4. **HEIC decode for derivative generation in React Native.** *Resolved by spike 0.2. Decode and WebP
   output both exist on iOS and Android through ordinary Expo modules, and a subsampled-decode path
   is available and is what task 7.3 should use. The residual items are a `minSdkVersion` 24 gap and
   on-device cost measurement.*
5. **iOS background upload limits.** Whether `URLSession` background transfer through Expo sustains
   long bulk uploads, or whether bulk must be desktop-only in practice. Affects Requirement 2.4.
6. **Commercial licensing of the exact bundled weights.** *Resolved by task 0.3 — see "Task 0.3
   outcome" below. The compliance record lives in `licenses/`, not in `spikes/`. Every shipped
   artifact traces to MIT-licensed weights with a named copyright holder, revisions are pinned to
   commit shas, and no research-licensed weights are reachable from the dependency graph.
   Requirement 11.4 is satisfied. Two follow-ons: MIT's notice obligation needs a notices surface
   that does not exist yet (task 1.1), and task 2.9 must pin the ONNX artifact by commit sha rather
   than fetching from `main`.*
7. **Android EXIF redaction versus content addressing.** *Raised by spike 0.2, not previously
   considered.* On Android 10 and later, bytes read through MediaStore have location EXIF stripped
   unless the app holds `ACCESS_MEDIA_LOCATION` and calls `MediaStore.setRequireOriginal`. Redacted
   bytes hash differently, so the `Hash` stage could compute a digest that is not the original's,
   upload the altered copy, verify *that* successfully, and then delete the true original — with
   every check passing. This touches Requirements 3.1, 3.2, and 6 rather than 5.4, and needs a
   decision before task 7.2.

Question 1 is the only one of the original six that could force a requirement change. It should be
spiked first. Question 7 is now the most consequential open item, because unlike the others its
failure mode is silent and irreversible.

---

### Spike 0.1 outcome

Code and full detail: `spikes/README.md`. Findings are split by how they were established, because
the distinction changes how much weight each carries.

**Verified by executing code.** The two CLIP towers do share an embedding space. Running MIT-licensed
OpenAI CLIP ViT-B/32 through `onnxruntime-node` against five generated fixtures gives 100% top-1
retrieval in both directions against a 20% chance baseline, with matched cosine 0.3461 versus
mismatched 0.2490. This used the uint8-quantized export, so it is a lower bound on fp32. The
model-level premise the whole search design rests on is therefore a measured fact rather than an
assumption.

This also corrects how the spike task was framed. "High cosine similarity" is the wrong acceptance
criterion: CLIP optimizes a temperature-scaled softmax over a similarity matrix, not the magnitude of
any single cosine, and the measured range above is what a *working* model looks like. Retrieval
ranking is the diagnostic property, and it is also what Requirements 5.1 and 5.3 depend on. The
harness in `spikes/clip-probe-core` grades on ranking and reports cosines only for inspection.

**Verified by reading published source** (`react-native-executorch@0.9.3` from npm, not the docs):

- `'clip-vit-base-patch32-text'` is a first-class member of `TextEmbeddingsModelName`, with a
  matching `CLIP_VIT_BASE_PATCH32_TEXT` preset carrying both a model and a tokenizer source. The
  library's API reference describes it as mapping text into the 512-dimensional joint space for use
  with the image encoder — the product's exact search path.
- Both towers resolve to a **single XNNPACK fp32 artifact**, the cross-platform CPU backend. One
  artifact serves iOS and Android, so there is no platform-specific code path to diverge. Core ML and
  Vulkan text variants exist upstream but are unreferenced in 0.9.3.
- Weights are MIT (`xnnpack/config.json` and the model card agree), which is evidence toward
  Requirement 11.4 and toward task 0.3, though 0.3 still wants the license text recorded in-repo.
- **Neither tower is L2-normalized natively.** `BaseEmbeddings::postprocess` returns the raw output
  tensor, with no pooling and no normalization, for both image and text. The design's `embedText` →
  L2 normalize → `project()` sequence is consistent with this, but the normalize step is load-bearing
  rather than defensive and should not be optimized away.
- **Image preprocessing does not match CLIP's.** `ImageEmbeddings` feeds a plain divide-by-255 with no
  channel normalization, and resizes by bilinear stretch to 224×224 with no aspect-preserving center
  crop. The reference run measured the cost of the missing normalization: separation drops from 0.0971
  to 0.0764, about 21% of the margin, with ranking still intact.

  The consequence for **task 2.9** is larger than that number suggests. The degradation is tolerable;
  the *divergence* is not. The importer computes vectors under `onnxruntime-node` and the app under
  ExecuTorch, and this design requires the two be directly comparable. Whichever convention the
  runtime actually uses, the importer must reproduce it exactly, stretch-resize included. Task 2.9's
  parity assertion should compare embeddings of a fixture rendered by `clip-probe-core`, not merely
  check that both sides emit 512 numbers.

**Still requires a device.** A contradiction that source cannot settle: the model repo's
`xnnpack/config.json` declares the text method as taking one `[1, 77]` int64 input, while
`TextEmbeddings::generate` passes two int64 tensors, `(input_ids, attention_mask)`, sized to the
tokenizer's actual output length with no padding to 77 and no CLIP-specific branch. If the `.pte`
really takes one `[1, 77]` tensor, `forward` fails on input count or shape; if it was exported for
`(ids, mask)` with a dynamic sequence dimension, it works. The spike app prints the model's declared
input shapes on first run, which answers this immediately. A related smaller flaw in the same generic
runner: it derives its attention mask as `token != 0`, but 0 is `!` in the CLIP vocabulary rather than
a pad token, so a caption containing `!` has that position masked.

**Fallback recommendation, if the preset does not run.** ONNX Runtime, via the officially published
`onnxruntime-react-native`. Beyond being cross-platform, it puts the app and the importer on the *same*
inference stack, which removes the entire class of importer-versus-device drift described above. Two
costs: CLIP's BPE tokenizer becomes ours to ship, and the artifact must include the projection head —
`text_model.onnx` alone omits it and would yield a plausible-looking 512-dimensional vector that
silently fails to match images. Exporting the text tower to ExecuTorch ourselves remains the
second fallback, and is the only option that both keeps one on-device runtime and lets us fix the
`[1, 77]` mismatch at its source.

Moving query embedding server-side is explicitly not on this list. It breaks Requirement 5.2 outright,
breaks 5.7 in practice, and puts developer-operated compute in the search path against Requirement
13.5. With two viable on-device paths and the model premise confirmed, it should not be reached for.

**Assessment.** Requirements 5.2 and 5.7 need *an* on-device CLIP text encoder, not specifically this
library's. Two independent paths exist, the model-level premise is measured, and the weights are MIT.
The residual risk is scoped to runtime plumbing, and its worst realistic outcome is swapping the
on-device inference row in the technology-selection table — not a change to what the product
promises.

---

### Spike 0.2 outcome

Code and full detail: `spikes/README.md`. Findings are split by how they were established, as in
spike 0.1, because the distinction changes how much weight each carries.

**Verified by reading published source: FTS5 is compiled into `expo-sqlite` on both platforms.** Read
from the `expo-sqlite@57.0.2` npm tarball rather than the docs. The module vendors its own SQLite
amalgamation (`vendor/sqlite3/sqlite3.c`, version 3.50.3) and compiles it as part of itself rather
than linking the platform's SQLite. `ios/ExpoSQLite.podspec` appends
`-DSQLITE_ENABLE_FTS4=1 -DSQLITE_ENABLE_FTS3_PARENTHESIS=1 -DSQLITE_ENABLE_FTS5=1` unless
`expo.sqlite.enableFTS` is `'false'`; `android/build.gradle` appends the same three flags under the
same condition and passes them to CMake, which applies them to the same source file. FTS5 is
therefore **opt-out**, and the two platforms are configured symmetrically from one place.

Three consequences worth carrying forward:

- **FTS5 availability is a property of the app's build configuration, not of the library.**
  `expo-build-properties` with `expo.sqlite.enableFTS: false`, or `expo.sqlite.useLibSQL: true` —
  which swaps in a prebuilt binary these flags do not control — removes it. That is exactly the kind
  of thing that regresses silently. **Task 1.3's migration runner should assert the capability at
  startup**, using the detector written for this spike, rather than treating it as settled.
- The `wa-sqlite` web build ships no FTS5 symbols. Irrelevant to v1, but the deferred web client
  would need the fallback.
- On iOS, `sqlite_version()` is the tripwire for a symbol collision with Apple's `libsqlite3`. Apple
  also enables FTS5, so such a collision would leave everything working while the podspec's flags
  silently did not apply. Expecting exactly 3.50.3 catches it.

**Verified by executing code: the design's `ocr_fts` schema is sound, and the fallback ranks
identically.** Run against SQLite 3.50.4 through `node:sqlite`, whose build declares `ENABLE_FTS5`
and sits one patch release from the vendored amalgamation:

```
fts5        : recall 100% · top-1 100% · forbidden hits 0
token-table : recall 100% · top-1 100% · forbidden hits 0
fallback vs FTS5: same result set on 9/9 queries, same order on 9/9
```

The declaration is used verbatim, `tokenize='unicode61 remove_diacritics 2'` included. Diacritic
folding works in both directions, prefix queries anchor at token starts so `board*` does not match
`whiteboard`, and `bm25()` returns the negated score the ranking depends on.

The fallback the design named as "a normalized token table with manual ranking" is now implemented:
`ocr_tokens(token, hash, tf) WITHOUT ROWID PRIMARY KEY (token, hash)`, which makes the table itself
the inverted index, plus BM25 with FTS5's exact constants. idf is computed in JS — it needs only the
corpus size and each term's document frequency — while the scan, the accumulation, and the top-k stay
in SQL, because shipping posting lists into JS to sort them there is what would fail at 500,000
assets. Keeping `log()` out of SQL also means the fallback needs no build flags of its own. It stores
no positions, so it has no phrase queries and no `NEAR`; the design uses neither, fusing FTS rank with
vector rank via reciprocal rank fusion instead.

Matching on ordering as well as on membership is what makes the fallback trustworthy. Writing a
fallback is easy; knowing it ranks the same as the thing it replaces is the part usually skipped.

**Verified by executing code, and a genuine defect: `unicode61` cannot retrieve CJK substrings.**
Reading `fts5vocab` after indexing `東京都渋谷区の看板 Shibuya ward sign 12.50 SFO-NRT` gives:

```
12 | 50 | nrt | sfo | shibuya | sign | ward | 東京都渋谷区の看板
```

`unicode61` classifies Han and kana as alphanumeric, so an unbroken CJK run is a **single token**.
Querying `渋谷` returns nothing, and neither does `渋谷*`, because a prefix must match a token start
and this run's only token starts at `東`. OCR of Japanese or Chinese signage therefore indexes but
does not retrieve, and nothing reports a problem — the failure is silent, which is what makes it worth
recording rather than tolerating quietly.

The fallback splits CJK runs per character and retrieves `渋谷` correctly, so **the token table is
strictly better than FTS5 on non-Latin OCR**. That inverts its role: it is not only insurance against
a missing compile flag, it is the better index over part of the input space. The cheapest fix that
keeps a single index is to emit CJK character bigrams into a second FTS5 column at index time, which
is the conventional workaround and needs no custom tokenizer — `expo-sqlite` exposes no API for
registering one. **This should be a decision made with task 6.4**, not a discovery made after
shipping.

**Verified by reading published source: HEIC decodes, and WebP encodes, on both platforms.** On iOS,
`expo-image-manipulator`'s `loadImage(atUrl:)` reads local files with `UIImage(data:)` — ImageIO,
which has decoded HEIC since iOS 11, against a pod floor of iOS 16.4 — and takes a PhotoKit path for
`ph://` URLs with `isNetworkAccessAllowed = true`, so ingest can hand over an asset reference and
never touch a HEIC file. On Android it delegates to `expo-image-loader`, which is Glide 5.0.5
decoding through `BitmapFactory`; Glide's own `RegistryFactory` comments that HEIF is "only supported
on OMR1+". WebP output exists on both: `Bitmap.CompressFormat.WEBP`, and `SDImageWebPCoder` vendored
into `expo-image-manipulator`'s prebuilt xcframeworks.

One gap: Expo SDK 57's `minSdkVersion` defaults to **24**, and API 24–27 have no platform HEIF
decoder. The exposure is narrow, since an Android phone whose own camera writes HEIC is API 28+ by
construction and the app renders WebP derivatives rather than originals, but it is not zero. The
correct handling is `local_assets.hash_state = unreadable`, which the schema already provides for and
which the error-handling table above now records.

**Verified by reading published source: the risk is the decode shape, not HEIC.**
`ImageManipulator.manipulate(uri).resize({ width: 256 })` decodes at full resolution and then scales
down — `SIZE_ORIGINAL` on Android via `CustomTarget`'s no-argument constructor, and no size parameter
at all on iOS. A 12 megapixel original is 48.8 MB as ARGB_8888 and a 48 megapixel one is 195 MB, and
`Derive` runs at `min(4, cores-1)`. Four concurrent full-resolution decodes is plausible
out-of-memory territory on a mid-tier Android device, for output that is 256 px on its long edge.

The mitigation is a supported API, verified in source on both platforms.
`Image.loadAsync(uri, { maxWidth, maxHeight })` constrains the decode itself: iOS sets
`context[.imageThumbnailPixelSize]`, which SDWebImage implements with
`CGImageSourceCreateThumbnailAtIndex` and `kCGImageSourceThumbnailMaxPixelSize` — both symbols
confirmed present in the SDWebImage binary that actually ships — and Android calls
`.submit(maxWidth, maxHeight)`, which Glide turns into `BitmapFactory`'s `inSampleSize`. The result is
an `ImageRef`, and `ImageManipulator.manipulate` accepts `string | SharedRef<'image'>`, so the two
modules hand off with no second decode. **Task 7.3 should use this path**, and should be careful that
`ImageRef.width`/`.height` are *logical* units — pixels are logical times `scale`, and on Android
`scale` is routinely not 1.

Noticed in passing: `expo-image` 57 exposes `Image.generateThumbhashAsync(source)`, which removes a
dependency from tasks 5.1 and 7.3.

**Verified by reading published source, and the most consequential finding here: Android redacts EXIF
from MediaStore bytes.** Glide ships `QMediaStoreUriLoader` because, in its own words, "HEIC images on
Q cannot be decoded if they've gone through Android's exif redaction, due to a bug in the
implementation that corrupts the file", and it states that its workaround "does not fix applications
that target Q, do not opt in to legacy storage and that don't have `ACCESS_MEDIA_LOCATION`".

The decode failure is a Requirement 5.4 problem. The redaction itself is a much larger one: redacted
bytes are different bytes, so they hash differently. This design is content-addressed
(Requirement 3.1) and reclamation deletes a local original only after verifying the stored object
against that hash (Requirement 6). Hashing redacted bytes would mean computing a digest that is not
the original's, uploading the altered copy, verifying *it*, and then deleting the true original — with
every check passing. It would also break dedupe against the same photo imported from Takeout
(Requirement 3.2), which is one of the product's premises.

`ACCESS_MEDIA_LOCATION` is not requested by default: `expo-media-library`'s config plugin gates it
behind `isAccessMediaLocationEnabled`, default false, and the library calls
`MediaStore.setRequireOriginal` only when reading EXIF location, not on the path that yields a URI to
read bytes from. **Tasks 4.1, 7.1, and 7.2 need to enable it, and task 7.2 needs a test that hashes
the same asset with and without the permission and asserts the digests match.** That is the cheapest
possible check for a failure that is otherwise silent and irreversible. It is recorded as open
question 7 rather than resolved here, because it touches requirements this spike was not scoped to
change.

**Still requires a device.** Four things, none of them load-bearing for a requirement:

- That the podspec and gradle flags survive into a built app on each platform, and that nothing on
  iOS links Apple's `libsqlite3` instead of the vendored amalgamation. `sqlite_version()` and
  `PRAGMA compile_options`, both printed by the probe, settle both in one screen.
- What a HEIC decode actually costs, and whether the naive path survives `Derive`'s concurrency.
  Every memory figure above is arithmetic on pixel counts.
- That real camera HEIC works, not just a generated fixture: 10-bit depth, HDR gain maps, and Live
  Photo containers are all absent from a synthesised file. The probe's photo-library source covers
  this and reports a skip rather than a pass when it cannot run.
- Whether EXIF redaction changes the bytes in practice. The probe exercises the path; proving the hash
  consequence belongs to task 7.2.

The app's JavaScript is verified as far as it can be without a native toolchain: `tsc --noEmit` is
clean and `expo export` bundles for both iOS and Android with both fixtures resolved.

**Assessment.** Requirement 5.4 needs OCR text to be searchable, not FTS5 specifically. There are now
two working indexes behind one interface, the primary is on by default on both platforms via an
opt-out flag read from the shipped build configuration, and the fallback has been measured to return
the same documents in the same order — and to be better on CJK. HEIC carries no requirement risk
either. The residual FTS5 risk is that a build configuration change removes the primary, and the
answer to that is a startup assertion in task 1.3, not a design change.

The one item that could force a requirement change is not about either of task 0.2's questions: EXIF
redaction versus content addressing, now open question 7.
---

### Task 0.3 outcome

Compliance record and full detail: `licenses/` — `README.md` for the findings, `model-artifacts.json`
for the machine-readable inventory, `models/openai-clip-mit.txt` for the verbatim license text. It is
deliberately outside `spikes/`, because the spikes are throwaway and this has to outlive them and be
updatable by whoever next bumps a model version.

**What ships, resolved rather than assumed.** The preset URLs are not documented; they are assembled
from template literals in `react-native-executorch@0.9.3`. Reading `src/constants/versions.ts`
(`LIB_VERSION = '0.9.0'`, so `VERSION_TAG = 'resolve/v0.9.0'`) with `src/constants/modelUrls.ts`
resolves five artifacts, all now pinned to commit shas with digests recorded:

| Artifact | Consumer | Source |
|---|---|---|
| `clip_vit_base_patch32_image_xnnpack_fp32.pte` (351.6 MB) | app | `software-mansion/react-native-executorch-clip-vit-base-patch32` @ `68bad8b0` (tag `v0.9.0`) |
| `clip_vit_base_patch32_image_xnnpack_int8.pte` (96.4 MB) | app | same |
| `clip_vit_base_patch32_text_xnnpack_fp32.pte` (254.0 MB) | app | same |
| `tokenizer.json` (2.2 MB) | app | same |
| `onnx/model_quantized.onnx` (153.7 MB) | importer (2.9) and the ONNX fallback | `Xenova/clip-vit-base-patch32` @ `d15189d7` |

The tokenizer is inventoried as an artifact in its own right: it is a 49408-entry byte-level BPE
vocabulary, which is a copyrightable asset rather than a config file, and the preset field is named
`tokenizerSource` so it is easy to overlook.

Also worth recording because it changes the notice analysis: **`react-native-executorch` bundles no
weights.** There is no `.pte` in the npm tarball; the presets are URLs and the runtime downloads them
to the device on first use.

**Verified: MIT, with a named copyright holder.** `models/openai-clip-mit.txt` is the verbatim text
from `openai/CLIP` at commit `d05afc43`, sha256 `987e63b3…`, carrying "Copyright (c) 2021 OpenAI".
The `LICENSE` file has not changed since 2021-01-05, so the text is stable rather than a moving
target. MIT permits commercial use unconditionally; the single obligation is notice retention.

**Verified, and not what was assumed: only one of the three repos declares a license.** The converted
ExecuTorch repo declares MIT twice over (card front matter and `xnnpack/config.json`). But
`openai/clip-vit-base-patch32` declares **nothing** — no `LICENSE` file among its twelve files, no
`license` key in its card metadata, no `license:*` tag, and no occurrence of the word "license" in its
model card. `Xenova/clip-vit-base-patch32` declares nothing either; its metadata is `base_model` and
`library_name` only. So the artifact the app downloads is the only one that says MIT, and the artifact
the *importer* downloads says nothing at all. MIT rests on `openai/CLIP`, which is where the weights
originate and which is unambiguously licensed.

That is a sound basis but it is the whole chain, so two cheap hardening steps are recorded rather than
left implicit. **Task 2.9 must fetch the ONNX artifact by the pinned commit sha and check the digest**
— spike 0.1 fetched from `resolve/main`, and a compliance record over a branch name is not a record.
And if that artifact ever needs to stand on its own, export it from `openai/clip-vit-base-patch32`
with Optimum instead of consuming a third party's conversion, which reduces the chain to one hop.

**Verified by content: the tokenizer's provenance is provable.** A conversion changes every byte, so
the `.pte` files cannot be digest-matched against upstream — that hop is a claim on the model card.
The tokenizer can be, and was: its `vocab`, `merges`, and `added_tokens` are identical, compared field
by field, to `openai/clip-vit-base-patch32`'s `tokenizer.json` at revision `3d74acf9`. That proves
nothing about the weights directly, but it does show the converted repo demonstrably carries content
copied from upstream, which corroborates its account of where the weights came from. Spike 0.1's
measured 512-dimensional joint-space behaviour corroborates it further.

**A notices surface is required and does not exist.** MIT requires the copyright and permission
notices to travel with copies or substantial portions. There is a narrow argument that we never
redistribute the weights, since the device fetches them from Hugging Face itself and we ship only a
URL — but it is not worth relying on, the importer does redistribute the ONNX artifact if it vendors
it, and complying costs one text file. The app needs a reachable notices view carrying
`models/openai-clip-mit.txt` attributed to OpenAI for CLIP ViT-B/32, and the importer needs a
`THIRD_PARTY_NOTICES` file alongside it. It should share the aggregation used for npm dependencies:
`react-native-executorch` and `onnxruntime-node` are both MIT with the same obligation and **neither
ships a `LICENSE` file in its tarball**, so the aggregation has to be generated rather than collected.
This is not in the task list anywhere; **it belongs with task 1.1**, which is where such tooling lives.

**Verified: nothing research-licensed is reachable, and MobileCLIP's exclusion is now evidenced.**
`apple/MobileCLIP-S2` declares `license: apple-amlr` / `license_name: apple-ascl`, pointing at
`apple/ml-mobileclip`'s `LICENSE_MODELS`, which opens by stating the model is released for the sole
purpose of scientific research of AI and ML technology and uses "Research Purposes" and
"non-commercial" throughout; GitHub classifies the repository as `NOASSERTION`. It fails Requirement
11.4 outright. It is also not selectable by accident: `ImageEmbeddingsModelName` has exactly two
members, both `clip-vit-base-patch32`, and `TextEmbeddingsModelName` has seven, none of them
MobileCLIP. A case-insensitive search of the whole dependency tree finds `mobileclip` only inside the
prebuilt ONNX Runtime shared libraries, where the hits are graph-optimizer rule names
(`TryFuseMobileClipMHA`, `MobileClipSplitForMHA`) — compiler code for accelerating someone else's
model, containing no weights.

**One tension recorded rather than buried.** CLIP's license and CLIP's model card do not say the same
thing about deployment. The license is MIT and permits commercial use. The card, separately, states
that any deployed use case — commercial or not — is currently out of scope, names AI researchers as
the intended users, notes the training dataset was not intended as the basis for any commercial or
deployed model, and puts surveillance and facial recognition permanently out of scope regardless of
performance.

These are the authors' use recommendations, not license terms, and they do not narrow the MIT grant.
Requirement 11.4's first clause is about licenses and is satisfied. Its second clause says
research-only weights shall not be shipped, and a reader could fairly ask whether a model whose own
card says "not for deployment" qualifies. The distinction is license versus card guidance: the
requirement's own example, MobileCLIP, is research-only *by license*, which is the reading intended
here, and CLIP is not that.

Two things make it comfortable in practice rather than merely arguable. The sharpest part of the card
is the surveillance and facial-recognition carve-out, and this product does neither — there is no face
detection, recognition, or identity clustering anywhere in this design. And the use is retrieval over
a user's own private library on their own device, which is close to the card's own example of a
constrained non-deployed use and is the opposite of open-ended classification against an arbitrary
taxonomy. If the card's language ever becomes a commercial concern the exit is ordinary: Requirement
11.5 already versions the embedding model precisely so a swap is a migration.

**The record goes stale by design and needs a tripwire.** It is true only for the revisions it names,
and `LIB_VERSION` is what builds the model URLs — so a `react-native-executorch` upgrade silently
repoints every artifact at a new model revision. The check is small enough to automate and probably
should be: for each entry in `model-artifacts.json`, confirm the revision still resolves, the digest
still matches, and the declared license has not changed.

**Assessment.** Requirement 11.4 is satisfied. Every shipped artifact traces to MIT-licensed weights
with a named copyright holder, the license text is in the repo rather than referenced, revisions are
pinned, and no research-licensed weights are reachable. The two residual items are follow-on work, not
open risk: a notices surface (task 1.1) and a pinned, digest-checked ONNX fetch (task 2.9).

---

### Task 6.1 outcome

Code: `packages/core/src/embed/`, `apps/mobile/src/search/`, and the importer re-export at
`packages/importer/src/takeout/embeddings.ts`. Findings, split as before by how they were established.

**Resolved by construction: importer/device projection parity.** The projection, quantization, and
`coarse.bin` slot allocator moved from the importer into `@photo-archive/core`
(`src/embed/embedding.ts`), and the importer now re-exports them. The design's requirement that the
fixed PCA matrix be byte-identical across importer and app is satisfied the only way that can be
guaranteed: there is one implementation, not two copies asserted to agree. The importer's test suite
pins this with symbol-identity assertions — if anyone re-localizes the importer's copy, the build
fails before any vector is written that a device could not compare (Req 11.2, 11.5).

**Verified by reading the installed runtime source (`react-native-executorch@0.10.2`): the app
version resolves two of spike 0.1's open items.** The 0.9.x `ImageEmbeddings`/`TextEmbeddings`
classes are replaced by task APIs (`createImageEmbedder`, `createTextEmbedder`) with per-config
preprocessing. Consequences:

- The `[1, 77]`-versus-`(ids, mask)` contradiction that spike 0.1 could not settle from source is
  resolved *against* the fixed shape: `createTextEmbedder` validates a **dynamic** sequence length
  (`i64(1, L)`), tokenizes to the exact input length with no padding, and derives an all-ones
  attention mask. The new API therefore cannot hit the input-count failure mode, and the
  `token != 0`-as-pad-token flaw is gone with it.
- The image preprocessor's `NormalizeOptions` supports **per-channel** `alpha` and `beta` arrays in
  the `pixel * alpha + beta` form. The registry's CLIP preset still ships the divide-by-255-only
  convention spike 0.1 measured at ~21% margin loss, so the app does not use the registry config:
  `clipImageEmbedderConfig()` constructs it with `alpha[c] = 1/(255·std[c])`,
  `beta[c] = −mean[c]/std[c]`, which is algebraically identical to the importer's
  `toClipPixelValues` reference. That identity is asserted **exhaustively over all 256 pixel values
  × 3 channels** in `packages/core/src/embed/clipPreprocess.test.ts`, at float32 precision, and the
  test also asserts the config does *not* collapse back to the registry default. Both towers stay on
  the cross-platform XNNPACK fp32 artifacts; the importer must continue to reproduce the full CLIP
  convention exactly as it does.
- The preprocessing convention itself (means, stds, input size, CHW layout) also moved into core
  (`src/embed/clipPreprocess.ts`), so the importer and the app share one definition of the input
  convention the same way they share the projection.

**What the app got.** `apps/mobile/src/search/embeddingModel.ts` implements the design's
`EmbeddingModel` seam (the interface lives in core, `src/embed/model.ts`): `embedImage`,
`embedText`, and `project` delegating to the shared implementation. Outputs are L2-normalized in
the wrapper — spike 0.1 verified neither tower normalizes natively, so the step is load-bearing — and
forward passes are serialized through an internal queue, because the runtime holds one model
instance per tower and throws `RESOURCE_BUSY` on concurrent use (the design's "Embed concurrency: 1"
made a property of the model seam rather than only of the ingest scheduler). Everything testable in
Node was kept out of the runtime wrapper: the pinned-URL and normalization configuration lives in
`clipModelConfig.ts` and has its own test file, which also verifies the artifact URLs are pinned at
an exact `resolve/vX.Y.Z` tag, never a branch.

**A new staleness entry for the compliance record.** The repo now pins
`react-native-executorch@0.10.2`, whose `NEXT_VERSION_TAG` is `resolve/v0.10.0` — so every
ExecuTorch artifact the app downloads is now at revision `v0.10.0`, while `licenses/model-artifacts.json`
still records the `v0.9.0` digests. The weights are the same origin (the converted CLIP repo,
MIT per its card and upstream), but the recorded digests are no longer digests of *the bytes the
app fetches*, which is the entire point of the record. The app pins its URLs explicitly at
`resolve/v0.10.0` in `clipModelConfig.ts` rather than via the registry, which at least makes what
will be downloaded a named revision. **Refreshing `model-artifacts.json` against `v0.10.0` —
fetching each artifact, computing digests locally, and re-verifying the declared license — is
required before any build that ships, and should be automated as task 0.3's own tripwire.**

**Still requires a device.** Three items, none of which changes a requirement:

- That the `.pte` artifacts at `resolve/v0.10.0` load and produce 512-dim outputs on real iOS and
  Android hardware, including first-use download of ~600 MB of artifacts.
- That the per-channel `alpha`/`beta` preprocessing path is actually honoured by the native
  preprocessor (the type accepts arrays; the algebra is tested, the native execution is not).
- Latency of the serialized image-embed path, which task 10.2 measures at reference scale on a
  mid-tier device.

---

### Task 6.2 outcome

Code: `packages/core/src/embed/coarseIndex.ts` (the index + seams + in-memory reference store),
`packages/core/src/embed/slotLedger.ts` (the `vector_slots` pairing), and
`apps/mobile/src/search/coarseFileStore.ts` (the expo-file-system store).

**The index is seam-shaped, like `ObjectStore` and `SqlDriver`.** `CoarseStore` (random-access
bytes) and `CoarseHeaderStore` (the sidecar JSON) are narrow interfaces in core's root export;
the device implements them over expo-file-system's `File`/`FileHandle`, everything else runs
against the in-memory reference store in Node tests. Verified against the installed
`expo-file-system@57.0.7` source: positional reads go through a cached `FileHandle`
(`offset` + `readBytes`), growth never goes through the handle — `FileHandle.writeBytes`
extension past EOF is undocumented, so appends use `File.write` with `{ append: true }` and
drop the cached handle — and a write at an offset past EOF zero-pads the gap in the same append.

**Chunked reads are the default, not an option.** `scanSlots()` streams every live slot in slot
order, reading `chunkSlots` (default 16384 ≈ 4 MB) at a time, so a scan never requires full
residency at 500k slots (Req 12.5). A test counts the actual reads through a wrapper store and
asserts the chunk boundaries exactly. Freed slots are skipped during the scan — their bytes are
stale by definition, and a stale hit would only be discarded after the expensive rerank in 6.3.

**Durability ordering, recorded because it is load-bearing:**

- The header sidecar is persisted on *every* `allocate`/`free`, so process death mid-embedding
  loses at most the bytes of one unwritten vector, never the free-list.
- `CoarseSlotLedger.assign` orders a fresh assignment as allocate → write bytes → insert the
  `vector_slots` row, and *frees the slot again* if the insert fails — a partial write can never
  strand a live-looking slot. Assign is idempotent per hash: re-embedding overwrites the vector
  in the existing slot, which is what makes incremental re-embedding (task 6.8) cheap.
- `release` deletes the row *before* freeing the slot — a crash between the two leaves a slot
  that stays allocated rather than one search could resurrect.

The ledger lives in core, not the app, because it is built entirely from core seams (`SqlDriver`
+ `CoarseIndex`) and is therefore Node-testable against `node:sqlite` and the real schema — the
tests seed `assets` rows because `vector_slots.hash` references them, exactly as the embed
pipeline will.

**One open seam with task 6.7.** A buffer restored from the vector backup has bytes but no
header (bootstrap concatenates shards), so `CoarseIndex.open` accepts `adoptHeaderless` to
adopt the bytes as live slots (`slotCount = size / 256`, refusing non-whole buffers). When 6.7
defines the shard format it should either include the header in the backup or accept this
adoption path — recorded so the decision is made once, there.
