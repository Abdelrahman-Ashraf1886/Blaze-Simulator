import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'simulation-engine/target/**', 'test-results/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // ADR 0008: the domain modules are pure. No UI, rendering, state stores, IPC or
    // Node APIs; IPC types only, so main, the renderer and Node tests share them.
    files: ['src/domain/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: ['react', 'react-dom', 'three', 'zustand', 'electron', 'better-sqlite3', 'zod'].map((name) => ({
            name,
            message: 'src/domain is pure (ADR 0008): no UI, rendering, stores, validation, Electron or Node APIs.',
          })),
          patterns: [
            { group: ['react-dom/*', 'react/*', '@react-three/*', 'three/*', '@xyflow/*', 'zustand/*', 'node:*'], message: 'src/domain is pure (ADR 0008): no UI, rendering, stores, Electron or Node APIs.' },
            { group: ['@/*', '../features/*', '../stores/*', '../services/*', '../three/*', '../components/*', '../app/*', '**/electron/main/**', '**/electron/preload/**'], message: 'src/domain may import only other domain modules and IPC types (ADR 0008).' },
            { group: ['**/electron/ipc/*'], allowTypeImports: true, message: 'Import IPC types only (import type) in src/domain (ADR 0008).' },
          ],
        },
      ],
    },
  },
  {
    files: ['electron/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // Build scripts run in Node but evaluate small snippets inside an Electron page.
    files: ['scripts/**/*.{mjs,cjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
)
