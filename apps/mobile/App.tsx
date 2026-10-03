import { useSQLiteContext, SQLiteProvider } from 'expo-sqlite';
import * as MediaLibrary from 'expo-media-library/legacy';
import { Suspense, useEffect, useState, useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { initDatabase, ExpoSqliteDriver } from './src/db/database.ts';
import { AuthError, signIn, signOut, type SignInSession } from './src/auth/authService.ts';
import { DevicePhotoGrid, type DevicePhoto } from './src/browse/DevicePhotoGrid.tsx';
import { CredentialProvider } from './src/credentials/credentialProvider.ts';
import { uploadAssetToS3 } from './src/ingest/s3Uploader.ts';
import { cognitoConfig, PHOTO_ARCHIVE_AWS } from './src/config/aws.ts';

type ActiveTab = 'library' | 'albums' | 'search' | 'storage';

interface AlbumRecord {
  readonly id: string;
  readonly title: string;
  readonly assetCount: number;
}

interface UploadTaskState {
  readonly isUploading: boolean;
  readonly total: number;
  readonly current: number;
  readonly currentFilename: string;
  readonly statusText: string;
  readonly error?: string;
  readonly isComplete: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function AppShell(): React.ReactElement {
  const db = useSQLiteContext();
  const driver = useMemo(() => new ExpoSqliteDriver(db), [db]);

  // Auth State
  const [session, setSession] = useState<SignInSession | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAccountSheetOpen, setIsAccountSheetOpen] = useState(false);

  // Tabs & Navigation
  const [activeTab, setActiveTab] = useState<ActiveTab>('library');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAlbumTitle, setSelectedAlbumTitle] = useState<string | null>(null);

  // Selection Mode (Apple Photos pattern)
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deviceAssets, setDeviceAssets] = useState<DevicePhoto[]>([]);

  // SQLite Backed-Up State
  const [backedUpIds, setBackedUpIds] = useState<Set<string>>(new Set());
  const [userAlbums, setUserAlbums] = useState<AlbumRecord[]>([]);

  // Upload Progress
  const [uploadTask, setUploadTask] = useState<UploadTaskState | null>(null);

  // Space Reclamation
  const [purgedIds, setPurgedIds] = useState<Set<string>>(new Set());
  const [reclaimedBytes, setReclaimedBytes] = useState(0);
  const [showReclaimModal, setShowReclaimModal] = useState(false);

  // New Album Dialog
  const [showNewAlbumModal, setShowNewAlbumModal] = useState(false);
  const [newAlbumTitle, setNewAlbumTitle] = useState('');

  // 1. Restore persistent session on launch
  const loadSavedSession = useCallback(async () => {
    try {
      await driver.run(`CREATE TABLE IF NOT EXISTS app_session (key TEXT PRIMARY KEY, value TEXT)`);
      const row = await driver.get<{ value: string }>('SELECT value FROM app_session WHERE key = ?', [
        'current_session',
      ]);
      if (row?.value) {
        const parsed = JSON.parse(row.value) as SignInSession;
        if (parsed.tokens && parsed.tokens.expiresAt * 1000 > Date.now()) {
          setSession(parsed);
        }
      }
    } catch (err) {
      console.warn('Failed to restore session from SQLite:', err);
    }
  }, [driver]);

  // Save or clear session in SQLite
  const persistSession = useCallback(
    async (sess: SignInSession | null) => {
      try {
        await driver.run(`CREATE TABLE IF NOT EXISTS app_session (key TEXT PRIMARY KEY, value TEXT)`);
        if (sess) {
          await driver.run(
            'INSERT INTO app_session (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ['current_session', JSON.stringify(sess)],
          );
        } else {
          await driver.run('DELETE FROM app_session WHERE key = ?', ['current_session']);
        }
      } catch (err) {
        console.warn('Failed to save session to SQLite:', err);
      }
    },
    [driver],
  );

  // 2. Read backed-up assets and albums from SQLite
  const refreshSqlData = useCallback(async () => {
    try {
      const rows = await driver.all<{ local_id: string }>(
        `SELECT local_id FROM local_assets WHERE hash_state = 1`,
      );
      setBackedUpIds(new Set(rows.map((r) => r.local_id)));

      // Load albums
      const albumRows = await driver.all<{ id: string; title: string; asset_count: number }>(
        `SELECT a.id, a.title, COUNT(m.hash) as asset_count
         FROM albums a
         LEFT JOIN album_members m ON m.album_id = a.id
         WHERE a.deleted_at IS NULL
         GROUP BY a.id
         ORDER BY a.title ASC`,
      );
      setUserAlbums(
        albumRows.map((r) => ({
          id: r.id,
          title: r.title,
          assetCount: r.asset_count,
        })),
      );
    } catch (err) {
      console.warn('Could not read backed-up assets from SQLite:', err);
    }
  }, [driver]);

  useEffect(() => {
    initDatabase(db)
      .then(() => {
        void loadSavedSession();
        void refreshSqlData();
      })
      .catch((err: unknown) => {
        console.error('Database initialization failed:', err);
      });
  }, [db, loadSavedSession, refreshSqlData]);

  // Sign In Flow
  const handleSignIn = async (): Promise<void> => {
    setAuthError(null);
    setIsSigningIn(true);
    try {
      const newSession = await signIn(cognitoConfig, 'Cognito');
      setSession(newSession);
      await persistSession(newSession);
      setIsAccountSheetOpen(false);
    } catch (error: unknown) {
      setAuthError(error instanceof AuthError ? error.message : 'Sign-in failed');
    } finally {
      setIsSigningIn(false);
    }
  };

  // Sign Out Flow (Guaranteed fast session clear)
  const handleSignOut = async (): Promise<void> => {
    try {
      if (session) {
        await Promise.race([
          signOut(cognitoConfig, session.tokens.accessToken),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]).catch(() => undefined);
      }
    } finally {
      setSession(null);
      await persistSession(null);
      setIsAccountSheetOpen(false);
    }
  };

  const toggleSelectAsset = (asset: DevicePhoto) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else {
        next.add(asset.id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(deviceAssets.map((a) => a.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const cancelSelectionMode = () => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
  };

  // Real S3 Upload Pipeline
  const performUpload = async (assetsToUpload: DevicePhoto[]) => {
    if (assetsToUpload.length === 0) return;

    if (!session) {
      setIsAccountSheetOpen(true);
      setAuthError('Sign in with your account to back up photos to private cloud storage.');
      return;
    }

    const credentialProvider = new CredentialProvider(session, {
      cognito: cognitoConfig,
      userPoolId: PHOTO_ARCHIVE_AWS.userPoolId,
      identityPoolId: PHOTO_ARCHIVE_AWS.identityPoolId,
      region: PHOTO_ARCHIVE_AWS.region,
      ...(session.tokens.refreshToken ? { refreshToken: session.tokens.refreshToken } : {}),
    });

    setUploadTask({
      isUploading: true,
      total: assetsToUpload.length,
      current: 0,
      currentFilename: assetsToUpload[0]?.filename ?? 'Photo',
      statusText: 'Preparing upload...',
      isComplete: false,
    });

    try {
      for (let i = 0; i < assetsToUpload.length; i++) {
        const asset = assetsToUpload[i];
        if (!asset) continue;

        setUploadTask((prev) =>
          prev
            ? {
                ...prev,
                current: i + 1,
                currentFilename: asset.filename ?? `Photo ${i + 1}`,
                statusText: `Uploading ${asset.filename ?? 'photo'}...`,
              }
            : null,
        );

        await uploadAssetToS3(asset, credentialProvider, driver, (step) => {
          setUploadTask((prev) =>
            prev
              ? {
                  ...prev,
                  statusText:
                    step.status === 'reading'
                      ? 'Reading file...'
                      : step.status === 'hashing'
                      ? 'Hashing SHA-256...'
                      : step.status === 'uploading'
                      ? 'Transferring to S3...'
                      : 'Securing ledger...',
                }
              : null,
          );
        });

        setBackedUpIds((prev) => new Set([...prev, asset.id]));
      }

      setUploadTask((prev) =>
        prev
          ? {
              ...prev,
              isUploading: false,
              isComplete: true,
              statusText: `Backed up ${assetsToUpload.length} items successfully.`,
            }
          : null,
      );

      await refreshSqlData();
      cancelSelectionMode();
    } catch (err: unknown) {
      console.error('Upload Error:', err);
      setUploadTask((prev) =>
        prev
          ? {
              ...prev,
              isUploading: false,
              isComplete: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : null,
      );
    }
  };

  // Reclaim calculations
  const eligibleForPurge = deviceAssets.filter(
    (a) => backedUpIds.has(a.id) && !purgedIds.has(a.id),
  );
  const eligibleBytes = eligibleForPurge.reduce(
    (acc, a) => acc + (a.width ?? 1920) * (a.height ?? 1080) * 0.4,
    0,
  );

  // Real Space Reclamation (Purges device copy with MediaLibrary and updates SQLite)
  const handlePurgeConfirmed = async () => {
    setShowReclaimModal(false);
    const assetIdsToDelete = eligibleForPurge.map((a) => a.id);

    try {
      await MediaLibrary.deleteAssetsAsync(assetIdsToDelete);
    } catch (nativeErr) {
      console.warn('Native deleteAssetsAsync error or canceled:', nativeErr);
    }

    for (const asset of eligibleForPurge) {
      await driver.run(
        `UPDATE assets SET local_state = 3 WHERE hash IN (
          SELECT hash FROM local_assets WHERE local_id = ?
        )`,
        [asset.id],
      );
    }

    setReclaimedBytes((prev) => prev + eligibleBytes);
    setPurgedIds((prev) => new Set([...prev, ...eligibleForPurge.map((a) => a.id)]));
    await refreshSqlData();
  };

  const handlePurgeSingle = async (asset: DevicePhoto) => {
    try {
      await MediaLibrary.deleteAssetsAsync([asset.id]);
    } catch (nativeErr) {
      console.warn('Single delete canceled or unavailable:', nativeErr);
    }

    await driver.run(
      `UPDATE assets SET local_state = 3 WHERE hash IN (
        SELECT hash FROM local_assets WHERE local_id = ?
      )`,
      [asset.id],
    );

    const assetBytes = (asset.width ?? 1920) * (asset.height ?? 1080) * 0.4;
    setReclaimedBytes((prev) => prev + assetBytes);
    setPurgedIds((prev) => new Set([...prev, asset.id]));
    await refreshSqlData();
  };

  // Create User Album in SQLite
  const handleCreateAlbum = async () => {
    const title = newAlbumTitle.trim();
    if (!title) return;
    const albumId = `album_${Date.now()}`;
    const now = Date.now();

    await driver.run(
      `INSERT INTO albums (id, title, created_at, updated_at, version) VALUES (?, ?, ?, ?, 0)`,
      [albumId, title, now, now],
    );

    setNewAlbumTitle('');
    setShowNewAlbumModal(false);
    await refreshSqlData();
  };

  const unbackedCount = deviceAssets.filter((a) => !backedUpIds.has(a.id)).length;
  const videosCount = deviceAssets.filter((a) => a.mediaType === 'video').length;

  return (
    <View style={styles.appContainer}>
      {/* ── Top Apple/Google Photos Style Header ─────────────────── */}
      <View style={styles.topHeader}>
        {isSelectMode ? (
          // Selection Header
          <View style={styles.selectionHeaderRow}>
            <TouchableOpacity onPress={cancelSelectionMode} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={styles.headerActionText}>Cancel</Text>
            </TouchableOpacity>

            <Text style={styles.selectionTitle}>
              {selectedIds.size === 0 ? 'Select Items' : `${selectedIds.size} Selected`}
            </Text>

            <TouchableOpacity onPress={selectAll} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Text style={styles.headerActionText}>Select All</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Standard Navigation Header
          <View style={styles.standardHeaderRow}>
            <View>
              <Text style={styles.navLargeTitle}>
                {selectedAlbumTitle
                  ? selectedAlbumTitle
                  : activeTab === 'library'
                  ? 'Photos'
                  : activeTab === 'albums'
                  ? 'Albums'
                  : activeTab === 'search'
                  ? 'Search'
                  : 'Storage'}
              </Text>
              {activeTab !== 'search' && (
                <View style={styles.syncStatusRow}>
                  <View
                    style={[
                      styles.syncStatusDot,
                      { backgroundColor: session ? '#34c759' : '#ff9f0a' },
                    ]}
                  />
                  <Text style={styles.syncStatusLabel}>
                    {session
                      ? unbackedCount === 0
                        ? 'Backup complete'
                        : `${unbackedCount} items to back up`
                      : 'Offline • Tap avatar to sign in'}
                  </Text>
                </View>
              )}
            </View>

            {/* Right Action Icons */}
            <View style={styles.headerRightActions}>
              {selectedAlbumTitle ? (
                <TouchableOpacity
                  style={styles.selectTextBtn}
                  onPress={() => setSelectedAlbumTitle(null)}
                >
                  <Text style={styles.selectTextBtnLabel}>All Photos</Text>
                </TouchableOpacity>
              ) : null}

              {activeTab === 'library' && (
                <TouchableOpacity
                  style={styles.selectTextBtn}
                  onPress={() => setIsSelectMode(true)}
                >
                  <Text style={styles.selectTextBtnLabel}>Select</Text>
                </TouchableOpacity>
              )}

              {/* Profile Avatar (Google Photos / Apple ID pattern) */}
              <TouchableOpacity
                style={styles.avatarButton}
                onPress={() => setIsAccountSheetOpen(true)}
              >
                <Text style={styles.avatarInitial}>
                  {session ? (session.sub.slice(0, 1).toUpperCase() || 'U') : '👤'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>

      {/* ── Main Tab Content ──────────────────────────────────────── */}
      <View style={styles.tabCanvas}>
        {/* 1. Photos Tab */}
        {activeTab === 'library' && (
          <DevicePhotoGrid
            isSelectMode={isSelectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectAsset}
            backedUpIds={backedUpIds}
            onAssetsLoaded={setDeviceAssets}
            onUploadSingleAsset={(asset) => void performUpload([asset])}
            onReclaimSingleAsset={(asset) => void handlePurgeSingle(asset)}
          />
        )}

        {/* 2. Albums Tab */}
        {activeTab === 'albums' && (
          <ScrollView style={styles.albumsScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.albumSectionHeader}>
              <Text style={styles.albumSectionTitle}>Collections</Text>
              <TouchableOpacity onPress={() => setShowNewAlbumModal(true)}>
                <Text style={styles.newAlbumBtnText}>+ New Album</Text>
              </TouchableOpacity>
            </View>

            {/* Smart Collection Cards */}
            <View style={styles.smartAlbumsGrid}>
              <TouchableOpacity
                style={styles.smartAlbumCard}
                onPress={() => {
                  setSelectedAlbumTitle(null);
                  setActiveTab('library');
                }}
              >
                <Text style={styles.smartAlbumIcon}>🖼️</Text>
                <Text style={styles.smartAlbumTitle}>All Photos</Text>
                <Text style={styles.smartAlbumCount}>{deviceAssets.length} items</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.smartAlbumCard}
                onPress={() => {
                  setSearchQuery('cloud');
                  setActiveTab('search');
                }}
              >
                <Text style={styles.smartAlbumIcon}>☁️</Text>
                <Text style={styles.smartAlbumTitle}>Cloud Archive</Text>
                <Text style={styles.smartAlbumCount}>{backedUpIds.size} backed up</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.smartAlbumCard}
                onPress={() => {
                  setSearchQuery('videos');
                  setActiveTab('search');
                }}
              >
                <Text style={styles.smartAlbumIcon}>🎬</Text>
                <Text style={styles.smartAlbumTitle}>Videos</Text>
                <Text style={styles.smartAlbumCount}>{videosCount} videos</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.smartAlbumCard}
                onPress={() => {
                  setActiveTab('storage');
                }}
              >
                <Text style={styles.smartAlbumIcon}>🛡️</Text>
                <Text style={styles.smartAlbumTitle}>Reclaimable</Text>
                <Text style={styles.smartAlbumCount}>{eligibleForPurge.length} ready to free</Text>
              </TouchableOpacity>
            </View>

            {/* User Albums */}
            <Text style={[styles.albumSectionTitle, { marginTop: 24, marginBottom: 12 }]}>
              My Albums ({userAlbums.length})
            </Text>

            {userAlbums.length === 0 ? (
              <View style={styles.emptyAlbumBox}>
                <Text style={styles.emptyAlbumText}>
                  Create custom albums to organize your memories.
                </Text>
              </View>
            ) : (
              userAlbums.map((album) => (
                <TouchableOpacity
                  key={album.id}
                  style={styles.albumRowItem}
                  onPress={() => {
                    setSelectedAlbumTitle(album.title);
                    setActiveTab('library');
                  }}
                >
                  <View style={styles.albumRowThumb}>
                    <Text style={styles.albumRowGlyph}>📁</Text>
                  </View>
                  <View style={styles.albumRowInfo}>
                    <Text style={styles.albumRowTitle}>{album.title}</Text>
                    <Text style={styles.albumRowCount}>{album.assetCount} photos</Text>
                  </View>
                  <Text style={styles.albumRowChevron}>›</Text>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        )}

        {/* 3. Search Tab */}
        {activeTab === 'search' && (
          <View style={styles.searchTabBody}>
            <View style={styles.searchControlsContainer}>
              {/* Native iOS-style compact search bar */}
              <View style={styles.nativeSearchBar}>
                <Text style={styles.searchLeadingIcon}>🔍</Text>
                <TextInput
                  style={styles.nativeSearchInput}
                  placeholder="Search photos, videos, dates, cloud..."
                  placeholderTextColor="#8e8e93"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoFocus={searchQuery === ''}
                  autoCorrect={false}
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity
                    onPress={() => setSearchQuery('')}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <View style={styles.searchClearCircle}>
                      <Text style={styles.searchClearIcon}>✕</Text>
                    </View>
                  </TouchableOpacity>
                )}
              </View>

              {/* Category Filter Pills (Horizontal Scroll) */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.pillsRow}
              >
                <TouchableOpacity
                  style={[styles.pill, searchQuery === '' && styles.pillActive]}
                  onPress={() => setSearchQuery('')}
                >
                  <Text style={[styles.pillText, searchQuery === '' && styles.pillTextActive]}>
                    All
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.pill, searchQuery === 'photos' && styles.pillActive]}
                  onPress={() => setSearchQuery('photos')}
                >
                  <Text style={[styles.pillText, searchQuery === 'photos' && styles.pillTextActive]}>
                    📸 Photos
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.pill, searchQuery === 'videos' && styles.pillActive]}
                  onPress={() => setSearchQuery('videos')}
                >
                  <Text style={[styles.pillText, searchQuery === 'videos' && styles.pillTextActive]}>
                    🎬 Videos
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.pill, searchQuery === 'cloud' && styles.pillActive]}
                  onPress={() => setSearchQuery('cloud')}
                >
                  <Text style={[styles.pillText, searchQuery === 'cloud' && styles.pillTextActive]}>
                    ☁️ Backed Up
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.pill, searchQuery === 'local' && styles.pillActive]}
                  onPress={() => setSearchQuery('local')}
                >
                  <Text style={[styles.pillText, searchQuery === 'local' && styles.pillTextActive]}>
                    📱 Device Only
                  </Text>
                </TouchableOpacity>
              </ScrollView>
            </View>

            <View style={styles.searchGridContainer}>
              <DevicePhotoGrid
                searchQuery={searchQuery}
                backedUpIds={backedUpIds}
                onAssetsLoaded={setDeviceAssets}
                onUploadSingleAsset={(asset) => void performUpload([asset])}
                onReclaimSingleAsset={(asset) => void handlePurgeSingle(asset)}
              />
            </View>
          </View>
        )}

        {/* 4. Storage Tab */}
        {activeTab === 'storage' && (
          <ScrollView style={styles.storageScroll} showsVerticalScrollIndicator={false}>
            {/* Storage Hero Card */}
            <View style={styles.storageCard}>
              <Text style={styles.storageCardCategory}>DEVICE STORAGE</Text>
              <Text style={styles.storageCardHighlight}>{formatBytes(eligibleBytes)}</Text>
              <Text style={styles.storageCardSubtitle}>Reclaimable Space Verified in Cloud</Text>
              <Text style={styles.storageCardBody}>
                {eligibleForPurge.length} device originals have been cryptographically verified in your private AWS S3 archive. You can safely purge the device originals to free physical phone storage while keeping fast thumbnails on your device.
              </Text>

              <TouchableOpacity
                style={[
                  styles.purgeActionBtn,
                  eligibleForPurge.length === 0 && styles.purgeActionBtnDisabled,
                ]}
                disabled={eligibleForPurge.length === 0}
                onPress={() => setShowReclaimModal(true)}
              >
                <Text style={styles.purgeActionBtnText}>
                  {eligibleForPurge.length > 0
                    ? `Free ${formatBytes(eligibleBytes)} from Device`
                    : 'Storage Optimized'}
                </Text>
              </TouchableOpacity>
            </View>

            {/* Metrics Grid */}
            <View style={styles.metricsGrid}>
              <View style={styles.metricItem}>
                <Text style={styles.metricNum}>{formatBytes(reclaimedBytes)}</Text>
                <Text style={styles.metricLabel}>Total Freed</Text>
              </View>
              <View style={styles.metricItem}>
                <Text style={styles.metricNum}>{backedUpIds.size}</Text>
                <Text style={styles.metricLabel}>Archived</Text>
              </View>
              <View style={styles.metricItem}>
                <Text style={styles.metricNum}>{purgedIds.size}</Text>
                <Text style={styles.metricLabel}>Purged</Text>
              </View>
            </View>

            <View style={styles.guaranteeCard}>
              <Text style={styles.guaranteeTitle}>Architecture Guarantees</Text>
              <Text style={styles.guaranteeItem}>• SHA-256 byte-for-byte readback verification</Text>
              <Text style={styles.guaranteeItem}>• S3 Intelligent-Tiering key layout</Text>
              <Text style={styles.guaranteeItem}>• 256px thumbnails retained for instant browsing</Text>
            </View>
          </ScrollView>
        )}
      </View>

      {/* ── Selection Floating Action Bar (Apple Photos style) ────── */}
      {isSelectMode && (
        <View style={styles.floatingActionBar}>
          <TouchableOpacity
            style={styles.floatingSecondaryBtn}
            onPress={clearSelection}
            disabled={selectedIds.size === 0}
          >
            <Text style={[styles.floatingSecondaryText, selectedIds.size === 0 && styles.disabledText]}>
              Clear
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.floatingPrimaryBtn,
              selectedIds.size === 0 && styles.floatingPrimaryBtnDisabled,
            ]}
            disabled={selectedIds.size === 0}
            onPress={() => {
              const toUpload = deviceAssets.filter((a) => selectedIds.has(a.id));
              void performUpload(toUpload);
            }}
          >
            <Text style={styles.floatingPrimaryText}>
              {selectedIds.size === 0
                ? 'Select Photos'
                : `Back Up ${selectedIds.size} ${selectedIds.size === 1 ? 'Item' : 'Items'}`}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── 4-Tab Bottom Navigation (Apple Photos standard) ───────── */}
      {!isSelectMode && (
        <View style={styles.bottomNavigation}>
          <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('library')}>
            <Text style={styles.tabGlyph}>🖼️</Text>
            <Text style={[styles.tabTitle, activeTab === 'library' && styles.tabTitleActive]}>
              Photos
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('albums')}>
            <Text style={styles.tabGlyph}>🗂️</Text>
            <Text style={[styles.tabTitle, activeTab === 'albums' && styles.tabTitleActive]}>
              Albums
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('search')}>
            <Text style={styles.tabGlyph}>🔍</Text>
            <Text style={[styles.tabTitle, activeTab === 'search' && styles.tabTitleActive]}>
              Search
            </Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.tabItem} onPress={() => setActiveTab('storage')}>
            <Text style={styles.tabGlyph}>🛡️</Text>
            <Text style={[styles.tabTitle, activeTab === 'storage' && styles.tabTitleActive]}>
              Storage
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Account & Backup Sheet (Google Photos / Apple ID) ─────── */}
      <Modal
        visible={isAccountSheetOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setIsAccountSheetOpen(false)}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.sheetCard}>
            <View style={styles.sheetHandle} />

            <View style={styles.sheetTopRow}>
              <Text style={styles.sheetHeaderTitle}>Account & Backup</Text>
              <TouchableOpacity
                onPress={() => setIsAccountSheetOpen(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.sheetCloseBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {session ? (
              // Authenticated View
              <ScrollView showsVerticalScrollIndicator={false}>
                <View style={styles.profileHero}>
                  <View style={styles.profileAvatarLarge}>
                    <Text style={styles.profileAvatarLetter}>
                      {session.sub.slice(0, 1).toUpperCase() || 'U'}
                    </Text>
                  </View>
                  <Text style={styles.profileUserEmail}>Private Cloud User</Text>
                  <Text style={styles.profileSubId} numberOfLines={1}>
                    ID: {session.sub}
                  </Text>
                </View>

                {/* Storage & Backup Card */}
                <View style={styles.sheetInfoBox}>
                  <View style={styles.sheetInfoRow}>
                    <Text style={styles.sheetInfoLabel}>Cloud Status</Text>
                    <Text style={styles.sheetInfoValueGreen}>✓ Connected</Text>
                  </View>
                  <View style={styles.sheetInfoRow}>
                    <Text style={styles.sheetInfoLabel}>S3 Bucket</Text>
                    <Text style={styles.sheetInfoValueMono} numberOfLines={1}>
                      {PHOTO_ARCHIVE_AWS.bucket.slice(0, 22)}...
                    </Text>
                  </View>
                  <View style={styles.sheetInfoRow}>
                    <Text style={styles.sheetInfoLabel}>AWS Region</Text>
                    <Text style={styles.sheetInfoValue}>{PHOTO_ARCHIVE_AWS.region}</Text>
                  </View>
                  <View style={styles.sheetInfoRow}>
                    <Text style={styles.sheetInfoLabel}>Backed Up Items</Text>
                    <Text style={styles.sheetInfoValue}>{backedUpIds.size} files</Text>
                  </View>
                </View>

                {unbackedCount > 0 && (
                  <TouchableOpacity
                    style={styles.sheetBackupBtn}
                    onPress={() => {
                      setIsAccountSheetOpen(false);
                      const unbacked = deviceAssets.filter((a) => !backedUpIds.has(a.id));
                      void performUpload(unbacked.slice(0, 25));
                    }}
                  >
                    <Text style={styles.sheetBackupBtnText}>
                      Back Up Remaining ({unbackedCount})
                    </Text>
                  </TouchableOpacity>
                )}

                {/* Clear Sign Out button */}
                <TouchableOpacity
                  style={styles.sheetSignOutBtn}
                  onPress={() => void handleSignOut()}
                >
                  <Text style={styles.sheetSignOutBtnText}>Sign Out of Photo Archive</Text>
                </TouchableOpacity>
              </ScrollView>
            ) : (
              // Unauthenticated View
              <View style={styles.unauthSheetContent}>
                <View style={styles.unauthHeroIcon}>
                  <Text style={styles.unauthHeroGlyph}>☁️</Text>
                </View>
                <Text style={styles.unauthTitle}>Private S3 Photo Archive</Text>
                <Text style={styles.unauthSubtitle}>
                  Sign in with AWS Cognito to back up original full-resolution photos directly to your private S3 bucket.
                </Text>

                {authError ? <Text style={styles.sheetErrorText}>{authError}</Text> : null}

                <TouchableOpacity
                  style={styles.sheetSignInBtn}
                  onPress={() => void handleSignIn()}
                  disabled={isSigningIn}
                >
                  {isSigningIn ? (
                    <ActivityIndicator color="#000000" />
                  ) : (
                    <Text style={styles.sheetSignInBtnText}>Sign In with Cognito</Text>
                  )}
                </TouchableOpacity>

                <View style={styles.sheetConfigBox}>
                  <Text style={styles.sheetConfigTitle}>DEPLOYED CONFIGURATION</Text>
                  <Text style={styles.sheetConfigItem}>Region: {PHOTO_ARCHIVE_AWS.region}</Text>
                  <Text style={styles.sheetConfigItem}>User Pool: {PHOTO_ARCHIVE_AWS.userPoolId}</Text>
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Native Minimalist Upload Modal ────────────────────────── */}
      {uploadTask && (
        <Modal visible transparent animationType="fade">
          <View style={styles.uploadModalOverlay}>
            <View style={styles.uploadModalWindow}>
              <Text style={styles.uploadModalHeader}>
                {uploadTask.isComplete
                  ? 'Backup Complete'
                  : uploadTask.error
                  ? 'Upload Interrupted'
                  : 'Backing Up to S3'}
              </Text>

              {uploadTask.error ? (
                <View style={styles.uploadErrorWrapper}>
                  <Text style={styles.uploadErrorBadge}>✕</Text>
                  <Text style={styles.uploadErrorMessage}>{uploadTask.error}</Text>
                  <TouchableOpacity
                    style={styles.uploadDismissBtn}
                    onPress={() => setUploadTask(null)}
                  >
                    <Text style={styles.uploadDismissBtnText}>Dismiss</Text>
                  </TouchableOpacity>
                </View>
              ) : uploadTask.isUploading ? (
                <View style={styles.uploadActiveWrapper}>
                  <ActivityIndicator size="small" color="#0a84ff" style={styles.uploadSpinner} />
                  <Text style={styles.uploadFileLabel} numberOfLines={1}>
                    {uploadTask.current} of {uploadTask.total}: {uploadTask.currentFilename}
                  </Text>
                  <Text style={styles.uploadSubLabel}>{uploadTask.statusText}</Text>
                  <View style={styles.progressBarTrack}>
                    <View
                      style={[
                        styles.progressBarFill,
                        {
                          width: `${Math.round(
                            (uploadTask.current / uploadTask.total) * 100,
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              ) : (
                <View style={styles.uploadDoneWrapper}>
                  <Text style={styles.uploadDoneGlyph}>✓</Text>
                  <Text style={styles.uploadDoneSummary}>
                    {uploadTask.total} items securely archived and indexed.
                  </Text>
                  <TouchableOpacity
                    style={styles.uploadDismissBtn}
                    onPress={() => setUploadTask(null)}
                  >
                    <Text style={styles.uploadDismissBtnText}>Done</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </Modal>
      )}

      {/* ── Space Reclamation Confirmation Dialog ─────────────────── */}
      <Modal visible={showReclaimModal} transparent animationType="fade">
        <View style={styles.uploadModalOverlay}>
          <View style={styles.uploadModalWindow}>
            <Text style={styles.uploadModalHeader}>Free Device Storage?</Text>
            <Text style={styles.reclaimModalPrompt}>
              {eligibleForPurge.length} photos have been verified byte-for-byte in AWS S3. Deleting them from your device camera roll will free {formatBytes(eligibleBytes)}. Cached 256px thumbnails remain available on your device.
            </Text>
            <View style={styles.reclaimModalBtnRow}>
              <TouchableOpacity
                style={styles.reclaimCancelBtn}
                onPress={() => setShowReclaimModal(false)}
              >
                <Text style={styles.reclaimCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.reclaimConfirmBtn}
                onPress={() => void handlePurgeConfirmed()}
              >
                <Text style={styles.reclaimConfirmText}>Free Space Now</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Create Album Dialog ───────────────────────────────────── */}
      <Modal visible={showNewAlbumModal} transparent animationType="fade">
        <View style={styles.uploadModalOverlay}>
          <View style={styles.uploadModalWindow}>
            <Text style={styles.uploadModalHeader}>New Album</Text>
            <TextInput
              style={styles.albumTitleInput}
              placeholder="Album Title..."
              placeholderTextColor="#8e8e93"
              value={newAlbumTitle}
              onChangeText={setNewAlbumTitle}
              autoFocus
            />
            <View style={styles.reclaimModalBtnRow}>
              <TouchableOpacity
                style={styles.reclaimCancelBtn}
                onPress={() => setShowNewAlbumModal(false)}
              >
                <Text style={styles.reclaimCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.albumSaveBtn}
                onPress={() => void handleCreateAlbum()}
              >
                <Text style={styles.albumSaveBtnText}>Create</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

export default function App(): React.ReactElement {
  return (
    <SQLiteProvider databaseName="photo-archive.db" useSuspense>
      <Suspense fallback={<View style={styles.appContainer} />}>
        <AppShell />
      </Suspense>
    </SQLiteProvider>
  );
}

const styles = StyleSheet.create({
  appContainer: {
    flex: 1,
    backgroundColor: '#000000',
  },
  // Top Header
  topHeader: {
    paddingTop: 54,
    paddingHorizontal: 18,
    paddingBottom: 10,
    backgroundColor: '#000000',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  standardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  navLargeTitle: {
    color: '#ffffff',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  syncStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 3,
  },
  syncStatusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  syncStatusLabel: {
    color: '#8e8e93',
    fontSize: 12,
  },
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  selectTextBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: '#1c1c1e',
  },
  selectTextBtnLabel: {
    color: '#0a84ff',
    fontSize: 14,
    fontWeight: '600',
  },
  avatarButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  selectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 40,
  },
  headerActionText: {
    color: '#0a84ff',
    fontSize: 16,
    fontWeight: '500',
  },
  selectionTitle: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  tabCanvas: {
    flex: 1,
  },
  // Albums Tab
  albumsScroll: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  albumSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  albumSectionTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  newAlbumBtnText: {
    color: '#0a84ff',
    fontSize: 14,
    fontWeight: '600',
  },
  smartAlbumsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  smartAlbumCard: {
    width: '48%',
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 14,
  },
  smartAlbumIcon: {
    fontSize: 26,
    marginBottom: 8,
  },
  smartAlbumTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  smartAlbumCount: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  emptyAlbumBox: {
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 24,
    alignItems: 'center',
  },
  emptyAlbumText: {
    color: '#8e8e93',
    fontSize: 13,
    textAlign: 'center',
  },
  albumRowItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  albumRowThumb: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  albumRowGlyph: {
    fontSize: 20,
  },
  albumRowInfo: {
    flex: 1,
  },
  albumRowTitle: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  albumRowCount: {
    color: '#8e8e93',
    fontSize: 12,
    marginTop: 2,
  },
  albumRowChevron: {
    color: '#8e8e93',
    fontSize: 20,
  },
  albumTitleInput: {
    width: '100%',
    backgroundColor: '#2c2c2e',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#ffffff',
    fontSize: 15,
    marginVertical: 16,
  },
  albumSaveBtn: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 8,
  },
  albumSaveBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Search Tab
  searchTabBody: {
    flex: 1,
  },
  searchControlsContainer: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  searchGridContainer: {
    flex: 1,
  },
  nativeSearchBar: {
    height: 38,
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  searchLeadingIcon: {
    fontSize: 14,
    marginRight: 8,
    opacity: 0.6,
  },
  nativeSearchInput: {
    flex: 1,
    height: 38,
    color: '#ffffff',
    fontSize: 15,
    paddingVertical: 0,
  },
  searchClearCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#3a3a3c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearIcon: {
    color: '#8e8e93',
    fontSize: 10,
    fontWeight: '700',
  },
  pillsRow: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#1c1c1e',
  },
  pillActive: {
    backgroundColor: '#0a84ff',
  },
  pillText: {
    color: '#8e8e93',
    fontSize: 13,
  },
  pillTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  // Storage Tab
  storageScroll: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  storageCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
  },
  storageCardCategory: {
    color: '#0a84ff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  storageCardHighlight: {
    color: '#ffffff',
    fontSize: 28,
    fontWeight: '700',
    marginTop: 4,
  },
  storageCardSubtitle: {
    color: '#8e8e93',
    fontSize: 13,
    marginTop: 2,
  },
  storageCardBody: {
    color: '#d1d1d6',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 10,
  },
  purgeActionBtn: {
    marginTop: 16,
    backgroundColor: '#ff453a',
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  purgeActionBtnDisabled: {
    backgroundColor: '#2c2c2e',
    opacity: 0.5,
  },
  purgeActionBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  metricsGrid: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 20,
  },
  metricItem: {
    flex: 1,
    backgroundColor: '#1c1c1e',
    padding: 14,
    borderRadius: 12,
  },
  metricNum: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  metricLabel: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 4,
  },
  guaranteeCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 16,
    gap: 8,
  },
  guaranteeTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  guaranteeItem: {
    color: '#8e8e93',
    fontSize: 12,
  },
  // Floating Action Bar (Selection)
  floatingActionBar: {
    position: 'absolute',
    bottom: 24,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(28, 28, 30, 0.95)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#38383a',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 8,
  },
  floatingSecondaryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  floatingSecondaryText: {
    color: '#8e8e93',
    fontSize: 14,
  },
  disabledText: {
    opacity: 0.4,
  },
  floatingPrimaryBtn: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 12,
  },
  floatingPrimaryBtnDisabled: {
    opacity: 0.4,
  },
  floatingPrimaryText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  // Bottom Navigation
  bottomNavigation: {
    height: 60,
    backgroundColor: '#000000',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2c2c2e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingBottom: 6,
  },
  tabItem: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  tabGlyph: {
    fontSize: 18,
  },
  tabTitle: {
    color: '#8e8e93',
    fontSize: 10,
    marginTop: 2,
    fontWeight: '500',
  },
  tabTitleActive: {
    color: '#0a84ff',
    fontWeight: '600',
  },
  // Account Sheet Modal
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  sheetCard: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 36,
    maxHeight: '85%',
  },
  sheetHandle: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#48484a',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  sheetTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  sheetHeaderTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
  },
  sheetCloseBtn: {
    color: '#8e8e93',
    fontSize: 16,
    padding: 4,
  },
  profileHero: {
    alignItems: 'center',
    marginVertical: 12,
  },
  profileAvatarLarge: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileAvatarLetter: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '700',
  },
  profileUserEmail: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
    marginTop: 8,
  },
  profileSubId: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 2,
    maxWidth: 240,
  },
  sheetInfoBox: {
    backgroundColor: '#2c2c2e',
    borderRadius: 14,
    padding: 14,
    marginVertical: 14,
    gap: 10,
  },
  sheetInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sheetInfoLabel: {
    color: '#8e8e93',
    fontSize: 13,
  },
  sheetInfoValue: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
  },
  sheetInfoValueGreen: {
    color: '#34c759',
    fontSize: 13,
    fontWeight: '600',
  },
  sheetInfoValueMono: {
    color: '#8e8e93',
    fontSize: 11,
    fontFamily: 'monospace',
    maxWidth: 160,
  },
  sheetBackupBtn: {
    backgroundColor: '#0a84ff',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
  },
  sheetBackupBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  sheetSignOutBtn: {
    backgroundColor: 'rgba(255, 69, 58, 0.12)',
    borderWidth: 1,
    borderColor: '#ff453a',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6,
    marginBottom: 20,
  },
  sheetSignOutBtnText: {
    color: '#ff453a',
    fontSize: 14,
    fontWeight: '600',
  },
  unauthSheetContent: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  unauthHeroIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  unauthHeroGlyph: {
    fontSize: 26,
  },
  unauthTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '700',
  },
  unauthSubtitle: {
    color: '#8e8e93',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 18,
    paddingHorizontal: 12,
  },
  sheetErrorText: {
    color: '#ff453a',
    fontSize: 12,
    marginTop: 10,
  },
  sheetSignInBtn: {
    backgroundColor: '#ffffff',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginTop: 20,
    width: '100%',
    alignItems: 'center',
  },
  sheetSignInBtnText: {
    color: '#000000',
    fontSize: 14,
    fontWeight: '600',
  },
  sheetConfigBox: {
    marginTop: 20,
    backgroundColor: '#2c2c2e',
    padding: 12,
    borderRadius: 10,
    width: '100%',
    gap: 4,
  },
  sheetConfigTitle: {
    color: '#8e8e93',
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: '700',
  },
  sheetConfigItem: {
    color: '#d1d1d6',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  // Native Upload Modal
  uploadModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  uploadModalWindow: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  uploadModalHeader: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  uploadActiveWrapper: {
    width: '100%',
    alignItems: 'center',
    marginTop: 16,
  },
  uploadSpinner: {
    marginBottom: 10,
  },
  uploadFileLabel: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
  },
  uploadSubLabel: {
    color: '#8e8e93',
    fontSize: 11,
    marginTop: 4,
  },
  progressBarTrack: {
    width: '100%',
    height: 4,
    backgroundColor: '#2c2c2e',
    borderRadius: 2,
    marginTop: 14,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#0a84ff',
  },
  uploadDoneWrapper: {
    alignItems: 'center',
    marginTop: 14,
  },
  uploadDoneGlyph: {
    fontSize: 28,
    color: '#34c759',
  },
  uploadDoneSummary: {
    color: '#ffffff',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 8,
  },
  uploadDismissBtn: {
    marginTop: 16,
    backgroundColor: '#2c2c2e',
    paddingVertical: 8,
    paddingHorizontal: 22,
    borderRadius: 10,
  },
  uploadDismissBtnText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  uploadErrorWrapper: {
    alignItems: 'center',
    marginTop: 12,
  },
  uploadErrorBadge: {
    fontSize: 24,
    color: '#ff453a',
  },
  uploadErrorMessage: {
    color: '#d1d1d6',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 6,
  },
  // Reclaim confirmation dialog
  reclaimModalPrompt: {
    color: '#d1d1d6',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    marginVertical: 14,
  },
  reclaimModalBtnRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  reclaimCancelBtn: {
    backgroundColor: '#2c2c2e',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  reclaimCancelText: {
    color: '#8e8e93',
    fontSize: 14,
    fontWeight: '500',
  },
  reclaimConfirmBtn: {
    backgroundColor: '#ff453a',
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
  },
  reclaimConfirmText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
});
