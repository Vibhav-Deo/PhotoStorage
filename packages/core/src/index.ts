/**
 * Public surface of the shared core.
 *
 * Task 1.2 added the domain types and key derivation, 1.3 the SQLite schema and migration
 * runner, 1.4 the `ObjectStore` contract and its filesystem implementation, and 1.5 content
 * hashing and dedupe resolution. 1.6 adds the durable job queue. Every export here is
 * consumed by both
 * `@photo-archive/importer` and the app, so nothing platform-specific belongs in this
 * package.
 */

export type { AlbumRecord, AssetRecord } from './records.ts';

export {
  AssetKind,
  CapturedAtSource,
  DerivativeKind,
  HashState,
  IngestStage,
  JobState,
  LocalState,
  NO_DERIVATIVES,
  PURGE_REQUIRED_DERIVATIVES,
  Platform,
  RemoteState,
  TierState,
  VerifyMethod,
  addDerivatives,
  hasDerivatives,
  removeDerivatives,
} from './states.ts';
export type { DerivativeMask } from './states.ts';

export {
  KeyDerivationError,
  MAX_VECTOR_SHARD,
  isContentHash,
  manifestKey,
  origKey,
  previewKey,
  thumbKey,
  vecKey,
  videoKey,
} from './keys.ts';

export type { SqlDriver, SqlRow, SqlValue } from './db/driver.ts';

export { MIGRATIONS, OCR_FTS_DDL, SCHEMA_META_DDL, SCHEMA_VERSION } from './db/schema.ts';
export type { Migration } from './db/schema.ts';

export {
  CONNECTION_PRAGMAS,
  MigrationError,
  SCHEMA_VERSION_KEY,
  UNMIGRATED_VERSION,
  applyConnectionPragmas,
  currentSchemaVersion,
  migrate,
} from './db/migrate.ts';
export type { AppliedMigration, MigrateOptions, MigrationResult } from './db/migrate.ts';

export {
  EXPO_SQLITE_VENDORED_SQLITE_VERSION,
  Fts5UnavailableError,
  assertFts5,
  detectFts5,
} from './db/capability.ts';
export type { Fts5Capability } from './db/capability.ts';

export {
  ChecksumMismatchError,
  DEFAULT_STORAGE_CLASS,
  InvalidObjectKeyError,
  MAX_PART_COUNT,
  MIN_PART_SIZE_BYTES,
  MULTIPART_THRESHOLD_BYTES,
  MultipartError,
  ObjectNotFoundError,
  ObjectStoreError,
  RangeNotSatisfiableError,
  StorageClass,
  assertObjectKey,
  isValidObjectKey,
  partByteRange,
  planMultipart,
  shouldUseMultipart,
  verifyMethodFor,
} from './store/objectStore.ts';
export type {
  ByteRange,
  MultipartHandle,
  MultipartPlan,
  MultipartPlanOptions,
  ObjectBody,
  ObjectHead,
  ObjectStore,
  ObjectStoreCapabilities,
  PutOptions,
  PutResult,
  UploadPartOptions,
  UploadedPart,
} from './store/objectStore.ts';

export {
  InvalidDigestError,
  HashMismatchError,
  assertContentHash,
  hashBytes,
} from './hash/contentHash.ts';
export type { ByteSource, ContentHash, HashOptions } from './hash/contentHash.ts';

export {
  PortableSha256,
  SHA256_HEX_LENGTH,
  Sha256FinalizedError,
  portableSha256,
} from './hash/sha256.ts';
export type { Sha256, Sha256Factory } from './hash/sha256.ts';

export {
  AssetRowMissingError,
  ContentSizeConflictError,
  DedupeLedger,
  InvalidContentHashError,
  Sighting,
  SourceHashDivergenceError,
  bindDeviceSource,
  describeSource,
  deviceSourcesFor,
  markSourceUnreadable,
  resolveDedupe,
  sourceRefId,
} from './ingest/dedupe.ts';
export type {
  AssetSource,
  BindDeviceSourceOptions,
  DedupeDecision,
  DeviceSource,
  SightingResult,
  TakeoutSource,
} from './ingest/dedupe.ts';

export {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  InvalidBackoffError,
  backoffCeilingMs,
  backoffDelayMs,
  nextAttemptAt,
} from './queue/backoff.ts';
export type { BackoffOptions } from './queue/backoff.ts';

export { applyAlbumRecords, applyAssetRecords, collectPendingAssets } from './sync/syncMerge.ts';
export type { ApplyResult, SyncPullResponse, SyncPushResponse } from './sync/syncMerge.ts';

export {
  DEFAULT_JOB_PRIORITY,
  DEFAULT_LEASE_MS,
  InvalidJobSpecError,
  JobLeaseLostError,
  JobQueueInvariantError,
  MAX_JOB_ATTEMPTS,
  claim,
  complete,
  deadLetters,
  enqueue,
  enqueueOnce,
  fail,
  heartbeat,
  jobById,
  jobCounts,
  reapAbandoned,
  systemClock,
} from './queue/jobQueue.ts';
export type {
  ClaimOptions,
  Clock,
  EnqueueOnceOptions,
  EnqueueOnceResult,
  EnqueueOptions,
  FailOptions,
  Job,
  JobCounts,
  JobFailure,
  JobLease,
  JobSpec,
  JobTarget,
} from './queue/jobQueue.ts';

/**
 * Four modules in this package are deliberately absent from this list, because `index.ts` is
 * what Metro bundles for the app and a bare Node built-in in that graph fails the bundle:
 *
 * - `NodeSqliteDriver` (`node:sqlite`) — `@photo-archive/core/node-sqlite`
 * - `LocalFsObjectStore` (`node:fs`) — `@photo-archive/core/local-fs-store`
 * - `nodeSha256` and `hashFile` (`node:crypto`, `node:fs`) — `@photo-archive/core/node-hash`
 * - `runObjectStoreConformance` (imports `vitest`) — `@photo-archive/core/store-conformance`
 *
 * The contracts they implement — `SqlDriver`, `ObjectStore`, `Sha256Factory` — are exported
 * here, which is the point: a caller depends on the seam and the platform picks the
 * implementation. `portableSha256` is the one case where the root export also ships a working
 * implementation, because the device has no incremental digest to delegate to; see
 * `hash/sha256.ts`.
 */

export {
  COARSE_VECTOR_DIM,
  CoarseVectorBuffer,
  DEFAULT_MODEL_ID,
  EmbeddingError,
  RAW_VECTOR_DIM,
  l2Normalize,
  projectAndQuantize,
  projectVector256,
  quantizeInt8,
} from './embed/embedding.ts';
export type { CoarseVectorHeader } from './embed/embedding.ts';

export {
  CLIP_INPUT_SIZE,
  CLIP_MEAN,
  CLIP_STD,
  clipNormalizeOptions,
  toClipPixelValues,
} from './embed/clipPreprocess.ts';

export type { EmbeddingModel, ImageSource } from './embed/model.ts';

export {
  DEFAULT_SCAN_CHUNK_SLOTS,
  CoarseIndex,
  CoarseIndexError,
  InMemoryCoarseStore,
} from './embed/coarseIndex.ts';
export type {
  CoarseHeaderStore,
  CoarseIndexOptions,
  CoarseSlotVector,
  CoarseStore,
} from './embed/coarseIndex.ts';

export { CoarseSlotLedger, CoarseSlotLedgerError } from './embed/slotLedger.ts';

export {
  BoundedMinHeap,
  cosineSimilarityFloat32,
  decodeVectorFullBlob,
  dotProductInt8,
  encodeFloat16Blob,
  executeTwoStageVectorSearch,
  rerankCandidates,
  scanCoarseIndex,
} from './embed/retrieval.ts';
export type { CoarseCandidate, ScoredVectorResult } from './embed/retrieval.ts';

export {
  buildFts5MatchExpression,
  indexOcrDocument,
  indexOcrDocuments,
  searchOcrIndex,
  tokenizeOcrText,
} from './search/ocrIndex.ts';
export type { OcrDocument, OcrSearchHit } from './search/ocrIndex.ts';

export {
  DEFAULT_RRF_K,
  filterCandidateHashes,
  reciprocalRankFusion,
} from './search/fusion.ts';
export type { FusedSearchResult, SearchPredicates } from './search/fusion.ts';

export {
  SHARD_SLOT_COUNT,
  backupVectorShards,
  checkAndEnqueueModelMigration,
  restoreVectorShards,
  vectorShardKey,
} from './search/migration.ts';
export type { VectorBackupManifest } from './search/migration.ts';

export {
  BoundedUploadPool,
  checkIngestBackpressure,
  enumerateDeviceAssets,
  materializeOriginal,
  queryIngestLibraryStatus,
  uploadDeviceAsset,
} from './ingest/deviceIngest.ts';
export type {
  AuthStatus,
  DeviceAssetInfo,
  DeviceEnvironmentState,
  EnumerationResult,
  IngestLibraryStatus,
  MaterializeResult,
  UploadTaskResult,
} from './ingest/deviceIngest.ts';

export {
  executePurgeBatch,
  updatePurgeEligibility,
  verifyRemoteAsset,
} from './reclaim/reclamation.ts';
export type { PurgeAuditRecord, VerificationResult } from './reclaim/reclamation.ts';

export {
  executeBulkExport,
  fetchOriginalForExport,
  injectMetadataIntoExport,
  planBulkExport,
} from './export/exportEngine.ts';
export type {
  BulkExportPlan,
  CorrectedMetadata,
  ExportBatchProgress,
  OriginalFetchResult,
} from './export/exportEngine.ts';

export {
  generateSyntheticLibrary,
} from './hardening/syntheticLibrary.ts';
export type {
  SyntheticLibraryOptions,
  SyntheticLibraryStats,
} from './hardening/syntheticLibrary.ts';

export {
  runPerformanceBenchmarks,
} from './hardening/benchmarks.ts';
export type { BenchmarkReport } from './hardening/benchmarks.ts';

export {
  recoverFromCorruption,
} from './hardening/degradation.ts';
export type { RecoveryResult } from './hardening/degradation.ts';

export {
  CLOUDFRONT_EGRESS_ALARM_GB,
  MONTHLY_SPEND_CEILING_USD,
  calculateMonthlySpend,
} from './hardening/costVerification.ts';
export type { CostReport } from './hardening/costVerification.ts';
