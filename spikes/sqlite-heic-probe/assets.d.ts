/**
 * Metro resolves an asset import to a numeric module reference, which is what
 * `Asset.fromModule` takes. React Native ships no ambient declaration for either
 * extension, so they are declared here.
 *
 * Deliberately narrow rather than pulling in `expo/types`, whose
 * `react-native-web` augmentation redefines the style prop types and collides with
 * `react-native`'s own.
 */

declare module '*.heic' {
  const assetRef: number;
  export default assetRef;
}

declare module '*.jpg' {
  const assetRef: number;
  export default assetRef;
}
