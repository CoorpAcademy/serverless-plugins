const path = require('path');
// eslint-disable-next-line import/no-unresolved
const slsw = require('serverless-webpack');

module.exports = {
  entry: slsw.lib.entries,
  target: 'node',
  output: {
    // use absolute paths in sourcemaps (important for debugging via IDE)
    // devtoolModuleFilenameTemplate: '[absolute-resource-path]',
    // devtoolFallbackModuleFilenameTemplate: '[absolute-resource-path]?[hash]',

    libraryTarget: 'commonjs',
    path: path.join(__dirname, '.webpack'),
    filename: '[name].js'
  },
  devtool: ' cheap-source-map ',
  module: {
    rules: [
      {
        test: /\.js$/,
        include: __dirname,
        loader: 'istanbul-instrumenter-loader',
        query: {
          esModules: true
        },
        exclude: /node_modules/
      },
      {
        test: /\.js$/,
        loaders: ['babel-loader'],
        include: __dirname,
        exclude: /node_modules/
      }
    ]
  }
};
