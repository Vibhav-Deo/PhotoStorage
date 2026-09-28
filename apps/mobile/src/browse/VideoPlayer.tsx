/**
 * Video player — plays the 720p faststart MP4 derivative.
 * Range requests are handled natively by expo-video's underlying AVPlayer / ExoPlayer.
 * Never fetches the original (Requirement 7.1).
 *
 * Requirements: 7.1
 */

import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import type { ViewStyle } from 'react-native';
import { videoKey } from '@photo-archive/core';
import type { MediaUrlProvider } from './mediaUrlProvider.ts';
import { useState } from 'react';

interface VideoPlayerProps {
  readonly hash: string;
  readonly urlProvider: MediaUrlProvider;
  readonly tenantPrefix: string;
}

export function VideoPlayer({
  hash,
  urlProvider,
  tenantPrefix,
}: VideoPlayerProps): React.ReactElement {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    const key = videoKey(tenantPrefix, hash);
    urlProvider
      .urlsFor([key])
      .then((urls) => {
        const u = urls.get(key);
        if (u) setVideoUrl(u);
      })
      .catch(console.error);
  }, [hash, tenantPrefix, urlProvider]);

  const player = useVideoPlayer(videoUrl ?? '', (p) => {
    p.loop = false;
  });

  return (
    <View style={styles.container}>
      <VideoView player={player} style={styles.video} contentFit="contain" nativeControls />
    </View>
  );
}

const styles = StyleSheet.create<{ container: ViewStyle; video: ViewStyle }>({
  container: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  video: { width: '100%', aspectRatio: 16 / 9 },
});
