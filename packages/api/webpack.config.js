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
    filename: '[name].js',
    devtoolModuleFilenameTemplate: '[absolute-resource-path]'
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        loaders: ['babel-loader'],
        include: __dirname,
        exclude: /node_modules/
      }
    ]
  }
};
