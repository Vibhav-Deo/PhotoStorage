import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * One root config for the whole monorepo. Workspaces that need a different
 * environment (apps/mobile will need a React Native one) get their own config
 * and are added to `projects` at that point — not before.
 *
 * `spikes/` is throwaway Phase 0 code with its own dependency trees and is
 * excluded here as well as from the workspace globs.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@photo-archive/core/node-sqlite': path.resolve(__dirname, 'packages/core/src/db/nodeSqliteDriver.ts'),
      '@photo-archive/core/local-fs-store': path.resolve(__dirname, 'packages/core/src/store/localFsObjectStore.ts'),
      '@photo-archive/core/s3-store': path.resolve(__dirname, 'packages/core/src/store/s3ObjectStore.ts'),
      '@photo-archive/core/node-hash': path.resolve(__dirname, 'packages/core/src/hash/nodeHash.ts'),
      '@photo-archive/core/store-conformance': path.resolve(__dirname, 'packages/core/src/store/conformance.ts'),
      '@photo-archive/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
  test: {
    include: ['{packages,apps,infra,scripts}/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
  },
});
