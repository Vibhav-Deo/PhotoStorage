import * as MediaLibrary from 'expo-media-library/legacy';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
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
const PADDING = 18;
const GAP = 3;
const ITEM_SIZE = Math.floor((SCREEN_WIDTH - PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

export interface DevicePhoto {
  readonly id: string;
  readonly uri: string;
  readonly filename?: string;
  readonly mediaType?: string;
  readonly creationTime?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface DevicePhotoGridProps {
  readonly searchQuery?: string;
  readonly isSelectMode?: boolean;
  readonly selectedIds?: Set<string>;
  readonly onToggleSelect?: (asset: DevicePhoto) => void;
  readonly backedUpIds?: Set<string>;
  readonly onAssetsLoaded?: (assets: DevicePhoto[]) => void;
}

export function DevicePhotoGrid({
  searchQuery = '',
  isSelectMode = false,
  selectedIds = new Set(),
  onToggleSelect,
  backedUpIds = new Set(),
  onAssetsLoaded,
}: DevicePhotoGridProps): React.ReactElement {
  const [assets, setAssets] = useState<DevicePhoto[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<DevicePhoto | null>(null);

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
          mediaType: ['photo', 'video'] as unknown as MediaLibrary.MediaTypeValue[],
          sortBy: ['creationTime'] as unknown as MediaLibrary.SortByType[],
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

  const filteredAssets = searchQuery.trim()
    ? assets.filter(
        (a) =>
          a.filename?.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
          a.mediaType?.toLowerCase().includes(searchQuery.toLowerCase().trim()),
      )
    : assets;

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
        renderItem={({ item }) => {
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
                  setSelectedAsset(item);
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

              {/* S3 Backed Up Status Badge */}
              {isBackedUp && (
                <View style={styles.backedUpBadge}>
                  <Text style={styles.backedUpBadgeText}>☁️ S3</Text>
                </View>
              )}

              {/* Selection Checkbox */}
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

      {/* Full preview modal */}
      {selectedAsset && (
        <Modal
          visible={Boolean(selectedAsset)}
          transparent
          animationType="fade"
          onRequestClose={() => setSelectedAsset(null)}
        >
          <View style={styles.modalOverlay}>
            <TouchableOpacity
              style={styles.modalCloseButton}
              onPress={() => setSelectedAsset(null)}
            >
              <Text style={styles.modalCloseText}>✕ Close</Text>
            </TouchableOpacity>

            <View style={styles.modalImageContainer}>
              <Image
                source={{ uri: selectedAsset.uri }}
                style={styles.modalImage}
                contentFit="contain"
                transition={200}
              />
            </View>

            <View style={styles.modalFooter}>
              <View style={styles.modalMetaRow}>
                <Text style={styles.modalTitle} numberOfLines={1}>
                  {selectedAsset.filename ?? 'Photo'}
                </Text>
                {backedUpIds.has(selectedAsset.id) ? (
                  <View style={styles.modalBackedUpPill}>
                    <Text style={styles.modalBackedUpText}>✓ Backed Up to S3</Text>
                  </View>
                ) : (
                  <View style={styles.modalLocalPill}>
                    <Text style={styles.modalLocalText}>Local Device Only</Text>
                  </View>
                )}
              </View>
              {selectedAsset.width && selectedAsset.height ? (
                <Text style={styles.modalSubtitle}>
                  {selectedAsset.width} × {selectedAsset.height} •{' '}
                  {selectedAsset.creationTime
                    ? new Date(selectedAsset.creationTime).toLocaleDateString()
                    : 'Unknown date'}
                </Text>
              ) : null}
            </View>
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
    marginBottom: 12,
  },
  countText: { color: '#98a394', fontSize: 12, fontFamily: 'monospace' },
  refreshLink: { color: '#9acd7c', fontSize: 12, fontWeight: '500' },
  gridContent: { paddingBottom: 40 },
  columnWrapper: { gap: GAP, marginBottom: GAP },
  photoContainer: {
    width: ITEM_SIZE,
    height: ITEM_SIZE,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#1b1d19',
    position: 'relative',
  },
  photoContainerSelected: {
    borderWidth: 2,
    borderColor: '#9acd7c',
  },
  backedUpBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: 'rgba(12, 13, 11, 0.8)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: 'rgba(154, 205, 124, 0.4)',
  },
  backedUpBadgeText: {
    color: '#9acd7c',
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  checkbox: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: '#9acd7c',
  },
  checkboxUnselected: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1.5,
    borderColor: '#f2f4ec',
  },
  checkmark: {
    color: '#10110f',
    fontSize: 12,
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
    backgroundColor: 'rgba(154, 205, 124, 0.15)',
    borderWidth: 1,
    borderColor: '#9acd7c',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  modalBackedUpText: {
    color: '#9acd7c',
    fontSize: 10,
    fontWeight: '600',
  },
  modalLocalPill: {
    backgroundColor: '#1f201d',
    borderWidth: 1,
    borderColor: '#3a3c36',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
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
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'space-between',
    paddingTop: 54,
    paddingBottom: 36,
  },
  modalCloseButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  modalCloseText: {
    color: '#f2f4ec',
    fontSize: 14,
    fontWeight: '600',
  },
  modalImageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalImage: {
    width: '100%',
    height: '100%',
  },
  modalFooter: {
    paddingHorizontal: 20,
    paddingTop: 12,
    alignItems: 'center',
  },
  modalTitle: {
    color: '#f2f4ec',
    fontSize: 13,
    fontWeight: '500',
  },
  modalSubtitle: {
    color: '#98a394',
    fontSize: 11,
    marginTop: 4,
    fontFamily: 'monospace',
  },
});

