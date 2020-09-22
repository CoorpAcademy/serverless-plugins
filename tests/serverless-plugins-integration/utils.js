const {Transform} = require('stream');

const getSplitLinesTransform = () =>
  new Transform({
    objectMode: true,
    transform(chunk, encoding, callback) {
      const lines = chunk.toString().trim().split('\n');
      lines.forEach(line => this.push(line));
      callback();
    }
  });

const delay = duration =>
  new Promise(resolve => {
    setTimeout(resolve, duration);
  });

module.exports = {getSplitLinesTransform, delay};
