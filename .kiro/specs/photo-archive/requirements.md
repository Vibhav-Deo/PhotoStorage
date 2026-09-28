# Requirements

## Introduction

A cross-platform (iOS + Android) photo and video archive app that migrates a user's library out of
Google Photos and iCloud into object storage the user controls, reclaims local device storage, and
provides natural-language search over image content — with all inference running on-device and no
server ever seeing pixel data.

The library is content-addressed and the bucket is self-describing, so the archive remains readable
and portable without the app.

### Scope of v1

In scope: Google Takeout import, device library ingest, browse, semantic + OCR + metadata search,
verified space reclamation, original export, multi-device sync.

Out of scope for v1: face recognition and people clustering, sharing between users, editing,
album collaboration, web client.

### Reference scale

Primary target is 20 GB / ~6,000 items. Architecture must not require redesign at 2 TB / ~500,000
items, though specific components may be swapped (see Requirement 12).

---

## Requirement 1: Google Takeout import

**User story:** As a user leaving Google Photos, I want to import a Takeout export without losing
capture dates, locations, or album structure, so that my archive is not silently degraded.

Google's Library API can no longer read a user's existing library (restricted to app-created content
since 2025-03-31), so Takeout is the only viable bulk path. Takeout archives are lossy in specific,
known ways that this requirement exists to correct.

### Acceptance criteria

1. WHEN a Takeout archive set is supplied THEN the importer SHALL process multi-part archives as a
   single logical export without requiring manual concatenation.
2. WHEN a media file has an accompanying sidecar JSON THEN the importer SHALL treat the sidecar's
   `photoTakenTime` as authoritative for capture time, and SHALL NOT trust file mtime or a
   conflicting EXIF `DateTimeOriginal`.
3. WHEN a media file has no sidecar and no EXIF capture date THEN the importer SHALL fall back to
   file mtime AND SHALL record the provenance of the chosen timestamp.
4. WHEN sidecar filenames are truncated or carry `(n)` disambiguators THEN the importer SHALL
   correctly pair each sidecar to its media file.
5. WHEN a file carries an `-edited` suffix alongside a base file THEN the importer SHALL treat it as
   a variant of the base asset rather than an independent asset.
6. WHEN a HEIC/JPG and MOV pair constitute a Live Photo THEN the importer SHALL link them as a
   single logical asset.
7. WHEN album folders are present THEN the importer SHALL reconstruct album membership and titles.
8. The importer SHALL NOT modify original file bytes under any circumstance; all metadata
   corrections SHALL be recorded in the database and manifest only.
9. WHEN an import is interrupted THEN resuming SHALL skip already-completed work without
   re-uploading or re-hashing.
10. WHEN import completes THEN the importer SHALL emit a reconciliation report listing total items
    found, imported, deduplicated, skipped, and failed, with a reason for every non-imported item.

---

## Requirement 2: Device library ingest

**User story:** As a user, I want photos and videos already on my phone backed up to my own storage
automatically, so that new captures are protected without manual effort.

iCloud Photos has no server-side API of any kind, so on-device enumeration is the only access path.

### Acceptance criteria

1. The app SHALL enumerate the device photo library via PhotoKit on iOS and MediaStore on Android.
2. WHEN an iOS asset's original is not resident on device (Optimize Storage enabled) THEN the app
   SHALL request the original from iCloud with network access permitted before hashing.
3. WHEN the user grants only limited photo library access THEN the app SHALL operate over the
   permitted subset and SHALL clearly communicate that the library is partial.
4. Upload work SHALL survive app termination, device restart, and network loss, resuming from the
   last completed stage.
5. Uploads SHALL use bounded concurrency and multipart upload for objects above 8 MB.
6. WHEN the device is on a metered connection AND the user has not opted into cellular upload THEN
   the app SHALL defer uploads.
7. The app SHALL surface per-item ingest state (pending, uploading, verified, failed) and a
   library-wide progress summary.

---

## Requirement 3: Content addressing and deduplication

**User story:** As a user importing from both Google Photos and iCloud, I want the same photo stored
once, so that I do not pay for or scroll past duplicates.

### Acceptance criteria

1. Every asset SHALL be identified by the SHA-256 of its original bytes.
2. WHEN two ingested files produce the same hash THEN the system SHALL store one object and record
   both source references against it.
3. Object keys SHALL be derived from the content hash, not from filenames or timestamps.
4. All keys SHALL be namespaced under a per-user prefix, present even in the single-user case.
5. WHEN the same asset exists in multiple albums THEN album membership SHALL be recorded as
   references without duplicating stored bytes.

---

## Requirement 4: Browse

**User story:** As a user with tens of thousands of photos, I want scrolling my timeline to feel
instant, including offline, so that the app is usable as my primary photo viewer.

### Acceptance criteria

1. The timeline SHALL render from local metadata only, with no network request required to scroll.
2. WHEN a grid cell's thumbnail is not in the local cache THEN the app SHALL immediately render a
   placeholder derived from a locally stored thumbhash, and SHALL NOT render an empty cell.
3. Timeline scrolling SHALL sustain 60 fps on a mid-tier device at the reference scale.
4. The thumbnail cache SHALL be bounded by a configurable size cap and evict least-recently-used
   entries.
5. Thumbhashes SHALL be retained for every asset regardless of cache eviction.
6. WHEN the app is offline THEN browse, search, and viewing of cached previews SHALL all remain
   functional.

---

## Requirement 5: Content search

**User story:** As a user, I want to find photos by describing what is in them, so that I do not
have to remember when a photo was taken.

### Acceptance criteria

1. The app SHALL support natural-language queries matched against image content via CLIP-style
   image and text embeddings.
2. Image and text embedding SHALL both run on-device; query text SHALL NOT be transmitted to any
   server.
3. Search SHALL return first results within 300 ms at the reference scale, measured from query
   submission on a mid-tier device.
4. The app SHALL extract text visible in images via on-device OCR and make it searchable.
5. The app SHALL support metadata filters on capture date range, location, camera model, and media
   kind, combinable with content queries.
6. WHEN multiple signals match THEN results SHALL be fused into a single ranked list rather than
   presented as separate result sets.
7. Search SHALL function with no network connectivity.
8. Embedding vectors SHALL be backed up to object storage so that a device reset does not require
   re-running inference over the entire library.
9. WHEN the embedding model version changes THEN the system SHALL detect the mismatch and re-embed
   incrementally rather than invalidating search entirely.

---

## Requirement 6: Verified space reclamation

**User story:** As a user low on device storage, I want to delete local originals that are safely
archived, so that I free space without risking data loss.

This is the highest-consequence flow in the product. On iOS, deleting from the photo library also
deletes from iCloud Photos when sync is enabled, and becomes irreversible after the 30-day Recently
Deleted window.

### Acceptance criteria

1. An asset SHALL NOT become eligible for local deletion until the stored object has been
   independently verified.
2. Verification SHALL establish that the bytes held by object storage hash to the same SHA-256 as
   the local original, by one of:
   a. a provider-side checksum validated against a client-supplied SHA-256 at write time and
      subsequently confirmed by reading back the stored checksum, or
   b. retrieving the object and hashing it.
   An HTTP success response to the upload SHALL NOT by itself satisfy verification.
3. WHEN the storage provider does not support client-supplied checksum validation THEN the system
   SHALL fall back to method 2(b) automatically.
4. WHEN verification fails THEN the asset SHALL be marked failed, SHALL NOT become eligible for
   deletion, and the failure SHALL be surfaced to the user.
5. An asset SHALL NOT become eligible for local deletion until its thumbnail and preview
   derivatives are confirmed present in object storage.
6. Local deletion SHALL require explicit user confirmation and SHALL NOT occur automatically.
7. Before confirming, the app SHALL disclose the item count, total bytes to be freed, and that
   deletion also removes the items from iCloud Photos when sync is enabled.
8. The app SHALL persist an audit record for every deletion containing the hash, remote key,
   verification method, verification timestamp, byte size, and outcome.
9. Audit records SHALL be written before deletion is attempted.
10. The audit trail SHALL be user-inspectable in the app and SHALL NOT be automatically pruned.
11. Thumbnails, previews, thumbhashes, and metadata for purged assets SHALL be retained so the
    timeline remains complete after reclamation.

---

## Requirement 7: Original access and export

**User story:** As a user, I want to retrieve or export full-resolution originals, so that archiving
does not mean losing practical access.

### Acceptance criteria

1. Browse and preview paths SHALL NOT fetch original objects. Originals SHALL be fetched only on
   explicit user action.
2. The preview derivative SHALL be sufficient for viewing, zooming, and casual sharing.
3. WHEN a bulk export would transfer a significant volume THEN the app SHALL disclose the estimated
   transfer size before proceeding.
4. Export SHALL write files with corrected metadata applied, without having modified the stored
   original.

---

## Requirement 8: Multi-device sync

**User story:** As a user with a phone and a tablet, I want both to show the same library, so that
the archive is not tied to one device.

### Acceptance criteria

1. Metadata changes SHALL sync via a monotonically versioned change log supporting delta pulls from
   a cursor.
2. A newly added device SHALL reconstruct the full timeline from the change log and vector backup
   without re-ingesting from the photo library.
3. WHEN the same asset is modified on two devices THEN conflicts SHALL resolve deterministically by
   last-writer-wins on a per-field basis, with deletions represented as tombstones.
4. Sync SHALL be incremental and SHALL NOT require transferring the full metadata set on each run.

---

## Requirement 9: Cost model

**User story:** As the operator of my own archive, I want predictable near-zero running costs, so
that self-hosting is actually cheaper than the services I am replacing.

### Acceptance criteria

1. At the reference scale, total monthly infrastructure cost SHALL remain under $1 excluding
   platform developer fees.
2. Originals SHALL be stored in a storage class optimized for infrequent access with
   millisecond retrieval.
3. Derivatives SHALL be stored in a hot storage class; monitoring-fee-bearing archive classes SHALL
   NOT be used for objects below the auto-tiering size threshold.
4. The system SHALL NOT require any always-on compute. All backend components SHALL scale to zero.
5. Server-side media processing SHALL NOT be required; derivative generation and inference SHALL
   occur on the client or importer.
6. The read path SHALL be designed so that routine browsing does not incur per-object backend
   requests.

---

## Requirement 10: Storage portability and data escape

**User story:** As a user, I want confidence that my archive outlives this app, so that I am not
trading one lock-in for another.

### Acceptance criteria

1. All object storage access SHALL go through a single provider-agnostic interface implemented
   against the S3 API.
2. Storage credentials and bucket configuration SHALL be injected configuration, never compiled in.
3. The bucket SHALL contain a human-readable manifest mapping content hash to original filename,
   capture time, location, and album membership.
4. The manifest SHALL be sufficient to reconstruct a meaningful library from the bucket alone,
   without the app or its database.
5. Migrating to a different S3-compatible provider SHALL require no change to object keys and no
   client code change.
6. Derivatives SHALL be treated as a regenerable cache: recoverable from originals, and excluded
   from durability guarantees applied to originals.

---

## Requirement 11: Privacy and licensing

**User story:** As a user, I want my photos never processed by someone else's servers, and as the
developer, I want to be able to sell this, so that neither privacy nor commercial viability is
compromised.

### Acceptance criteria

1. No pixel data SHALL be transmitted to any server operated by the app developer.
2. All ML inference SHALL execute on-device or in the user's own importer process.
3. Backend components SHALL have access only to metadata and opaque encrypted-at-rest objects in
   the user's own bucket.
4. All bundled ML model weights SHALL carry licenses permitting commercial use. Research-only
   weights SHALL NOT be shipped.
5. The chosen embedding model SHALL be recorded with a version identifier so that a future model
   change is detectable and migratable.

---

## Requirement 12: Scale readiness

**User story:** As the developer, I want the 2 TB path to be an upgrade rather than a rewrite, so
that early decisions do not become dead ends.

### Acceptance criteria

1. Asset records SHALL carry a storage tier state so the UI can represent originals that are not
   in a hot tier, without assuming instant availability everywhere.
2. The thumbnail cache SHALL be size-bounded from first release, not unbounded with a cap added
   later.
3. Media URL resolution SHALL occur through a batch-oriented interface accepting multiple keys per
   call, so a CDN with signed URLs can be introduced without changing call sites.
4. Object keys SHALL be computed from content hashes at read time and SHALL NOT be persisted as
   absolute URLs anywhere.
5. The vector index SHALL support a quantized coarse representation with exact rerank, so index
   size scales sublinearly with library size.
6. The metadata store SHALL be usable without storing vectors, thumbhashes, or other large blobs,
   keeping per-user metadata well within single-database size limits.
7. Bulk ingest SHALL be possible from a desktop importer and SHALL NOT depend on the mobile device
   as the only ingest path.

---

## Requirement 13: Bring-your-own-storage readiness

**User story:** As the developer, I want the option to ship a version where users supply their own
bucket, so that the commercial path does not require reselling storage or holding user credentials.

### Acceptance criteria

1. The system SHALL NOT assume that the object storage account is owned by the developer.
2. All storage access SHALL be expressible via short-lived credentials scoped to a single user's key
   prefix.
3. Per-user isolation SHALL be enforced by the storage provider's access control, not solely by
   application logic.
4. The system SHALL NOT require storing long-lived user cloud credentials on developer-controlled
   infrastructure.
5. Removing the backend entirely SHALL be a subtraction rather than a restructuring: no component
   in the browse, search, upload, or download path SHALL depend on developer-operated compute.
