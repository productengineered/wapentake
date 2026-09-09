import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'dist/**', '.test-output/**', '.git/**'] },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: {
      'no-undef': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error',
      'no-unreachable': 'error', 'no-constant-condition': ['error', { checkLoops: false }],
      'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error',
      'valid-typeof': 'error', 'constructor-super': 'error', 'no-async-promise-executor': 'error',
    },
  },
  { files: ['web/app.js', 'tests/browser-smoke.mjs'], languageOptions: { globals: globals.browser } },
];
