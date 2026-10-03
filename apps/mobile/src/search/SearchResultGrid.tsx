/**
 * Search Result Grid — ranked FlashList display for multimodal search results (Task 6.6).
 *
 * Displays items strictly in descending relevance order from vector/OCR fusion.
 * Renders thumbnail and thumbhash placeholder while offline or scrolling.
 *
 * Requirements: 5.3, 5.7
 */

import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { Dimensions, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { thumbKey } from '@photo-archive/core';
import { ThumbhashPlaceholder } from '../browse/ThumbhashPlaceholder.tsx';
import type { MediaUrlProvider } from '../browse/mediaUrlProvider.ts';

const COLUMNS = 3;
const CELL_SIZE = Math.floor(Dimensions.get('window').width / COLUMNS);

export interface SearchResultItem {
  readonly hash: string;
  readonly thumbhash: Uint8Array;
  readonly score: number;
  readonly rank: number;
}

interface SearchResultGridProps {
  readonly results: readonly SearchResultItem[];
  readonly urlProvider: MediaUrlProvider;
  readonly tenantPrefix: string;
  readonly onAssetPress?: (hash: string) => void;
}

function ResultCell({
  item,
  urlProvider,
  tenantPrefix,
  onPress,
}: {
  item: SearchResultItem;
  urlProvider: MediaUrlProvider;
  tenantPrefix: string;
  onPress: ((hash: string) => void) | undefined;
}): React.ReactElement {
  const [uri, setUri] = useState<string>('');

  useEffect(() => {
    let active = true;
    const key = thumbKey(tenantPrefix, item.hash);
    urlProvider
      .urlsFor([key])
      .then((map) => {
        if (active) {
          const resolved = map.get(key);
          if (resolved) setUri(resolved);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [urlProvider, tenantPrefix, item.hash]);

  const handlePress = useCallback(() => {
    onPress?.(item.hash);
  }, [onPress, item.hash]);

  return (
    <TouchableOpacity
      activeOpacity={0.8}
      onPress={handlePress}
      style={styles.cell}
    >
      <View style={StyleSheet.absoluteFill}>
        <ThumbhashPlaceholder thumbhash={item.thumbhash} />
      </View>
      {uri ? (
        <Image
          contentFit="cover"
          recyclingKey={item.hash}
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          transition={100}
        />
      ) : null}
      <View style={styles.rankBadge}>
        <Text style={styles.rankText}>#{item.rank}</Text>
      </View>
      <View style={styles.scoreBadge}>
        <Text style={styles.scoreText}>{(item.score * 100).toFixed(0)}%</Text>
      </View>
    </TouchableOpacity>
  );
}

export function SearchResultGrid({
  results,
  urlProvider,
  tenantPrefix,
  onAssetPress,
}: SearchResultGridProps): React.ReactElement {
  const renderItem = useCallback(
    ({ item }: { item: SearchResultItem }) => (
      <ResultCell
        item={item}
        onPress={onAssetPress}
        tenantPrefix={tenantPrefix}
        urlProvider={urlProvider}
      />
    ),
    [onAssetPress, tenantPrefix, urlProvider],
  );

  const keyExtractor = useCallback((item: SearchResultItem) => item.hash, []);

  if (results.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No matching photos or videos found.</Text>
        <Text style={styles.emptySubtext}>Try adjusting search terms or filters.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={results as SearchResultItem[]}
        keyExtractor={keyExtractor}
        numColumns={COLUMNS}
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  cell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    padding: 1,
    position: 'relative',
  },
  rankBadge: {
    position: 'absolute',
    top: 4,
    left: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  rankText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  scoreBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  scoreText: {
    color: '#34d399',
    fontSize: 10,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#000',
  },
  emptyText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtext: {
    color: '#888',
    fontSize: 14,
  },
});
