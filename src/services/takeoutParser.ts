import type { MediaAsset, TakeoutReconciliationReport } from '../types/index.ts';
import { archiveStore } from './archiveStore.ts';

export interface SimulatedTakeoutFile {
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  sidecarJson?: string;
}

export function generateSampleTakeoutArchive(): SimulatedTakeoutFile[] {
  return [
    {
      name: 'IMG_5192.HEIC',
      type: 'image/heic',
      size: 3204910,
      dataUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=2048&q=80',
      sidecarJson: JSON.stringify({
        title: 'IMG_5192.HEIC',
        description: 'Yosemite Valley view during autumn road trip',
        photoTakenTime: {
          timestamp: '1697302400',
          formatted: 'Oct 14, 2023, 4:53:20 PM UTC',
        },
        geoData: {
          latitude: 37.7456,
          longitude: -119.5936,
          altitude: 1200.0,
        },
      }),
    },
    {
      name: 'IMG_5192.MOV', // Live photo motion pair for IMG_5192.HEIC
      type: 'video/quicktime',
      size: 4892010,
      dataUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
      sidecarJson: JSON.stringify({
        title: 'IMG_5192.MOV',
        photoTakenTime: {
          timestamp: '1697302400',
          formatted: 'Oct 14, 2023, 4:53:20 PM UTC',
        },
      }),
    },
    {
      name: 'IMG_5192-edited.jpg', // Edited variant of IMG_5192
      type: 'image/jpeg',
      size: 2894100,
      dataUrl: 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=2048&q=80',
      sidecarJson: JSON.stringify({
        title: 'IMG_5192-edited.jpg',
        photoTakenTime: {
          timestamp: '1697302400',
          formatted: 'Oct 14, 2023, 4:53:20 PM UTC',
        },
      }),
    },
    {
      name: 'DSC_0042(1).jpg', // Disambiguated duplicate
      type: 'image/jpeg',
      size: 3410520, // Same size and content as asset-001 (already in archive)
      dataUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=2048&q=80',
      sidecarJson: JSON.stringify({
        title: 'DSC_0042(1).jpg',
        photoTakenTime: {
          timestamp: '1723657330',
        },
      }),
    },
    {
      name: 'Corrupted_Scan.tmp', // Unsupported / corrupted item
      type: 'application/octet-stream',
      size: 104,
    },
  ];
}

export async function processTakeoutImport(
  files: SimulatedTakeoutFile[],
  targetAlbumTitle = 'Google Takeout Import',
): Promise<{
  report: TakeoutReconciliationReport;
  newAssets: MediaAsset[];
}> {
  const details: TakeoutReconciliationReport['details'] = [];
  const newAssets: MediaAsset[] = [];
  let importedCount = 0;
  let deduplicatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  // 1. Group files by base name for Live Photo and variant pairing
  const sidecars = new Map<string, any>();
  const mediaFiles: SimulatedTakeoutFile[] = [];

  for (const f of files) {
    if (f.name.endsWith('.json') || f.sidecarJson) {
      const parsed = f.sidecarJson ? JSON.parse(f.sidecarJson) : {};
      sidecars.set(f.name.replace('.json', ''), parsed);
    }
    if (f.type.startsWith('image/') || f.type.startsWith('video/')) {
      mediaFiles.push(f);
    } else if (!f.name.endsWith('.json')) {
      skippedCount++;
      details.push({
        filename: f.name,
        action: 'skipped',
        reason: 'Unsupported file type or non-media artifact',
      });
    }
  }

  // Find or create target album
  const existingAlbums = archiveStore.getAlbums();
  let targetAlbum = existingAlbums.find((a) => a.title === targetAlbumTitle);
  if (!targetAlbum) {
    targetAlbum = archiveStore.createAlbum(targetAlbumTitle, 'Google Takeout bulk archive import');
  }

  // Track live photo motion clips to avoid treating them as orphan videos
  const livePhotoMotionNames = new Set<string>();

  for (const media of mediaFiles) {
    const ext = media.name.split('.').pop()?.toLowerCase();
    const baseName = media.name.slice(0, media.name.lastIndexOf('.'));

    // Check for edited variants (-edited suffix) -> variant of base
    if (baseName.endsWith('-edited')) {
      deduplicatedCount++;
      details.push({
        filename: media.name,
        action: 'deduplicated',
        reason: 'Associated as an edited variant of base asset without duplicate storage',
      });
      continue;
    }

    // Check for Live Photo companion (MOV alongside HEIC/JPG)
    if (ext === 'mov' || ext === 'mp4') {
      const possibleImage = mediaFiles.find(
        (m) =>
          m.name.startsWith(baseName) &&
          (m.name.endsWith('.HEIC') || m.name.endsWith('.heic') || m.name.endsWith('.jpg')),
      );
      if (possibleImage) {
        livePhotoMotionNames.add(media.name);
        details.push({
          filename: media.name,
          action: 'imported',
          reason: `Paired as Live Photo motion companion with ${possibleImage.name}`,
        });
        continue;
      }
    }

    // Lookup sidecar metadata
    const sidecar = sidecars.get(media.name) || sidecars.get(baseName);
    let capturedAt = Date.now();
    let capturedAtSource: MediaAsset['capturedAtSource'] = 'file_mtime';

    if (sidecar?.photoTakenTime?.timestamp) {
      capturedAt = parseInt(sidecar.photoTakenTime.timestamp, 10) * 1000;
      capturedAtSource = 'sidecar';
    }

    // Generate SHA-256 for media
    const mockHashInput = `${media.name}_${media.size}_${capturedAt}`;
    const hash = await hashStringSha256(mockHashInput);

    // Check deduplication
    const existing = archiveStore.getAssetByHash(hash);
    if (existing) {
      deduplicatedCount++;
      archiveStore.addAssetToAlbum(existing.id, targetAlbum.id);
      details.push({
        filename: media.name,
        action: 'deduplicated',
        reason: `Matched existing SHA-256 content address [${hash.slice(0, 8)}...]. Referenced existing object.`,
        hash,
      });
      continue;
    }

    // Create new asset
    const isLivePhoto = mediaFiles.some(
      (m) =>
        m.name.startsWith(baseName) &&
        (m.name.endsWith('.MOV') || m.name.endsWith('.mov') || m.name.endsWith('.mp4')),
    );

    const newAsset: MediaAsset = {
      id: `takeout-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      hash,
      filename: media.name,
      kind: isLivePhoto ? 'live_photo' : media.type.startsWith('video/') ? 'video' : 'photo',
      url: media.dataUrl || 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=2048&q=80',
      thumbnailUrl: media.dataUrl || 'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=400&q=80',
      thumbhash: '7gcKDYS2h3t2d3h3h5l4aIeH',
      capturedAt,
      capturedAtSource,
      width: 4032,
      height: 3024,
      byteSize: media.size,
      mime: media.type,
      exif: {
        cameraMake: 'Apple',
        cameraModel: 'iPhone 14 Pro',
        focalLength: '24mm',
        aperture: 'ƒ/1.78',
        iso: 80,
      },
      location: sidecar?.geoData?.latitude
        ? {
            lat: sidecar.geoData.latitude,
            lon: sidecar.geoData.longitude,
            placeName: 'Yosemite National Park, California',
          }
        : undefined,
      ocrText: '',
      semanticTags: ['yosemite', 'nature', 'landscape', 'valley', 'mountains', 'autumn', 'trees'],
      isFavorite: false,
      storageTier: 'intelligent_tiering',
      verificationStatus: 'verified',
      isLocalPurged: false,
      albumIds: [targetAlbum.id],
    };

    newAssets.push(newAsset);
    importedCount++;
    details.push({
      filename: media.name,
      action: 'imported',
      reason: `Successfully imported with ${capturedAtSource} timestamp & content hash`,
      hash,
    });
  }

  // Add into archiveStore
  if (newAssets.length > 0) {
    archiveStore.addAssets(newAssets);
  }

  const report: TakeoutReconciliationReport = {
    totalFound: files.length,
    imported: importedCount,
    deduplicated: deduplicatedCount,
    skipped: skippedCount,
    failed: failedCount,
    details,
    timestamp: Date.now(),
  };

  return { report, newAssets };
}

async function hashStringSha256(str: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
