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
    allowImportExportEverywhere: true,
    sourceType: 'module'
  },
  plugins: ['@coorpacademy/coorpacademy'],
  settings: {
    node: {
      allowModules: ['minio']
    }
  },
  rules: {
    'fp/no-class': 'off',
    'no-console': 'off',
    'promise/no-native': 'off',
    'no-param-reassign': 'off',
    'import/no-extraneous-dependencies': 'off',
    'node/no-extraneous-require': [
      'error',
      {
        allowModules: ['ava', 'aws-sdk', '@serverless/utils']
      }
    ],
    'node/no-unsupported-features/es-syntax': [
      'error',
      {
        version: '>=16.0.0',
        ignores: ['modules']
      }
    ],
    'unicorn/no-unreadable-array-destructuring': 'off',
    'unicorn/consistent-function-scoping': 'off'
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
