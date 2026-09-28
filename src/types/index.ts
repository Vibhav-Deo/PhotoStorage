export type AssetKind = 'photo' | 'video' | 'live_photo';

export type CapturedAtSource = 'sidecar' | 'exif' | 'file_mtime';

export type StorageTier = 'intelligent_tiering' | 'standard' | 'glacier_instant' | 'glacier_deep_archive';

export type TierState = 'instant' | 'retrieving' | 'archived';

export type VerificationStatus = 'unverified' | 'verifying' | 'verified' | 'failed';

export type EligibilityState = 'unverified' | 'verifying' | 'eligible' | 'purging' | 'purged' | 'ineligible';

export interface LocationInfo {
  lat: number;
  lon: number;
  placeName: string;
}

export interface ExifInfo {
  cameraMake?: string;
  cameraModel?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  iso?: number;
  shutterSpeed?: string;
  orientation?: number;
}

export interface MediaAsset {
  id: string;
  hash: string; // SHA-256 of original bytes
  filename: string;
  kind: AssetKind;
  url: string;
  thumbnailUrl: string;
  thumbhash: string;
  capturedAt: number;
  capturedAtSource: CapturedAtSource;
  width: number;
  height: number;
  byteSize: number;
  mime: string;
  exif: ExifInfo;
  location?: LocationInfo | undefined;
  ocrText?: string | undefined;
  semanticTags: string[];
  isFavorite: boolean;
  storageTier: StorageTier;
  tierState?: TierState | undefined;
  retrievalProgress?: number | undefined; // 0-100 when tierState === 'retrieving'
  verificationStatus: VerificationStatus;
  eligibilityState?: EligibilityState | undefined;
  hasThumbnailDerivative?: boolean | undefined;
  hasPreviewDerivative?: boolean | undefined;
  isLocalPurged: boolean;
  pairedVideoUrl?: string | undefined; // Live Photo motion part
  duration?: number | undefined; // Video duration in seconds
  albumIds: string[];
  coarseVector?: number[] | undefined; // int8 quantized 256 dims
  fullVector?: number[] | undefined; // float32 normalized 256 dims
  modelId?: string | undefined; // Model version for embedding
}

export interface Album {
  id: string;
  title: string;
  description?: string | undefined;
  coverAssetId?: string | undefined;
  assetCount: number;
  createdAt: number;
  isSystem?: boolean | undefined;
}

export interface SpaceReclaimAuditRecord {
  id: string;
  assetId: string;
  hash: string;
  remoteKey: string;
  verificationMethod: 'provider_checksum' | 'multipart_composite' | 'hash_readback';
  verifiedAt: number;
  byteSize: number;
  outcome: 'success' | 'failed' | 'declined';
  freedAt: number;
  icloudDisclosed?: boolean | undefined;
}

export interface TakeoutReconciliationReport {
  totalFound: number;
  imported: number;
  deduplicated: number;
  skipped: number;
  failed: number;
  details: {
    filename: string;
    action: 'imported' | 'deduplicated' | 'skipped' | 'failed';
    reason: string;
    hash?: string;
  }[];
  timestamp: number;
}

export interface SearchFilterState {
  query: string;
  kind: 'all' | 'photo' | 'video' | 'live_photo' | 'favorites';
  cameraModel: string;
  dateStart?: string;
  dateEnd?: string;
  hasOcrOnly: boolean;
  albumId?: string;
  minScore?: number;
}

export interface SearchPerformanceTelemetry {
  coarseScanMs: number;
  cosineRerankMs: number;
  ocrFtsMs: number;
  rrfFusionMs: number;
  totalMs: number;
  candidatesEvaluated: number;
  finalRankedCount: number;
}

// Phase 7: Ingest & Backpressure types
export type IngestStage = 'discovered' | 'materializing' | 'derivatives' | 'uploading' | 'verifying' | 'completed' | 'dead_letter';

export interface IngestJob {
  id: string;
  assetId: string;
  filename: string;
  kind: AssetKind;
  byteSize: number;
  stage: IngestStage;
  progress: number; // 0 to 100
  attempts: number;
  maxAttempts: number;
  errorMessage?: string | undefined;
  backoffUntil?: number | undefined;
  enqueuedAt: number;
  completedAt?: number | undefined;
  isICloudFetch?: boolean | undefined;
}

export interface BackpressureState {
  thermalState: 'nominal' | 'fair' | 'serious' | 'critical';
  batteryLevel: number; // 0 - 100
  isCharging: boolean;
  isMeteredNetwork: boolean;
  allowMeteredIngest: boolean;
  isPaused: boolean;
  pauseReason?: string | undefined;
  concurrencyLimit: number;
}

// Phase 9: Export types
export interface ExportJobRequest {
  id: string;
  assetIds: string[];
  injectExif: boolean;
  includeSidecarJson: boolean;
  format: 'zip' | 'direct_download';
  status: 'pending' | 'checking_tiers' | 'retrieving_glacier' | 'injecting_exif' | 'packaging' | 'ready';
  totalBytes: number;
  progress: number;
  restoringAssetsCount: number;
  downloadUrl?: string;
  createdAt: number;
}

// Phase 10: Diagnostics types
export interface BenchmarkReport {
  timestamp: number;
  datasetSize: number;
  searchLatencyMs: number;
  coarseDotProductMs: number;
  cosineRerankMs: number;
  gridScrollFps: number;
  coldStartTimeMs: number;
  memoryUsageMb: number;
}
