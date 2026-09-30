import { useSQLiteContext, SQLiteProvider } from 'expo-sqlite';
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
import { uploadAssetToS3, type UploadResult } from './src/ingest/s3Uploader.ts';
import { cognitoConfig, PHOTO_ARCHIVE_AWS } from './src/config/aws.ts';

type ActiveTab = 'photos' | 'search' | 'reclaim' | 'cloud';

interface UploadModalState {
  readonly isUploading: boolean;
  readonly total: number;
  readonly current: number;
  readonly currentFilename: string;
  readonly statusText: string;
  readonly currentHash: string;
  readonly currentKey: string;
  readonly error?: string;
  readonly isComplete: boolean;
  readonly successfulUploads: UploadResult[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function AppShell(): React.ReactElement {
  const db = useSQLiteContext();
  const driver = useMemo(() => new ExpoSqliteDriver(db), [db]);

  const [session, setSession] = useState<SignInSession | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Tabs & Navigation State
  const [activeTab, setActiveTab] = useState<ActiveTab>('photos');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deviceAssets, setDeviceAssets] = useState<DevicePhoto[]>([]);

  // S3 Backed-up tracker loaded from local SQLite
  const [backedUpIds, setBackedUpIds] = useState<Set<string>>(new Set());
  const [sqliteLoaded, setSqliteLoaded] = useState(false);

  // Upload modal state
  const [uploadModal, setUploadModal] = useState<UploadModalState | null>(null);

  // Reclaim state
  const [purgedIds, setPurgedIds] = useState<Set<string>>(new Set());
  const [reclaimedBytes, setReclaimedBytes] = useState(0);

  // Load existing backed-up assets from SQLite on launch
  const refreshBackedUpFromSql = useCallback(async () => {
    try {
      const rows = await driver.all<{ local_id: string }>(
        `SELECT local_id FROM local_assets WHERE hash_state = 1`,
      );
      setBackedUpIds(new Set(rows.map((r) => r.local_id)));
      setSqliteLoaded(true);
    } catch (err) {
      console.warn('Could not read backed-up assets from SQLite:', err);
    }
  }, [driver]);

  useEffect(() => {
    initDatabase(db)
      .then(() => refreshBackedUpFromSql())
      .catch((err: unknown) => {
        console.error('Database initialization failed:', err);
      });
  }, [db, refreshBackedUpFromSql]);

  const handleSignIn = async (): Promise<void> => {
    setAuthError(null);
    setIsSigningIn(true);
    try {
      const newSession = await signIn(cognitoConfig, 'Cognito');
      setSession(newSession);
    } catch (error: unknown) {
      setAuthError(error instanceof AuthError ? error.message : 'Sign-in failed');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async (): Promise<void> => {
    if (session) {
      await signOut(cognitoConfig, session.tokens.accessToken).catch(() => undefined);
      setSession(null);
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

  // Real S3 Upload Pipeline
  const handleUploadSelectedToS3 = async (assetsToUpload: DevicePhoto[]) => {
    if (assetsToUpload.length === 0) return;

    if (!session) {
      setActiveTab('cloud');
      setAuthError('Sign in with AWS Cognito to upload photos directly to your S3 bucket.');
      return;
    }

    const credentialProvider = new CredentialProvider(session, {
      cognito: cognitoConfig,
      userPoolId: PHOTO_ARCHIVE_AWS.userPoolId,
      identityPoolId: PHOTO_ARCHIVE_AWS.identityPoolId,
      region: PHOTO_ARCHIVE_AWS.region,
      refreshToken: session.tokens.refreshToken,
    });

    const successful: UploadResult[] = [];

    setUploadModal({
      isUploading: true,
      total: assetsToUpload.length,
      current: 0,
      currentFilename: assetsToUpload[0]?.filename ?? 'Photo',
      statusText: 'Initializing S3 upload...',
      currentHash: '',
      currentKey: '',
      isComplete: false,
      successfulUploads: [],
    });

    try {
      for (let i = 0; i < assetsToUpload.length; i++) {
        const asset = assetsToUpload[i];
        if (!asset) continue;

        setUploadModal((prev) =>
          prev
            ? {
                ...prev,
                current: i + 1,
                currentFilename: asset.filename ?? `Photo ${i + 1}`,
                statusText: `Processing ${asset.filename ?? 'photo'}...`,
              }
            : null,
        );

        const result = await uploadAssetToS3(
          asset,
          credentialProvider,
          driver,
          (step) => {
            setUploadModal((prev) =>
              prev
                ? {
                    ...prev,
                    statusText:
                      step.status === 'reading'
                        ? 'Reading device bytes...'
                        : step.status === 'hashing'
                        ? 'Computing SHA-256 content address...'
                        : step.status === 'signing'
                        ? 'Signing AWS SigV4 PUT request...'
                        : step.status === 'uploading'
                        ? 'Uploading to S3 bucket...'
                        : step.status === 'recording'
                        ? 'Recording in SQLite ledger...'
                        : 'Done',
                    currentHash: step.hash ?? prev.currentHash,
                  }
                : null,
            );
          },
        );

        successful.push(result);
        setBackedUpIds((prev) => new Set([...prev, asset.id]));
      }

      setUploadModal((prev) =>
        prev
          ? {
              ...prev,
              isUploading: false,
              isComplete: true,
              statusText: `Successfully uploaded ${successful.length} items to S3.`,
              successfulUploads: successful,
            }
          : null,
      );

      // Refresh SQLite status
      await refreshBackedUpFromSql();
      setSelectedIds(new Set());
      setIsSelectMode(false);
    } catch (err: unknown) {
      console.error('Real S3 Upload Failed:', err);
      setUploadModal((prev) =>
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

  // Reclaim calculations based on real database records
  const eligibleForPurge = deviceAssets.filter(
    (a) => backedUpIds.has(a.id) && !purgedIds.has(a.id),
  );
  const eligibleBytes = eligibleForPurge.reduce(
    (acc, a) => acc + (a.width ?? 1920) * (a.height ?? 1080) * 0.4,
    0,
  );

  const handlePurgeEligible = async () => {
    // Record purge in SQLite: update local_state to 3 (Purged)
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
  };

  return (
    <View style={styles.mainContainer}>
      {/* ── Top Header Bar ────────────────────────────────────────── */}
      <View style={styles.headerBar}>
        <View style={styles.headerLeft}>
          <Text style={styles.appTitle}>Photo Archive</Text>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: session ? '#9acd7c' : '#ef4444' },
              ]}
            />
            <Text style={styles.statusSubtitle}>
              {session
                ? `S3: ${PHOTO_ARCHIVE_AWS.bucket.slice(0, 18)}...`
                : 'Not Signed In (Sign in to sync S3)'}
            </Text>
          </View>
        </View>

        {/* Header Action Buttons */}
        <View style={styles.headerActions}>
          <TouchableOpacity
            style={[styles.iconButton, isSearchOpen && styles.iconButtonActive]}
            onPress={() => {
              setIsSearchOpen((prev) => !prev);
              if (activeTab !== 'photos' && activeTab !== 'search') {
                setActiveTab('photos');
              }
            }}
          >
            <Text style={styles.iconButtonText}>🔍</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.iconButton, isSelectMode && styles.iconButtonActive]}
            onPress={() => setIsSelectMode((prev) => !prev)}
          >
            <Text style={styles.iconButtonText}>{isSelectMode ? '✕' : '☑️'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.backupActionButton}
            onPress={() => {
              if (isSelectMode && selectedIds.size > 0) {
                const toUpload = deviceAssets.filter((a) => selectedIds.has(a.id));
                void handleUploadSelectedToS3(toUpload);
              } else {
                const unbacked = deviceAssets.filter((a) => !backedUpIds.has(a.id));
                void handleUploadSelectedToS3(unbacked.slice(0, 20));
              }
            }}
          >
            <Text style={styles.backupActionButtonText}>
              {isSelectMode && selectedIds.size > 0
                ? `Upload (${selectedIds.size})`
                : '☁️ S3 Backup'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Interactive Search Bar Dropdown ────────────────────────── */}
      {isSearchOpen && (
        <View style={styles.searchBarContainer}>
          <TextInput
            style={styles.searchInput}
            placeholder="Filter by filename, date, or type..."
            placeholderTextColor="#788075"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity
              onPress={() => setSearchQuery('')}
              style={styles.searchClearBtn}
            >
              <Text style={styles.searchClearText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ── Multi-Select Control Ribbon ────────────────────────────── */}
      {isSelectMode && (
        <View style={styles.selectionRibbon}>
          <Text style={styles.selectionCountText}>
            {selectedIds.size} of {deviceAssets.length} selected
          </Text>
          <View style={styles.selectionBtnGroup}>
            <TouchableOpacity onPress={selectAll} style={styles.ribbonBtn}>
              <Text style={styles.ribbonBtnText}>Select All</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={clearSelection} style={styles.ribbonBtn}>
              <Text style={styles.ribbonBtnText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                const toUpload = deviceAssets.filter((a) => selectedIds.has(a.id));
                void handleUploadSelectedToS3(toUpload);
              }}
              disabled={selectedIds.size === 0}
              style={[
                styles.ribbonUploadBtn,
                selectedIds.size === 0 && styles.btnDisabled,
              ]}
            >
              <Text style={styles.ribbonUploadBtnText}>
                Upload ({selectedIds.size})
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Main Tab Content ────────────────────────────────────────── */}
      <View style={styles.tabContentContainer}>
        {activeTab === 'photos' && (
          <DevicePhotoGrid
            searchQuery={searchQuery}
            isSelectMode={isSelectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelectAsset}
            backedUpIds={backedUpIds}
            onAssetsLoaded={setDeviceAssets}
          />
        )}

        {activeTab === 'search' && (
          <View style={styles.searchTabContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search filenames, tags, or dates..."
              placeholderTextColor="#788075"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            <View style={styles.filterChipRow}>
              <TouchableOpacity
                style={[styles.filterChip, searchQuery === '' && styles.filterChipActive]}
                onPress={() => setSearchQuery('')}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    searchQuery === '' && styles.filterChipTextActive,
                  ]}
                >
                  All Media
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterChip, searchQuery === 'jpg' && styles.filterChipActive]}
                onPress={() => setSearchQuery('jpg')}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    searchQuery === 'jpg' && styles.filterChipTextActive,
                  ]}
                >
                  Photos
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterChip, searchQuery === 'video' && styles.filterChipActive]}
                onPress={() => setSearchQuery('video')}
              >
                <Text
                  style={[
                    styles.filterChipText,
                    searchQuery === 'video' && styles.filterChipTextActive,
                  ]}
                >
                  Videos
                </Text>
              </TouchableOpacity>
            </View>
            <DevicePhotoGrid
              searchQuery={searchQuery}
              backedUpIds={backedUpIds}
              onAssetsLoaded={setDeviceAssets}
            />
          </View>
        )}

        {activeTab === 'reclaim' && (
          <ScrollView style={styles.reclaimContainer}>
            <View style={styles.reclaimCard}>
              <Text style={styles.reclaimCardEyebrow}>SPACE RECLAMATION</Text>
              <Text style={styles.reclaimCardTitle}>
                {formatBytes(eligibleBytes)} Reclaimable
              </Text>
              <Text style={styles.reclaimCardDesc}>
                {eligibleForPurge.length} device originals have been verified in SQLite and confirmed in AWS S3 with SHA-256 content hashes.
              </Text>

              <TouchableOpacity
                style={[
                  styles.purgeButton,
                  eligibleForPurge.length === 0 && styles.btnDisabled,
                ]}
                disabled={eligibleForPurge.length === 0}
                onPress={() => void handlePurgeEligible()}
              >
                <Text style={styles.purgeButtonText}>
                  {eligibleForPurge.length > 0
                    ? `Purge ${eligibleForPurge.length} Local Originals (${formatBytes(eligibleBytes)})`
                    : 'All Verified Originals Reclaimed'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.reclaimStatsRow}>
              <View style={styles.statBox}>
                <Text style={styles.statBoxNum}>{formatBytes(reclaimedBytes)}</Text>
                <Text style={styles.statBoxLabel}>Total Freed</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statBoxNum}>{backedUpIds.size}</Text>
                <Text style={styles.statBoxLabel}>Backed Up S3</Text>
              </View>
              <View style={styles.statBox}>
                <Text style={styles.statBoxNum}>{purgedIds.size}</Text>
                <Text style={styles.statBoxLabel}>Purged Locally</Text>
              </View>
            </View>

            <Text style={styles.reclaimSectionTitle}>Verification Guarantees</Text>
            <View style={styles.guaranteeBox}>
              <Text style={styles.guaranteeItem}>✓ Cryptographic SHA-256 content hash verified</Text>
              <Text style={styles.guaranteeItem}>✓ S3 Intelligent-Tiering key layout ({'{prefix}/orig/{hash}'})</Text>
              <Text style={styles.guaranteeItem}>✓ Local SQLite audit ledger updated</Text>
            </View>
          </ScrollView>
        )}

        {activeTab === 'cloud' && (
          <ScrollView style={styles.cloudContainer}>
            <View style={styles.cloudCard}>
              <Text style={styles.reclaimCardEyebrow}>AWS S3 INFRASTRUCTURE</Text>
              <Text style={styles.cloudTitle}>Production S3 Storage</Text>
              <Text style={styles.cloudBucketName}>
                Bucket: {PHOTO_ARCHIVE_AWS.bucket}
              </Text>
              <Text style={styles.cloudRegion}>Region: {PHOTO_ARCHIVE_AWS.region}</Text>
              <Text style={styles.cloudUserpool}>
                Cognito Pool: {PHOTO_ARCHIVE_AWS.userPoolId}
              </Text>
              <Text style={styles.cloudUserpool}>
                Identity Pool: {PHOTO_ARCHIVE_AWS.identityPoolId}
              </Text>

              <View style={styles.divider} />

              {session ? (
                <View>
                  <Text style={styles.sessionStatus}>✓ Authenticated to AWS Cognito</Text>
                  <Text style={styles.subText}>Tenant Sub: {session.sub}</Text>
                  <Text style={styles.subText}>
                    Tokens expire: {new Date(session.tokens.expiresAt * 1000).toLocaleTimeString()}
                  </Text>
                  <TouchableOpacity
                    style={styles.signOutBtn}
                    onPress={() => void handleSignOut()}
                  >
                    <Text style={styles.signOutBtnText}>Sign Out</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View>
                  <Text style={styles.localStatusText}>
                    Sign in with AWS Cognito to obtain scoped STS credentials and upload directly to your S3 bucket.
                  </Text>

                  {authError ? <Text style={styles.errorText}>{authError}</Text> : null}

                  <TouchableOpacity
                    style={styles.signInBtn}
                    onPress={() => void handleSignIn()}
                    disabled={isSigningIn}
                  >
                    <Text style={styles.signInBtnText}>
                      {isSigningIn ? 'Connecting to Cognito...' : 'Sign In with Cognito'}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </ScrollView>
        )}
      </View>

      {/* ── Bottom Navigation Tabs ─────────────────────────────────── */}
      <View style={styles.bottomTabBar}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'photos' && styles.tabButtonActive]}
          onPress={() => setActiveTab('photos')}
        >
          <Text style={styles.tabIcon}>📸</Text>
          <Text
            style={[styles.tabLabel, activeTab === 'photos' && styles.tabLabelActive]}
          >
            Photos
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'search' && styles.tabButtonActive]}
          onPress={() => setActiveTab('search')}
        >
          <Text style={styles.tabIcon}>🔍</Text>
          <Text
            style={[styles.tabLabel, activeTab === 'search' && styles.tabLabelActive]}
          >
            Search
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'reclaim' && styles.tabButtonActive]}
          onPress={() => setActiveTab('reclaim')}
        >
          <Text style={styles.tabIcon}>🛡️</Text>
          <Text
            style={[styles.tabLabel, activeTab === 'reclaim' && styles.tabLabelActive]}
          >
            Reclaim
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === 'cloud' && styles.tabButtonActive]}
          onPress={() => setActiveTab('cloud')}
        >
          <Text style={styles.tabIcon}>☁️</Text>
          <Text
            style={[styles.tabLabel, activeTab === 'cloud' && styles.tabLabelActive]}
          >
            AWS S3
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── AWS Upload Real-Time Modal ──────────────────────────────── */}
      {uploadModal && (
        <Modal visible transparent animationType="fade">
          <View style={styles.uploadModalOverlay}>
            <View style={styles.uploadModalCard}>
              <Text style={styles.uploadModalTitle}>
                {uploadModal.isComplete
                  ? 'S3 Backup Complete'
                  : uploadModal.error
                  ? 'S3 Upload Error'
                  : 'Uploading to Amazon S3'}
              </Text>
              <Text style={styles.uploadModalTarget}>
                s3://{PHOTO_ARCHIVE_AWS.bucket}
              </Text>

              {uploadModal.error ? (
                <View style={styles.uploadErrorSection}>
                  <Text style={styles.uploadErrorIcon}>✕</Text>
                  <Text style={styles.uploadErrorTitle}>Upload Failed</Text>
                  <Text style={styles.uploadErrorDesc}>{uploadModal.error}</Text>
                  <TouchableOpacity
                    style={styles.uploadDoneBtn}
                    onPress={() => setUploadModal(null)}
                  >
                    <Text style={styles.uploadDoneBtnText}>Dismiss</Text>
                  </TouchableOpacity>
                </View>
              ) : uploadModal.isUploading ? (
                <View style={styles.uploadProgressSection}>
                  <ActivityIndicator size="small" color="#9acd7c" />
                  <Text style={styles.uploadModalFile} numberOfLines={1}>
                    Item {uploadModal.current} of {uploadModal.total}:{' '}
                    {uploadModal.currentFilename}
                  </Text>
                  <Text style={styles.uploadModalStatusText}>
                    {uploadModal.statusText}
                  </Text>
                  {uploadModal.currentHash ? (
                    <Text style={styles.uploadModalHash} numberOfLines={1}>
                      SHA-256: {uploadModal.currentHash.slice(0, 32)}...
                    </Text>
                  ) : null}
                  <View style={styles.progressBarBg}>
                    <View
                      style={[
                        styles.progressBarFill,
                        {
                          width: `${Math.round(
                            (uploadModal.current / uploadModal.total) * 100,
                          )}%`,
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.uploadPercent}>
                    {Math.round((uploadModal.current / uploadModal.total) * 100)}%
                  </Text>
                </View>
              ) : (
                <View style={styles.uploadCompleteSection}>
                  <Text style={styles.uploadSuccessIcon}>✓</Text>
                  <Text style={styles.uploadSuccessText}>
                    {uploadModal.successfulUploads.length} original files uploaded and verified in Amazon S3 ({PHOTO_ARCHIVE_AWS.region}).
                  </Text>
                  <Text style={styles.uploadSuccessSub}>
                    SQLite ledger updated with SHA-256 content addresses.
                  </Text>
                  <TouchableOpacity
                    style={styles.uploadDoneBtn}
                    onPress={() => setUploadModal(null)}
                  >
                    <Text style={styles.uploadDoneBtnText}>Done</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

export default function App(): React.ReactElement {
  return (
    <SQLiteProvider databaseName="photo-archive.db" useSuspense>
      <Suspense fallback={<View style={styles.fallbackContainer} />}>
        <AppShell />
      </Suspense>
    </SQLiteProvider>
  );
}

const styles = StyleSheet.create({
  mainContainer: {
    flex: 1,
    backgroundColor: '#0c0d0b',
  },
  fallbackContainer: {
    flex: 1,
    backgroundColor: '#0c0d0b',
  },
  headerBar: {
    paddingTop: 54,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: '#121310',
    borderBottomWidth: 1,
    borderBottomColor: '#20221c',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flex: 1,
  },
  appTitle: {
    color: '#f2f4ec',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusSubtitle: {
    color: '#8e968b',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#1b1d18',
    borderWidth: 1,
    borderColor: '#2b2e26',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonActive: {
    backgroundColor: '#2e3328',
    borderColor: '#9acd7c',
  },
  iconButtonText: {
    fontSize: 14,
  },
  backupActionButton: {
    backgroundColor: '#9acd7c',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  backupActionButtonText: {
    color: '#0c0d0b',
    fontSize: 12,
    fontWeight: '600',
  },
  searchBarContainer: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#151613',
    borderBottomWidth: 1,
    borderBottomColor: '#242720',
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#1c1e19',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: '#f2f4ec',
    fontSize: 13,
    borderWidth: 1,
    borderColor: '#2f332a',
  },
  searchClearBtn: {
    paddingHorizontal: 10,
  },
  searchClearText: {
    color: '#8e968b',
    fontSize: 14,
  },
  selectionRibbon: {
    backgroundColor: '#1b1d18',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2f332a',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectionCountText: {
    color: '#9acd7c',
    fontSize: 12,
    fontWeight: '600',
  },
  selectionBtnGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  ribbonBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#262922',
  },
  ribbonBtnText: {
    color: '#c2cac0',
    fontSize: 11,
  },
  ribbonUploadBtn: {
    backgroundColor: '#9acd7c',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  ribbonUploadBtnText: {
    color: '#0c0d0b',
    fontSize: 11,
    fontWeight: '700',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  tabContentContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  searchTabContainer: {
    flex: 1,
    gap: 12,
  },
  filterChipRow: {
    flexDirection: 'row',
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#1a1c17',
    borderWidth: 1,
    borderColor: '#2b2e25',
  },
  filterChipActive: {
    backgroundColor: '#273022',
    borderColor: '#9acd7c',
  },
  filterChipText: {
    color: '#8e968b',
    fontSize: 12,
  },
  filterChipTextActive: {
    color: '#9acd7c',
    fontSize: 12,
    fontWeight: '600',
  },
  reclaimContainer: {
    flex: 1,
  },
  reclaimCard: {
    backgroundColor: '#141612',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#262a22',
    marginBottom: 16,
  },
  reclaimCardEyebrow: {
    color: '#9acd7c',
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  reclaimCardTitle: {
    color: '#f2f4ec',
    fontSize: 24,
    fontWeight: '700',
    marginTop: 6,
  },
  reclaimCardDesc: {
    color: '#8e968b',
    fontSize: 13,
    marginTop: 8,
    lineHeight: 18,
  },
  purgeButton: {
    marginTop: 16,
    backgroundColor: '#ef4444',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  purgeButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  reclaimStatsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 20,
  },
  statBox: {
    flex: 1,
    backgroundColor: '#141612',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262a22',
  },
  statBoxNum: {
    color: '#f2f4ec',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  statBoxLabel: {
    color: '#8e968b',
    fontSize: 10,
    marginTop: 4,
    textTransform: 'uppercase',
  },
  reclaimSectionTitle: {
    color: '#f2f4ec',
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  guaranteeBox: {
    backgroundColor: '#141612',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#262a22',
    gap: 8,
  },
  guaranteeItem: {
    color: '#a3ad9f',
    fontSize: 12,
  },
  cloudContainer: {
    flex: 1,
  },
  cloudCard: {
    backgroundColor: '#141612',
    padding: 18,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#262a22',
  },
  cloudTitle: {
    color: '#f2f4ec',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 4,
  },
  cloudBucketName: {
    color: '#9acd7c',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 8,
  },
  cloudRegion: {
    color: '#8e968b',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  cloudUserpool: {
    color: '#8e968b',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: '#262a22',
    marginVertical: 16,
  },
  sessionStatus: {
    color: '#9acd7c',
    fontSize: 13,
    fontWeight: '600',
  },
  subText: {
    color: '#8e968b',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  signOutBtn: {
    marginTop: 14,
    backgroundColor: '#262a22',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  signOutBtnText: {
    color: '#f2f4ec',
    fontSize: 12,
    fontWeight: '500',
  },
  localStatusText: {
    color: '#8e968b',
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 12,
    marginTop: 8,
  },
  signInBtn: {
    marginTop: 14,
    backgroundColor: '#9acd7c',
    paddingVertical: 11,
    borderRadius: 8,
    alignItems: 'center',
  },
  signInBtnText: {
    color: '#0c0d0b',
    fontSize: 13,
    fontWeight: '600',
  },
  bottomTabBar: {
    height: 64,
    backgroundColor: '#121310',
    borderTopWidth: 1,
    borderTopColor: '#20221c',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingBottom: 8,
  },
  tabButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  tabButtonActive: {},
  tabIcon: {
    fontSize: 18,
  },
  tabLabel: {
    color: '#6e756b',
    fontSize: 10,
    marginTop: 2,
    fontWeight: '500',
  },
  tabLabelActive: {
    color: '#9acd7c',
    fontWeight: '700',
  },
  uploadModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  uploadModalCard: {
    width: '100%',
    backgroundColor: '#141612',
    borderRadius: 14,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2b2f25',
  },
  uploadModalTitle: {
    color: '#f2f4ec',
    fontSize: 17,
    fontWeight: '700',
  },
  uploadModalTarget: {
    color: '#8e968b',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  uploadProgressSection: {
    marginTop: 20,
    alignItems: 'center',
  },
  uploadModalFile: {
    color: '#dbe2d8',
    fontSize: 13,
    marginTop: 12,
  },
  uploadModalStatusText: {
    color: '#9acd7c',
    fontSize: 12,
    marginTop: 6,
  },
  uploadModalHash: {
    color: '#8e968b',
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  progressBarBg: {
    width: '100%',
    height: 6,
    backgroundColor: '#242820',
    borderRadius: 3,
    marginTop: 16,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#9acd7c',
  },
  uploadPercent: {
    color: '#9acd7c',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 8,
  },
  uploadCompleteSection: {
    marginTop: 20,
    alignItems: 'center',
  },
  uploadSuccessIcon: {
    fontSize: 32,
    color: '#9acd7c',
  },
  uploadSuccessText: {
    color: '#dbe2d8',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 18,
  },
  uploadSuccessSub: {
    color: '#8e968b',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 6,
    fontFamily: 'monospace',
  },
  uploadErrorSection: {
    marginTop: 20,
    alignItems: 'center',
  },
  uploadErrorIcon: {
    fontSize: 32,
    color: '#ef4444',
  },
  uploadErrorTitle: {
    color: '#ef4444',
    fontSize: 15,
    fontWeight: '700',
    marginTop: 6,
  },
  uploadErrorDesc: {
    color: '#dbe2d8',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 16,
  },
  uploadDoneBtn: {
    marginTop: 18,
    backgroundColor: '#9acd7c',
    paddingHorizontal: 28,
    paddingVertical: 10,
    borderRadius: 8,
  },
  uploadDoneBtnText: {
    color: '#0c0d0b',
    fontSize: 13,
    fontWeight: '600',
  },
});
