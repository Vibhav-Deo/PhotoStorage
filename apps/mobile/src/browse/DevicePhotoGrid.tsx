import * as MediaLibrary from 'expo-media-library/legacy';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

const SCREEN_WIDTH = Dimensions.get('window').width;
const COLUMNS = 3;
const GAP = 2;
const ITEM_SIZE = Math.floor((SCREEN_WIDTH - GAP * (COLUMNS - 1)) / COLUMNS);

export interface DevicePhoto {
  readonly id: string;
  readonly uri: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly creationTime?: number;
  readonly width?: number;
  readonly height?: number;
}

export const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];
const MONTH_SHORTS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'
];

interface DevicePhotoGridProps {
  readonly searchQuery?: string;
  readonly isSelectMode?: boolean;
  readonly selectedIds?: Set<string>;
  readonly onToggleSelect?: (asset: DevicePhoto) => void;
  readonly backedUpIds?: Set<string>;
  readonly onAssetsLoaded?: (assets: DevicePhoto[]) => void;
  readonly onUploadSingleAsset?: (asset: DevicePhoto) => void;
  readonly onReclaimSingleAsset?: (asset: DevicePhoto) => void;
}

export function DevicePhotoGrid({
  searchQuery = '',
  isSelectMode = false,
  selectedIds = new Set(),
  onToggleSelect,
  backedUpIds = new Set(),
  onAssetsLoaded,
  onUploadSingleAsset,
  onReclaimSingleAsset,
}: DevicePhotoGridProps): React.ReactElement {
  const [assets, setAssets] = useState<DevicePhoto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showInfoSheet, setShowInfoSheet] = useState(false);

  const checkAndLoadPhotos = useCallback(async (): Promise<void> => {
    try {
      setPermissionError(null);
      
      // Check existing permissions first
      let permission = await MediaLibrary.getPermissionsAsync();
      
      let hasAccess =
        permission.granted ||
        permission.status === 'granted' ||
        (permission as { accessPrivileges?: string }).accessPrivileges === 'all' ||
        (permission as { accessPrivileges?: string }).accessPrivileges === 'limited';

      // Request permissions if not yet granted
      if (!hasAccess && permission.canAskAgain) {
        permission = await MediaLibrary.requestPermissionsAsync();
        hasAccess =
          permission.granted ||
          permission.status === 'granted' ||
          (permission as { accessPrivileges?: string }).accessPrivileges === 'all' ||
          (permission as { accessPrivileges?: string }).accessPrivileges === 'limited';
      }

      if (!hasAccess) {
        setPermissionError('Photo library access is required to view your device photos.');
        setIsLoading(false);
        setIsRefreshing(false);
        return;
      }

      // Query media library safely without referencing unexported runtime enum objects
      let result: MediaLibrary.PagedInfo<MediaLibrary.Asset>;
      try {
        result = await MediaLibrary.getAssetsAsync({
          first: 150,
          mediaType: ['photo', 'video'] as any,
          sortBy: ['creationTime'] as any,
        });
      } catch {
        result = await MediaLibrary.getAssetsAsync({
          first: 150,
        });
      }

      if (result?.assets) {
        const loaded = result.assets.map((a) => ({
          id: a.id,
          uri: a.uri,
          filename: a.filename,
          mediaType: a.mediaType,
          creationTime: a.creationTime,
          width: a.width,
          height: a.height,
        }));
        setAssets(loaded);
        onAssetsLoaded?.(loaded);
      }
    } catch (err: unknown) {
      console.warn('Failed to load device photos:', err);
      setPermissionError(
        err instanceof Error ? err.message : 'Unable to load photos from device library.',
      );
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [onAssetsLoaded]);

  useEffect(() => {
    void checkAndLoadPhotos();
  }, [checkAndLoadPhotos]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void checkAndLoadPhotos();
  }, [checkAndLoadPhotos]);

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return assets;

    const terms = q.split(/\s+/).filter(Boolean);

    return assets.filter((asset) => {
      const filename = (asset.filename ?? '').toLowerCase();
      const isVideo =
        asset.mediaType === 'video' ||
        filename.endsWith('.mp4') ||
        filename.endsWith('.mov');
      const isPhoto = asset.mediaType === 'photo' || !isVideo;
      const ext = filename.split('.').pop() ?? '';

      // Date / Month / Year
      let dateString = '';
      if (asset.creationTime) {
        const d = new Date(asset.creationTime);
        const year = String(d.getFullYear());
        const monthIdx = d.getMonth();
        const monthLong = MONTH_NAMES[monthIdx] ?? '';
        const monthShort = MONTH_SHORTS[monthIdx] ?? '';
        const day = String(d.getDate());
        dateString = `${year} ${monthLong} ${monthShort} ${day} ${monthIdx + 1}/${day}/${year}`;
      }

      const isBackedUp = backedUpIds.has(asset.id);
      const cloudStatus = isBackedUp
        ? 'backed up cloud s3 synced archive'
        : 'local device pending unbacked';

      return terms.every((term) => {
        if (term === 'photo' || term === 'photos' || term === 'image' || term === 'images') {
          return isPhoto;
        }
        if (
          term === 'video' ||
          term === 'videos' ||
          term === 'movie' ||
          term === 'movies' ||
          term === 'clip'
        ) {
          return isVideo;
        }
        if (term === 'cloud' || term === 'backed' || term === 'synced' || term === 's3' || term === 'archived') {
          return isBackedUp;
        }
        if (term === 'local' || term === 'device' || term === 'unbacked' || term === 'pending') {
          return !isBackedUp;
        }

        return (
          filename.includes(term) ||
          ext.includes(term) ||
          dateString.includes(term) ||
          cloudStatus.includes(term)
        );
      });
    });
  }, [assets, searchQuery, backedUpIds]);

  if (isLoading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="small" color="#9acd7c" />
        <Text style={styles.loadingText}>Reading device photo library...</Text>
      </View>
    );
  }

  if (permissionError) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>Photo Access Needed</Text>
        <Text style={styles.emptyText}>{permissionError}</Text>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => {
            void MediaLibrary.requestPermissionsAsync().then((res) => {
              if (
                res.granted ||
                res.status === 'granted' ||
                (res as { accessPrivileges?: string }).accessPrivileges === 'limited'
              ) {
                void checkAndLoadPhotos();
              } else {
                void Linking.openSettings();
              }
            });
          }}
        >
          <Text style={styles.actionButtonText}>Grant Permissions</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (filteredAssets.length === 0) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyTitle}>
          {searchQuery ? 'No Matching Photos' : 'No Photos Found'}
        </Text>
        <Text style={styles.emptyText}>
          {searchQuery
            ? `No media matches "${searchQuery}".`
            : 'No photos or videos were detected in your device library.'}
        </Text>
        <TouchableOpacity style={styles.secondaryButton} onPress={handleRefresh}>
          <Text style={styles.secondaryButtonText}>Refresh</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.listContainer}>
      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {filteredAssets.length} items on device • {backedUpIds.size} backed up to S3
        </Text>
        <TouchableOpacity onPress={handleRefresh} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={styles.refreshLink}>Refresh</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={filteredAssets}
        numColumns={COLUMNS}
        keyExtractor={(item) => item.id}
        refreshing={isRefreshing}
        onRefresh={handleRefresh}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.gridContent}
        columnWrapperStyle={styles.columnWrapper}
        renderItem={({ item, index }) => {
          const isSelected = selectedIds.has(item.id);
          const isBackedUp = backedUpIds.has(item.id);

          return (
            <TouchableOpacity
              activeOpacity={0.8}
              style={[
                styles.photoContainer,
                isSelected && styles.photoContainerSelected,
              ]}
              onPress={() => {
                if (isSelectMode) {
                  onToggleSelect?.(item);
                } else {
                  setSelectedIndex(index);
                }
              }}
            >
              <Image
                source={{ uri: item.uri }}
                style={styles.photo}
                contentFit="cover"
                transition={150}
                cachePolicy="memory-disk"
              />

              {/* Subtle pending backup indicator only if not yet backed up, exactly like Google/Apple Photos */}
              {!isBackedUp && (
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeIcon}>☁️</Text>
                </View>
              )}

              {/* Apple Photos Style Selection Checkbox */}
              {isSelectMode && (
                <View
                  style={[
                    styles.checkbox,
                    isSelected ? styles.checkboxSelected : styles.checkboxUnselected,
                  ]}
                >
                  {isSelected && <Text style={styles.checkmark}>✓</Text>}
                </View>
              )}

              {/* Video Badge */}
              {item.mediaType === 'video' && (
                <View style={styles.videoBadge}>
                  <Text style={styles.videoBadgeText}>VIDEO</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        }}
      />

      {/* ── Native Fullscreen Media Viewer ───────────────────────── */}
      {selectedIndex !== null && filteredAssets[selectedIndex] && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => {
            setSelectedIndex(null);
            setShowInfoSheet(false);
          }}
        >
          <View style={styles.viewerOverlay}>
            {/* Viewer Top Bar */}
            <View style={styles.viewerTopBar}>
              <TouchableOpacity
                style={styles.viewerCloseBtn}
                onPress={() => {
                  setSelectedIndex(null);
                  setShowInfoSheet(false);
                }}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.viewerCloseText}>✕ Close</Text>
              </TouchableOpacity>

              <Text style={styles.viewerCounterText}>
                {selectedIndex + 1} of {filteredAssets.length}
              </Text>

              <TouchableOpacity
                style={[
                  styles.viewerInfoBtn,
                  showInfoSheet && styles.viewerInfoBtnActive,
                ]}
                onPress={() => setShowInfoSheet((prev) => !prev)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <Text style={styles.viewerInfoGlyph}>ℹ️</Text>
              </TouchableOpacity>
            </View>

            {/* Viewer Image Canvas with Navigation Arrows */}
            <View style={styles.viewerCanvas}>
              {selectedIndex > 0 && (
                <TouchableOpacity
                  style={[styles.viewerNavArrow, styles.viewerNavArrowLeft]}
                  onPress={() => setSelectedIndex(selectedIndex - 1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                >
                  <Text style={styles.viewerArrowText}>‹</Text>
                </TouchableOpacity>
              )}

              <Image
                source={{ uri: filteredAssets[selectedIndex].uri }}
                style={styles.viewerMainImage}
                contentFit="contain"
                transition={200}
              />

              {selectedIndex < filteredAssets.length - 1 && (
                <TouchableOpacity
                  style={[styles.viewerNavArrow, styles.viewerNavArrowRight]}
                  onPress={() => setSelectedIndex(selectedIndex + 1)}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                >
                  <Text style={styles.viewerArrowText}>›</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Viewer Bottom Action Bar */}
            <View style={styles.viewerBottomBar}>
              {backedUpIds.has(filteredAssets[selectedIndex].id) ? (
                <View style={styles.viewerStatusPill}>
                  <Text style={styles.viewerStatusPillText}>✓ Saved to Cloud S3</Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.viewerBackupActionBtn}
                  onPress={() => {
                    const current = filteredAssets[selectedIndex];
                    if (current) onUploadSingleAsset?.(current);
                  }}
                >
                  <Text style={styles.viewerBackupActionText}>☁️ Back Up This Photo</Text>
                </TouchableOpacity>
              )}

              {backedUpIds.has(filteredAssets[selectedIndex].id) && onReclaimSingleAsset && (
                <TouchableOpacity
                  style={styles.viewerReclaimBtn}
                  onPress={() => {
                    const current = filteredAssets[selectedIndex];
                    if (current) onReclaimSingleAsset(current);
                  }}
                >
                  <Text style={styles.viewerReclaimBtnText}>Free Device Space</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Apple-style EXIF & Cloud Info Sheet */}
            {showInfoSheet && (
              <View style={styles.infoSheetPanel}>
                <View style={styles.infoSheetHeader}>
                  <Text style={styles.infoSheetTitle}>Photo Details</Text>
                  <TouchableOpacity onPress={() => setShowInfoSheet(false)}>
                    <Text style={styles.infoSheetDismiss}>✕</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.infoSheetRow}>
                  <Text style={styles.infoSheetLabel}>File Name</Text>
                  <Text style={styles.infoSheetValue} numberOfLines={1}>
                    {filteredAssets[selectedIndex].filename ?? 'Photo'}
                  </Text>
                </View>

                <View style={styles.infoSheetRow}>
                  <Text style={styles.infoSheetLabel}>Date Captured</Text>
                  <Text style={styles.infoSheetValue}>
                    {filteredAssets[selectedIndex].creationTime
                      ? new Date(filteredAssets[selectedIndex].creationTime).toLocaleString()
                      : 'Unknown'}
                  </Text>
                </View>

                {filteredAssets[selectedIndex].width && filteredAssets[selectedIndex].height ? (
                  <View style={styles.infoSheetRow}>
                    <Text style={styles.infoSheetLabel}>Dimensions</Text>
                    <Text style={styles.infoSheetValue}>
                      {filteredAssets[selectedIndex].width} × {filteredAssets[selectedIndex].height}
                    </Text>
                  </View>
                ) : null}

                <View style={styles.infoSheetRow}>
                  <Text style={styles.infoSheetLabel}>Cloud Archive</Text>
                  <Text
                    style={
                      backedUpIds.has(filteredAssets[selectedIndex].id)
                        ? styles.infoSheetValueGreen
                        : styles.infoSheetValueYellow
                    }
                  >
                    {backedUpIds.has(filteredAssets[selectedIndex].id)
                      ? '✓ Verified in Amazon S3'
                      : 'On Device (Not Uploaded)'}
                  </Text>
                </View>
              </View>
            )}
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  listContainer: { flex: 1 },
  countRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  countText: { color: '#8e8e93', fontSize: 13, fontWeight: '500' },
  refreshLink: { color: '#0a84ff', fontSize: 13, fontWeight: '600' },
  gridContent: { paddingBottom: 60 },
  columnWrapper: { gap: GAP, marginBottom: GAP },
  photoContainer: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    overflow: 'hidden',
    backgroundColor: '#1c1c1e',
    position: 'relative',
  },
  photoContainerSelected: {
    borderWidth: 2,
    borderColor: '#0a84ff',
  },
  pendingBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pendingBadgeIcon: {
    fontSize: 10,
    opacity: 0.9,
  },
  checkbox: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#0a84ff',
  },
  checkboxUnselected: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.85)',
  },
  checkmark: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '800',
  },
  modalMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 8,
  },
  modalBackedUpPill: {
    backgroundColor: 'rgba(10, 132, 255, 0.15)',
    borderWidth: 1,
    borderColor: '#0a84ff',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  modalBackedUpText: {
    color: '#0a84ff',
    fontSize: 11,
    fontWeight: '600',
  },
  modalLocalPill: {
    backgroundColor: '#1c1c1e',
    borderWidth: 1,
    borderColor: '#38383a',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  modalLocalText: {
    color: '#98a394',
    fontSize: 10,
  },
  photo: {
    width: '100%',
    height: '100%',
  },
  videoBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.65)',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 3,
  },
  videoBadgeText: {
    color: '#f2f4ec',
    fontSize: 9,
    fontWeight: '700',
  },
  centerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    color: '#98a394',
    fontSize: 13,
    marginTop: 12,
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
  },
  emptyTitle: {
    color: '#f2f4ec',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyText: {
    color: '#98a394',
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 18,
  },
  actionButton: {
    marginTop: 20,
    backgroundColor: '#9acd7c',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
  },
  actionButtonText: {
    color: '#10110f',
    fontSize: 13,
    fontWeight: '600',
  },
  secondaryButton: {
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2e332b',
  },
  secondaryButtonText: {
    color: '#98a394',
    fontSize: 12,
  },
  // Native Fullscreen Media Viewer Styles
  viewerOverlay: {
    flex: 1,
    backgroundColor: '#000000',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingBottom: 24,
  },
  viewerTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    height: 44,
  },
  viewerCloseBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(28, 28, 30, 0.8)',
    borderRadius: 14,
  },
  viewerCloseText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  viewerCounterText: {
    color: '#8e8e93',
    fontSize: 14,
    fontWeight: '500',
  },
  viewerInfoBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(28, 28, 30, 0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerInfoBtnActive: {
    backgroundColor: '#0a84ff',
  },
  viewerInfoGlyph: {
    fontSize: 16,
  },
  viewerCanvas: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  viewerMainImage: {
    width: '100%',
    height: '100%',
  },
  viewerNavArrow: {
    position: 'absolute',
    top: '50%',
    marginTop: -28,
    width: 44,
    height: 56,
    backgroundColor: 'rgba(28, 28, 30, 0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    borderRadius: 8,
  },
  viewerNavArrowLeft: {
    left: 12,
  },
  viewerNavArrowRight: {
    right: 12,
  },
  viewerArrowText: {
    color: '#ffffff',
    fontSize: 32,
    fontWeight: '300',
    lineHeight: 34,
  },
  viewerBottomBar: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  viewerStatusPill: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    borderWidth: 1,
    borderColor: '#34c759',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
  },
  viewerStatusPillText: {
    color: '#34c759',
    fontSize: 13,
    fontWeight: '600',
  },
  viewerBackupActionBtn: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 18,
  },
  viewerBackupActionText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  viewerReclaimBtn: {
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderWidth: 1,
    borderColor: '#ff453a',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 18,
  },
  viewerReclaimBtnText: {
    color: '#ff453a',
    fontSize: 13,
    fontWeight: '600',
  },
  infoSheetPanel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#38383a',
    gap: 12,
  },
  infoSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  infoSheetTitle: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  infoSheetDismiss: {
    color: '#8e8e93',
    fontSize: 16,
    padding: 4,
  },
  infoSheetRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  infoSheetLabel: {
    color: '#8e8e93',
    fontSize: 13,
  },
  infoSheetValue: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '500',
    maxWidth: 220,
  },
  infoSheetValueGreen: {
    color: '#34c759',
    fontSize: 13,
    fontWeight: '600',
  },
  infoSheetValueYellow: {
    color: '#ff9f0a',
    fontSize: 13,
    fontWeight: '500',
  },
});

