/**
 * Timeline grid — `FlashList` with fixed cell geometry, reading only from local SQLite.
 *
 * Never fetches originals or previews during scroll — only thumbhashes (local) and
 * 256 px thumbnails (S3 via MediaUrlProvider). This is what keeps the storage class
 * choice and cost model intact (design: access tiers by intent).
 *
 * Requirements: 4.1, 4.3
 */

import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Dimensions, StyleSheet, TouchableOpacity, View } from 'react-native';
import type { SqlDriver } from '@photo-archive/core';
import { thumbKey } from '@photo-archive/core';
import { ThumbhashPlaceholder } from './ThumbhashPlaceholder.tsx';
import type { MediaUrlProvider } from './mediaUrlProvider.ts';

const COLUMNS = 3;
const CELL_SIZE = Math.floor(Dimensions.get('window').width / COLUMNS);
const PAGE_SIZE = 150;

export interface TimelineAsset {
  readonly hash: string;
  readonly thumbhash: Uint8Array;
  readonly capturedAt: number;
}

interface TimelineGridProps {
  readonly driver: SqlDriver;
  readonly urlProvider: MediaUrlProvider;
  readonly tenantPrefix: string;
  readonly onAssetPress?: (hash: string) => void;
}

async function loadPage(driver: SqlDriver, offset: number): Promise<TimelineAsset[]> {
  const rows = await driver.all<{
    hash: string;
    thumbhash: Uint8Array;
    captured_at: number;
  }>(
    `SELECT hash, thumbhash, captured_at FROM assets
     WHERE deleted_at IS NULL ORDER BY captured_at DESC LIMIT ? OFFSET ?`,
    [PAGE_SIZE, offset],
  );
  return rows.map((r) => ({ hash: r.hash, thumbhash: r.thumbhash, capturedAt: r.captured_at }));
}

function GridCell({
  asset,
  urlProvider,
  tenantPrefix,
  onPress,
}: {
  asset: TimelineAsset;
  urlProvider: MediaUrlProvider;
  tenantPrefix: string;
  // `| undefined` explicitly: with exactOptionalPropertyTypes the parent passes
  // a possibly-undefined value as this prop, which a bare `?` would reject.
  onPress?: ((hash: string) => void) | undefined;
}): React.ReactElement {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    const key = thumbKey(tenantPrefix, asset.hash);
    urlProvider
      .urlsFor([key])
      .then((urls) => {
        const u = urls.get(key);
        if (u) setThumbUrl(u);
      })
      .catch(() => {
        /* thumbhash placeholder stays */
      });
  }, [asset.hash, tenantPrefix, urlProvider]);

  return (
    <TouchableOpacity
      style={styles.cell}
      onPress={() => onPress?.(asset.hash)}
      activeOpacity={0.85}
    >
      <ThumbhashPlaceholder thumbhash={asset.thumbhash} style={StyleSheet.absoluteFill} />
      {thumbUrl && (
        <Image
          source={{ uri: thumbUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
          cachePolicy="disk"
        />
      )}
    </TouchableOpacity>
  );
}

export function TimelineGrid({
  driver,
  urlProvider,
  tenantPrefix,
  onAssetPress,
}: TimelineGridProps): React.ReactElement {
  const [assets, setAssets] = useState<TimelineAsset[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    loadPage(driver, 0)
      .then((page) => {
        setAssets(page);
        setOffset(page.length);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch(console.error);
  }, [driver]);

  const loadMore = useCallback(() => {
    if (!hasMore) return;
    loadPage(driver, offset)
      .then((page) => {
        setAssets((prev) => [...prev, ...page]);
        setOffset((prev) => prev + page.length);
        setHasMore(page.length === PAGE_SIZE);
      })
      .catch(console.error);
  }, [driver, offset, hasMore]);

  const renderItem = useCallback(
    ({ item }: { item: TimelineAsset }) => (
      <GridCell
        asset={item}
        urlProvider={urlProvider}
        tenantPrefix={tenantPrefix}
        onPress={onAssetPress}
      />
    ),
    [urlProvider, tenantPrefix, onAssetPress],
  );

  return (
    <View style={styles.container}>
      <FlashList
        data={assets}
        renderItem={renderItem}
        numColumns={COLUMNS}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        keyExtractor={(item) => item.hash}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  cell: { width: CELL_SIZE, height: CELL_SIZE },
});
