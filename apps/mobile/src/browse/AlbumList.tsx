/**
 * Album browsing — reads only from local SQLite (Requirements 3.5, 4.6).
 * Membership is by reference so an asset in many albums is stored once.
 *
 * Requirements: 3.5, 4.6
 */

import { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity } from 'react-native';
import type { SqlDriver } from '@photo-archive/core';

export interface AlbumSummary {
  readonly id: string;
  readonly title: string;
  readonly assetCount: number;
}

interface AlbumListProps {
  readonly driver: SqlDriver;
  readonly onAlbumPress?: (albumId: string) => void;
}

async function loadAlbums(driver: SqlDriver): Promise<AlbumSummary[]> {
  const rows = await driver.all<{ id: string; title: string; asset_count: number }>(
    `SELECT a.id, a.title, COUNT(m.hash) as asset_count
     FROM albums a
     LEFT JOIN album_members m ON m.album_id = a.id
     WHERE a.deleted_at IS NULL
     GROUP BY a.id
     ORDER BY a.title ASC`,
  );
  return rows.map((r) => ({ id: r.id, title: r.title, assetCount: r.asset_count }));
}

export function AlbumList({ driver, onAlbumPress }: AlbumListProps): React.ReactElement {
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);

  useEffect(() => {
    loadAlbums(driver).then(setAlbums).catch(console.error);
  }, [driver]);

  return (
    <FlatList
      data={albums}
      keyExtractor={(item) => item.id}
      style={styles.list}
      renderItem={({ item }) => (
        <TouchableOpacity style={styles.row} onPress={() => onAlbumPress?.(item.id)}>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.count}>{String(item.assetCount)}</Text>
        </TouchableOpacity>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#000' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  title: { color: '#fff', fontSize: 16 },
  count: { color: '#888', fontSize: 14 },
});
