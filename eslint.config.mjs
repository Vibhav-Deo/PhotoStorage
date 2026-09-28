import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // Throwaway Phase 0 code. Kept for the record, not held to project conventions.
      'spikes/**',
      // Spec documents.
      '.kiro/**',
      // Generated compliance output.
      'packages/importer/THIRD_PARTY_NOTICES.txt',
      'apps/mobile/assets/third-party-notices.json',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async correctness matters more here than usual: ingest, upload, and
      // verification are all long-running async pipelines where a dropped
      // promise is a silently lost job.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Unused variables are an error, but `_`-prefixed ones are intentional.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Type-only imports must say so; `verbatimModuleSyntax` depends on it.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Config files are plain JS and are not part of any TS project.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
