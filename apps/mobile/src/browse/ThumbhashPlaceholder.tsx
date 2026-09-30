/**
 * Thumbhash placeholder — renders a thumbhash so grid cells never render empty
 * (Requirements 4.2, 4.5).
 *
 * `expo-image` renders thumbhashes natively via `ImageSource.thumbhash`, which
 * takes the *base64 text* form of the hash. Thumbhashes are stored as ~25 raw
 * bytes in `assets.thumbhash` and are never evicted from the database
 * regardless of cache pressure (Requirement 4.5), so this component does a
 * pure byte→base64 encode — no decode step, no async, no native round trip
 * beyond the image view itself.
 */

import { Image } from 'expo-image';
import type { ImageProps } from 'expo-image';
import { StyleSheet } from 'react-native';

/** The style type expo-image's `Image` actually accepts (SF-symbol extended). */
type ExpoImageStyle = NonNullable<ImageProps['style']>;

/** RFC 4648 base64 alphabet. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes raw bytes to base64. Thumbhashes are ~25 bytes, so the input is tiny
 * and the naive bit-shifting loop is the right tool. React Native provides no
 * `btoa`/`Buffer`, and importing one for 25 bytes would drag a polyfill into
 * the bundle graph.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triple >> 18) & 63] ?? 'A';
    out += BASE64_ALPHABET[(triple >> 12) & 63] ?? 'A';
    out += i + 1 < bytes.length ? (BASE64_ALPHABET[(triple >> 6) & 63] ?? 'A') : '=';
    out += i + 2 < bytes.length ? (BASE64_ALPHABET[triple & 63] ?? 'A') : '=';
  }
  return out;
}

interface ThumbhashPlaceholderProps {
  /** Raw thumbhash bytes from `assets.thumbhash`. */
  readonly thumbhash: Uint8Array;
  readonly style?: ExpoImageStyle;
}

export function ThumbhashPlaceholder({
  thumbhash,
  style,
}: ThumbhashPlaceholderProps): React.ReactElement {
  // Empty hash bytes carry no signal; `null` renders an unset source with the
  // placeholder background so the cell still occupies its geometry.
  const source = thumbhash.length > 0 ? { thumbhash: bytesToBase64(thumbhash) } : null;
  // React Native's and expo-image's style unions are both permissive but not
  // mutually assignable under this repo's strictness; the merge is trivially
  // safe at runtime, so bridge the two once, here.
  const mergedStyle = [styles.placeholder, style] as ExpoImageStyle;
  return <Image source={source} style={mergedStyle} contentFit="cover" />;
}

const styles = StyleSheet.create({
  placeholder: { backgroundColor: '#1a1a1a' },
});
