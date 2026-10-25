import js from '@eslint/js';
import ts from 'typescript-eslint';

export default ts.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/next-env.d.ts', '**/dist/**', '**/.expo/**', 'outputs/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', URL: 'readonly', crypto: 'readonly', window: 'readonly', document: 'readonly', localStorage: 'readonly', navigator: 'readonly', FormData: 'readonly', File: 'readonly', Blob: 'readonly', AbortController: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', __dirname: 'readonly', setInterval: 'readonly', clearInterval: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  }
);
