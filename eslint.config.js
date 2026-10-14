// @ts-check
// ESLint flat config for the package source, tests and build config.
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const restrictedImports = [
  'node:*',
  'fs',
  'path',
  'os',
  'child_process',
  'bun',
  'bun:*',
];

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', '.changeset/'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Allow intentionally unused parameters and destructured values when prefixed with _.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Everything in src/ is library code: no Node built-ins, no Bun.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: restrictedImports,
              message: 'src/ must run in Node, Bun and browsers unchanged.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'No Bun.* globals in src/.' },
        {
          name: 'process',
          message: 'No process in src/; take options instead.',
        },
        { name: 'Buffer', message: 'Use Uint8Array in src/.' },
        { name: 'require', message: 'Use ES imports in src/.' },
      ],
    },
  },
  {
    // The library is runtime-neutral: no DOM either.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: restrictedImports,
              message: 'src must run in Node, Bun and browsers unchanged.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'No Bun.* globals in src.' },
        { name: 'process', message: 'No process in src.' },
        { name: 'Buffer', message: 'Use Uint8Array in src.' },
        { name: 'require', message: 'Use ES imports in src.' },
        { name: 'window', message: 'No DOM in src.' },
        { name: 'document', message: 'No DOM in src.' },
        { name: 'fetch', message: 'src never fetches; take data in.' },
        {
          name: 'localStorage',
          message: 'Persistence goes through a StorageAdapter.',
        },
        {
          name: 'sessionStorage',
          message: 'Persistence goes through a StorageAdapter.',
        },
      ],
    },
  },
  {
    // The one file in src/ that may import a file system module.
    files: ['src/file/node.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['test/**/*.ts', '*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
  }
);
