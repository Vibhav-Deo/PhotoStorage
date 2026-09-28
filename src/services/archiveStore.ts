import type {
  MediaAsset,
  Album,
  SpaceReclaimAuditRecord,
} from '../types/index.ts';

const TENANT_PREFIX = 'usr_7f8a91';

// Seed assets with diverse, high-quality photography and video samples
const INITIAL_ASSETS: MediaAsset[] = [
  {
    id: 'asset-001',
    hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    filename: 'IMG_4281.HEIC',
    kind: 'live_photo',
    url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=400&q=80',
    thumbhash: '7gcKDYS2h3t2d3h3h5l4aIeH',
    capturedAt: new Date('2024-08-14T17:42:10Z').getTime(),
    capturedAtSource: 'sidecar',
    width: 4032,
    height: 3024,
    byteSize: 3410520,
    mime: 'image/heic',
    exif: {
      cameraMake: 'Apple',
      cameraModel: 'iPhone 15 Pro',
      lens: 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
      focalLength: '24mm',
      aperture: 'ƒ/1.78',
      iso: 64,
      shutterSpeed: '1/2400s',
    },
    location: {
      lat: 21.2755,
      lon: -157.8256,
      placeName: 'Waikiki Beach, Honolulu, HI',
    },
    ocrText: '',
    semanticTags: ['beach', 'ocean', 'waves', 'sunset', 'sand', 'tropical', 'coastline'],
    isFavorite: true,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-takeout-2024', 'album-favorites', 'album-vacation'],
  },
  {
    id: 'asset-002',
    hash: 'a89f3c7104b9015c71d3a4ef56e82c1b99a320d7d91e828456f4d8a17631980a',
    filename: 'DSC08942.ARW',
    kind: 'photo',
    url: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=400&q=80',
    thumbhash: '3OcFDYRFh2mXeYd4eIl2iHl3',
    capturedAt: new Date('2024-07-22T06:15:33Z').getTime(),
    capturedAtSource: 'exif',
    width: 7008,
    height: 4672,
    byteSize: 38942100,
    mime: 'image/x-sony-arw',
    exif: {
      cameraMake: 'Sony',
      cameraModel: 'ILCE-7M4 (A7 IV)',
      lens: 'FE 24-70mm F2.8 GM II',
      focalLength: '35mm',
      aperture: 'ƒ/8.0',
      iso: 100,
      shutterSpeed: '1/250s',
    },
    location: {
      lat: 46.5405,
      lon: 8.0121,
      placeName: 'Grindelwald, Bernese Alps, Switzerland',
    },
    ocrText: '',
    semanticTags: ['mountains', 'alps', 'snow', 'glacier', 'hiking', 'nature', 'peaks', 'sunrise'],
    isFavorite: true,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-vacation', 'album-favorites'],
  },
  {
    id: 'asset-003',
    hash: '5d41402abc4b2a76b9719d911017c592b23a9d4589d97bf97e51c89be432f811',
    filename: 'PXL_20240618_142011.mp4',
    kind: 'video',
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    thumbnailUrl: 'https://images.unsplash.com/photo-1518791841217-8f162f1e1131?auto=format&fit=crop&w=400&q=80',
    thumbhash: 'FfcFHYZ3hn6Idoh4eH14mXeH',
    capturedAt: new Date('2024-06-18T14:20:11Z').getTime(),
    capturedAtSource: 'sidecar',
    width: 3840,
    height: 2160,
    byteSize: 148500200,
    mime: 'video/mp4',
    duration: 15,
    exif: {
      cameraMake: 'Google',
      cameraModel: 'Pixel 8 Pro',
      focalLength: '6.9mm',
      aperture: 'ƒ/1.68',
      iso: 125,
      shutterSpeed: '1/60s',
    },
    location: {
      lat: 37.7749,
      lon: -122.4194,
      placeName: 'Mission District, San Francisco, CA',
    },
    ocrText: 'PET CAFE OPEN DAILY 8AM-8PM',
    semanticTags: ['cat', 'kitten', 'pets', 'playful', 'cute', 'indoor', 'coffee shop'],
    isFavorite: false,
    storageTier: 'standard',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-takeout-2024'],
  },
  {
    id: 'asset-004',
    hash: '7b52009b64fd0a2a49e6d8a939753077792b0554dad5145b101f1a4f01b0e7f8',
    filename: 'Receipt_BlueBottle_Coffee.jpg',
    kind: 'photo',
    url: 'https://images.unsplash.com/photo-1554415707-9e44667ff4a6?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1554415707-9e44667ff4a6?auto=format&fit=crop&w=400&q=80',
    thumbhash: '6gcFDYQ2d3Z4eYh3dYd2aIeH',
    capturedAt: new Date('2024-05-10T09:34:02Z').getTime(),
    capturedAtSource: 'sidecar',
    width: 2800,
    height: 3800,
    byteSize: 2100400,
    mime: 'image/jpeg',
    exif: {
      cameraMake: 'Apple',
      cameraModel: 'iPhone 15 Pro',
      focalLength: '24mm',
      aperture: 'ƒ/1.78',
      iso: 200,
    },
    location: {
      lat: 37.7825,
      lon: -122.4089,
      placeName: 'Blue Bottle Coffee, Mint Plaza, San Francisco',
    },
    ocrText: 'BLUE BOTTLE COFFEE MINT PLAZA HAYES VALLEY ESPRESSO $4.50 OAT MILK LATTE $6.25 TOTAL $10.75 TAX $0.92 THANK YOU',
    semanticTags: ['receipt', 'document', 'coffee', 'invoice', 'expense', 'text', 'paper'],
    isFavorite: false,
    storageTier: 'standard',
    verificationStatus: 'verified',
    isLocalPurged: true, // local purged, stored remotely
    albumIds: ['album-documents'],
  },
  {
    id: 'asset-005',
    hash: 'c4ca4238a0b923820dcc509a6f75849b297b830d6efc255d644d6734185d2621',
    filename: 'Tokyo_Night_Shinjuku.jpg',
    kind: 'photo',
    url: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?auto=format&fit=crop&w=400&q=80',
    thumbhash: '4vcFBYRnlnp5eXh3aYt1eIl3',
    capturedAt: new Date('2024-04-03T20:18:49Z').getTime(),
    capturedAtSource: 'exif',
    width: 5464,
    height: 3640,
    byteSize: 18240500,
    mime: 'image/jpeg',
    exif: {
      cameraMake: 'Sony',
      cameraModel: 'ILCE-7M4 (A7 IV)',
      lens: 'FE 35mm F1.4 GM',
      focalLength: '35mm',
      aperture: 'ƒ/1.4',
      iso: 800,
      shutterSpeed: '1/125s',
    },
    location: {
      lat: 35.6938,
      lon: 139.7034,
      placeName: 'Shinjuku, Tokyo, Japan',
    },
    ocrText: '新宿 思い出横丁 ラーメン ビール YAKITORI IZAKAYA',
    semanticTags: ['tokyo', 'japan', 'night', 'neon', 'city', 'street', 'lights', 'rain', 'shinjuku'],
    isFavorite: true,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-vacation', 'album-favorites'],
  },
  {
    id: 'asset-006',
    hash: '9e3669d19b675bd57058fd4664205d2a0982b20760f5b128522e8ec532f5ff50',
    filename: 'Golden_Retriever_Park.HEIC',
    kind: 'live_photo',
    url: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=400&q=80',
    thumbhash: '8fcFBYQXh3h3eIh3d5l4aIeH',
    capturedAt: new Date('2024-03-29T15:10:00Z').getTime(),
    capturedAtSource: 'sidecar',
    width: 4032,
    height: 3024,
    byteSize: 4120300,
    mime: 'image/heic',
    exif: {
      cameraMake: 'Apple',
      cameraModel: 'iPhone 15 Pro',
      focalLength: '77mm',
      aperture: 'ƒ/2.8',
      iso: 50,
      shutterSpeed: '1/1000s',
    },
    location: {
      lat: 37.8024,
      lon: -122.4485,
      placeName: 'Crissy Field, San Francisco, CA',
    },
    ocrText: '',
    semanticTags: ['dog', 'golden retriever', 'puppy', 'pet', 'grass', 'park', 'sunlight', 'happy'],
    isFavorite: true,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-favorites', 'album-takeout-2024'],
  },
  {
    id: 'asset-007',
    hash: '2e6598fc208c2a30d9bfd68c92a95c96b79759d5861b58bf23b7ffc644400788',
    filename: 'Sourdough_Artisan_Loaf.jpg',
    kind: 'photo',
    url: 'https://images.unsplash.com/photo-1589367920969-ab8e050bbb04?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1589367920969-ab8e050bbb04?auto=format&fit=crop&w=400&q=80',
    thumbhash: '6fcRDYRFd3p3eYh3aYt2aIl3',
    capturedAt: new Date('2024-02-14T11:20:19Z').getTime(),
    capturedAtSource: 'exif',
    width: 4000,
    height: 3000,
    byteSize: 8400100,
    mime: 'image/jpeg',
    exif: {
      cameraMake: 'Fujifilm',
      cameraModel: 'X-T5',
      lens: 'XF 33mm F1.4 R LM WR',
      focalLength: '33mm',
      aperture: 'ƒ/2.0',
      iso: 160,
      shutterSpeed: '1/180s',
    },
    location: {
      lat: 37.7699,
      lon: -122.4469,
      placeName: 'Tartine Bakery, San Francisco, CA',
    },
    ocrText: 'TARTINE BAKERY FRESH COUNTRY LOAF',
    semanticTags: ['bread', 'baking', 'sourdough', 'food', 'crust', 'kitchen', 'artisan', 'bakery'],
    isFavorite: false,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: [],
  },
  {
    id: 'asset-008',
    hash: 'a3847a9f8b4d21e812546e382d6b38c2901a5f829c78201bfa829038290cfa11',
    filename: 'Modern_Architecture_Facade.jpg',
    kind: 'photo',
    url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=2048&q=80',
    thumbnailUrl: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=400&q=80',
    thumbhash: '2fcFBYRHh3l4eYh4d5l4aIeH',
    capturedAt: new Date('2024-01-20T13:45:00Z').getTime(),
    capturedAtSource: 'file_mtime',
    width: 6000,
    height: 4000,
    byteSize: 15900800,
    mime: 'image/jpeg',
    exif: {
      cameraMake: 'Leica',
      cameraModel: 'Leica Q2',
      lens: 'Summilux 28mm f/1.7 ASPH',
      focalLength: '28mm',
      aperture: 'ƒ/5.6',
      iso: 100,
      shutterSpeed: '1/500s',
    },
    location: {
      lat: 52.5065,
      lon: 13.3768,
      placeName: 'Potsdamer Platz, Berlin, Germany',
    },
    ocrText: 'BAUHAUS ARCHITEKTUR BERLIN',
    semanticTags: ['architecture', 'building', 'minimal', 'modern', 'lines', 'geometric', 'glass', 'concrete'],
    isFavorite: false,
    storageTier: 'intelligent_tiering',
    verificationStatus: 'verified',
    isLocalPurged: false,
    albumIds: ['album-takeout-2024'],
  },
];

const INITIAL_ALBUMS: Album[] = [
  {
    id: 'album-takeout-2024',
    title: 'Google Takeout Import 2024',
    description: 'Bulk migration archive from Google Photos with sidecar metadata and Live Photo linking.',
    coverAssetId: 'asset-001',
    assetCount: 4,
    createdAt: new Date('2024-08-20T10:00:00Z').getTime(),
    isSystem: true,
  },
  {
    id: 'album-vacation',
    title: 'Summer Journeys',
    description: 'Travels across Switzerland Alps, Tokyo Shinjuku, and Hawaii shores.',
    coverAssetId: 'asset-002',
    assetCount: 3,
    createdAt: new Date('2024-08-01T12:00:00Z').getTime(),
  },
  {
    id: 'album-favorites',
    title: 'Favorites',
    description: 'Starred memories and top picks.',
    coverAssetId: 'asset-006',
    assetCount: 4,
    createdAt: new Date('2024-01-01T00:00:00Z').getTime(),
    isSystem: true,
  },
  {
    id: 'album-documents',
    title: 'Documents & Receipts',
    description: 'Searchable OCR scans, invoices, and expense receipts.',
    coverAssetId: 'asset-004',
    assetCount: 1,
    createdAt: new Date('2024-05-10T10:00:00Z').getTime(),
  },
];

const INITIAL_AUDITS: SpaceReclaimAuditRecord[] = [
  {
    id: 'audit-001',
    assetId: 'asset-004',
    hash: '7b52009b64fd0a2a49e6d8a939753077792b0554dad5145b101f1a4f01b0e7f8',
    remoteKey: `${TENANT_PREFIX}/orig/7b/52/7b52009b64fd0a2a49e6d8a939753077792b0554dad5145b101f1a4f01b0e7f8`,
    verificationMethod: 'provider_checksum',
    verifiedAt: new Date('2024-05-15T14:22:00Z').getTime(),
    byteSize: 2100400,
    outcome: 'success',
    freedAt: new Date('2024-05-15T14:22:30Z').getTime(),
  },
];

const STORAGE_KEYS = {
  ASSETS: 'photo_archive_assets_v1',
  ALBUMS: 'photo_archive_albums_v1',
  AUDITS: 'photo_archive_audits_v1',
};

class ArchiveStore {
  private assets: MediaAsset[] = [];
  private albums: Album[] = [];
  private audits: SpaceReclaimAuditRecord[] = [];
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const storedAssets = localStorage.getItem(STORAGE_KEYS.ASSETS);
      this.assets = storedAssets ? JSON.parse(storedAssets) : INITIAL_ASSETS;

      const storedAlbums = localStorage.getItem(STORAGE_KEYS.ALBUMS);
      this.albums = storedAlbums ? JSON.parse(storedAlbums) : INITIAL_ALBUMS;

      const storedAudits = localStorage.getItem(STORAGE_KEYS.AUDITS);
      this.audits = storedAudits ? JSON.parse(storedAudits) : INITIAL_AUDITS;
    } catch {
      this.assets = INITIAL_ASSETS;
      this.albums = INITIAL_ALBUMS;
      this.audits = INITIAL_AUDITS;
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEYS.ASSETS, JSON.stringify(this.assets));
      localStorage.setItem(STORAGE_KEYS.ALBUMS, JSON.stringify(this.albums));
      localStorage.setItem(STORAGE_KEYS.AUDITS, JSON.stringify(this.audits));
    } catch (e) {
      console.error('Failed to save to localStorage', e);
    }
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  getAssets(): MediaAsset[] {
    return [...this.assets].sort((a, b) => b.capturedAt - a.capturedAt);
  }

  getAssetById(id: string): MediaAsset | undefined {
    return this.assets.find((a) => a.id === id);
  }

  getAssetByHash(hash: string): MediaAsset | undefined {
    return this.assets.find((a) => a.hash === hash);
  }

  getAlbums(): Album[] {
    return [...this.albums].map((album) => {
      const count = this.assets.filter((a) => a.albumIds.includes(album.id)).length;
      return { ...album, assetCount: count };
    });
  }

  getAlbumById(id: string): Album | undefined {
    const album = this.albums.find((a) => a.id === id);
    if (!album) return undefined;
    const count = this.assets.filter((a) => a.albumIds.includes(album.id)).length;
    return { ...album, assetCount: count };
  }

  createAlbum(title: string, description?: string): Album {
    const newAlbum: Album = {
      id: `album-${Date.now()}`,
      title,
      description,
      assetCount: 0,
      createdAt: Date.now(),
    };
    this.albums.push(newAlbum);
    this.save();
    return newAlbum;
  }

  addAssetToAlbum(assetId: string, albumId: string): void {
    const asset = this.assets.find((a) => a.id === assetId);
    if (asset && !asset.albumIds.includes(albumId)) {
      asset.albumIds.push(albumId);
      this.save();
    }
  }

  removeAssetFromAlbum(assetId: string, albumId: string): void {
    const asset = this.assets.find((a) => a.id === assetId);
    if (asset) {
      asset.albumIds = asset.albumIds.filter((id) => id !== albumId);
      this.save();
    }
  }

  toggleFavorite(assetId: string): void {
    const asset = this.assets.find((a) => a.id === assetId);
    if (asset) {
      asset.isFavorite = !asset.isFavorite;
      if (asset.isFavorite) {
        if (!asset.albumIds.includes('album-favorites')) {
          asset.albumIds.push('album-favorites');
        }
      } else {
        asset.albumIds = asset.albumIds.filter((id) => id !== 'album-favorites');
      }
      this.save();
    }
  }

  async calculateSha256(file: Blob): Promise<string> {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  deriveObjectKeys(hash: string): { orig: string; thumb: string; preview: string } {
    const p1 = hash.slice(0, 2);
    const p2 = hash.slice(2, 4);
    return {
      orig: `${TENANT_PREFIX}/orig/${p1}/${p2}/${hash}`,
      thumb: `${TENANT_PREFIX}/th/${p1}/${p2}/${hash}.webp`,
      preview: `${TENANT_PREFIX}/pv/${p1}/${p2}/${hash}.webp`,
    };
  }

  addAssets(newAssets: MediaAsset[]): { added: number; deduplicated: number } {
    let added = 0;
    let deduplicated = 0;

    for (const item of newAssets) {
      const existing = this.assets.find((a) => a.hash === item.hash);
      if (existing) {
        // Content-addressed deduplication: link any new album IDs without storing twice
        for (const albId of item.albumIds) {
          if (!existing.albumIds.includes(albId)) {
            existing.albumIds.push(albId);
          }
        }
        deduplicated++;
      } else {
        this.assets.push(item);
        added++;
      }
    }

    this.save();
    return { added, deduplicated };
  }

  reclaimSpace(assetIds: string[]): { freedBytes: number; purgedCount: number } {
    let freedBytes = 0;
    let purgedCount = 0;
    const now = Date.now();

    for (const id of assetIds) {
      const asset = this.assets.find((a) => a.id === id);
      if (asset && !asset.isLocalPurged && asset.verificationStatus === 'verified') {
        const keys = this.deriveObjectKeys(asset.hash);
        // Persist audit record before purging (Requirement 6.8 & 6.9)
        const audit: SpaceReclaimAuditRecord = {
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          assetId: asset.id,
          hash: asset.hash,
          remoteKey: keys.orig,
          verificationMethod: 'provider_checksum',
          verifiedAt: now - 1000,
          byteSize: asset.byteSize,
          outcome: 'success',
          freedAt: now,
        };
        this.audits.unshift(audit);

        asset.isLocalPurged = true;
        freedBytes += asset.byteSize;
        purgedCount++;
      }
    }

    this.save();
    return { freedBytes, purgedCount };
  }

  getAuditRecords(): SpaceReclaimAuditRecord[] {
    return [...this.audits];
  }

  getStorageStats(): {
    totalBytes: number;
    localBytes: number;
    reclaimedBytes: number;
    totalAssets: number;
    verifiedAssets: number;
    purgedAssets: number;
  } {
    let totalBytes = 0;
    let localBytes = 0;
    let reclaimedBytes = 0;
    let verifiedCount = 0;
    let purgedCount = 0;

    for (const a of this.assets) {
      totalBytes += a.byteSize;
      if (a.isLocalPurged) {
        reclaimedBytes += a.byteSize;
        purgedCount++;
      } else {
        localBytes += a.byteSize;
      }
      if (a.verificationStatus === 'verified') {
        verifiedCount++;
      }
    }

    return {
      totalBytes,
      localBytes,
      reclaimedBytes,
      totalAssets: this.assets.length,
      verifiedAssets: verifiedCount,
      purgedAssets: purgedCount,
    };
  }

  resetToDefault(): void {
    this.assets = INITIAL_ASSETS;
    this.albums = INITIAL_ALBUMS;
    this.audits = INITIAL_AUDITS;
    this.save();
  }
}

export const archiveStore = new ArchiveStore();
