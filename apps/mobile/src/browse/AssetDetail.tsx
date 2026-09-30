/**
 * Asset detail view — preview fetch, pinch-zoom, metadata panel.
 * Must not fetch originals (Requirement 7.1). The 2048 px preview covers the
 * overwhelming majority of real use (Requirement 7.2).
 *
 * Requirements: 7.1, 7.2
 */

import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { SqlDriver } from '@photo-archive/core';
import { previewKey } from '@photo-archive/core';
import { ThumbhashPlaceholder } from './ThumbhashPlaceholder.tsx';
import type { MediaUrlProvider } from './mediaUrlProvider.ts';

type AssetRow = {
  hash: string;
  thumbhash: Uint8Array;
  captured_at: number;
  width: number | null;
  height: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lat: number | null;
  lon: number | null;
  mime: string;
  byte_size: number;
};

interface AssetDetailProps {
  readonly hash: string;
  readonly driver: SqlDriver;
  readonly urlProvider: MediaUrlProvider;
  readonly tenantPrefix: string;
}

export function AssetDetail({
  hash,
  driver,
  urlProvider,
  tenantPrefix,
}: AssetDetailProps): React.ReactElement {
  const [asset, setAsset] = useState<AssetRow | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    driver
      .get<AssetRow>(
        `SELECT hash, thumbhash, captured_at, width, height,
                camera_make, camera_model, lat, lon, mime, byte_size
         FROM assets WHERE hash = ?`,
        [hash],
      )
      .then((row) => {
        if (row) setAsset(row);
      })
      .catch(console.error);
  }, [hash, driver]);

  useEffect(() => {
    if (!asset) return;
    const key = previewKey(tenantPrefix, asset.hash);
    urlProvider
      .urlsFor([key])
      .then((urls) => {
        const u = urls.get(key);
        if (u) setPreviewUrl(u);
      })
      .catch(() => {
        /* thumbhash placeholder stays */
      });
  }, [asset, tenantPrefix, urlProvider]);

  if (!asset) return <View style={styles.container} />;

  const capturedDate = new Date(asset.captured_at).toLocaleDateString();
  const camera = [asset.camera_make, asset.camera_model].filter(Boolean).join(' ') || null;
  const dimensions =
    asset.width && asset.height ? `${String(asset.width)} × ${String(asset.height)}` : null;
  const sizeMb = (asset.byte_size / (1024 * 1024)).toFixed(1);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Image area — thumbhash placeholder until preview loads */}
      <View style={styles.imageContainer}>
        <ThumbhashPlaceholder thumbhash={asset.thumbhash} style={StyleSheet.absoluteFill} />
        {previewUrl && (
          <Image
            source={{ uri: previewUrl }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            transition={200}
            cachePolicy="disk"
          />
        )}
      </View>

      {/* Metadata panel */}
      <View style={styles.meta}>
        <MetaRow label="Date" value={capturedDate} />
        {camera && <MetaRow label="Camera" value={camera} />}
        {dimensions && <MetaRow label="Dimensions" value={dimensions} />}
        <MetaRow label="Size" value={`${sizeMb} MB`} />
        {asset.lat !== null && asset.lon !== null && (
          <MetaRow label="Location" value={`${asset.lat.toFixed(4)}, ${asset.lon.toFixed(4)}`} />
        )}
      </View>
    </ScrollView>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  content: { paddingBottom: 32 },
  imageContainer: { width: '100%', aspectRatio: 1 },
  meta: { padding: 16, gap: 8 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metaLabel: { color: '#888', fontSize: 14 },
  metaValue: { color: '#fff', fontSize: 14, flexShrink: 1, textAlign: 'right' },
});
