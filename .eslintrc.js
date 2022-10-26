module.exports = {
  env: {
    node: true,
    es6: true
  },
  root: true,
  extends: [
    'plugin:@coorpacademy/coorpacademy/core',
    'plugin:@coorpacademy/coorpacademy/es20XX',
    'plugin:@coorpacademy/coorpacademy/prettier',
    'plugin:@coorpacademy/coorpacademy/lodash-fp'
  ],
  parserOptions: {
    ecmaVersion: 2020,
    allowImportExportEverywhere: true
  },
  plugins: ['@coorpacademy/coorpacademy'],
  settings: {},
  rules: {
    'fp/no-class': 'off',
    'import/dynamic-import-chunkname': 'off',
    'import/no-extraneous-dependencies': 'off',
    'import/no-unresolved': 'off',
    'no-console': 'off',
    'no-param-reassign': 'off',
    'node/no-extraneous-require': [
      'error',
      {allowModules: ['ava', 'aws-sdk', '@serverless/utils']}
    ],
    'node/no-missing-import': 'off',
    'node/no-missing-require': 'off',
    'node/no-unsupported-features/es-syntax': [
      'error',
      {version: '>=16.0.0', ignores: ['dynamicImport']}
    ],
    'promise/no-native': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/no-await-expression-member': 'off',
    'unicorn/no-unreadable-array-destructuring': 'off'
  },
  overrides: [
    {
      files: ['packages/**/.*/**/*.test.js', 'packages/**/*.test.js'],
      rules: {
        'import/no-extraneous-dependencies': 'off'
      }
    },
    {
      files: ['ava.config.js'],
      rules: {
        'node/no-unsupported-features/es-syntax': 'off'
      }
    }
  ]
};
