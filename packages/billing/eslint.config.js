const js = require('@eslint/js');
const typescript = require('typescript-eslint');

module.exports = [
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    files: ['src/**/*.ts', 'scripts/**/*.mts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
    },
  },
  { ignores: ['dist/', 'node_modules/', '*.config.js'] },
];
