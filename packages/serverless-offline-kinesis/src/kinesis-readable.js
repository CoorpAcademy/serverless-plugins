const stream = require('stream');
const {getOr} = require('lodash/fp');

// #248 (aws-sdk v3): vendored from the `kinesis-readable` npm package (MIT, Mapbox/rclark). The
// upstream package only `require('stream')` — it never imports aws-sdk at runtime — yet it declares
// `aws-sdk@^2` as a hard dependency, which dragged the entire vulnerable aws-sdk v2 tree into this
// package's published runtime. Vendoring the (pure, stream-only) logic here removes that dependency
// with no behavioral change: the reader still drives the AWS client purely through the v2-style
// callback contract (`describeStream`/`getShardIterator`/`getRecords`), which `callback-adapter.js`
// re-exposes on top of the @aws-sdk/client-kinesis v3 client.

const DEFAULT_READ_INTERVAL = 500;

/**
 * A factory to generate a {@link KinesisClient} that pulls records from a Kinesis stream.
 *
 * @param {object} client - a client exposing v2-style callback methods
 *   (`describeStream`, `getShardIterator`, `getRecords`); see callback-adapter.js.
 * @param {string} [name] - the stream name to read.
 * @param {object} [options] - configuration details
 * @param {string} [options.shardId] - the shard id to read from. Each reader reads a single shard;
 *   if unspecified, the first shard returned by DescribeStream is used.
 * @param {string} [options.iterator] - iterator type, one of `LATEST` or `TRIM_HORIZON`
 *   (defaults to `TRIM_HORIZON`).
 * @param {string} [options.startAt] - a sequence number to start reading from.
 * @param {string} [options.startAfter] - a sequence number to start reading after.
 * @param {number} [options.timestamp] - a timestamp to start reading after.
 * @param {number} [options.limit] - max records passed to any single `data` event.
 * @param {number} [options.readInterval] - ms to wait between getRecords calls.
 * @returns {stream.Transform} a readable stream of Kinesis records that also emits `checkpoint`.
 */
function KinesisReadable(client, name, options) {
  if (typeof name === 'object') {
    options = name;
    name = undefined;
  }

  if (!options) options = {};

  if (options.iterator && options.iterator !== 'LATEST' && options.iterator !== 'TRIM_HORIZON')
    throw new Error('options.iterator must be one of LATEST or TRIM_HORIZON');

  const readInterval = getOr(DEFAULT_READ_INTERVAL, 'readInterval', options);

  const readable = new stream.Readable({objectMode: true, highWaterMark: 100});
  const checkpoint = new stream.Transform({objectMode: true, highWaterMark: 100});

  // Mutable stream lifecycle state — the only mutation in this module.
  let iterator;
  let drain = false;
  let ended = false;
  let pending = 0;

  function getShardIterator(shardId, callback) {
    const params = {ShardId: shardId, StreamName: name};

    if (options.iterator) {
      params.ShardIteratorType = options.iterator;
    } else if (options.startAt) {
      params.ShardIteratorType = 'AT_SEQUENCE_NUMBER';
      params.StartingSequenceNumber = options.startAt;
    } else if (options.startAfter) {
      params.ShardIteratorType = 'AFTER_SEQUENCE_NUMBER';
      params.StartingSequenceNumber = options.startAfter;
    } else if (options.timestamp) {
      params.ShardIteratorType = 'AT_TIMESTAMP';
      params.Timestamp = options.timestamp;
    } else {
      params.ShardIteratorType = 'TRIM_HORIZON';
    }

    pending++;
    client.getShardIterator(params, (err, data) => {
      pending--;
      if (err) return callback(err);
      iterator = data.ShardIterator;
      callback();
    });
  }

  function describeStream(callback) {
    pending++;
    client.describeStream({StreamName: name}, (err, data) => {
      pending--;
      if (err) return callback(err);

      const shards = data.StreamDescription.Shards;
      const shardId = options.shardId
        ? getOr(
            undefined,
            'ShardId',
            shards.find(shard => shard.ShardId === options.shardId)
          )
        : getOr(undefined, '0.ShardId', shards);

      if (!shardId) return callback(new Error(`Shard ${options.shardId} does not exist`));
      getShardIterator(shardId, callback);
    });
  }

  function read(callback) {
    if (drain && !pending) return callback(null, {Records: null});
    if (drain && pending) return setImmediate(read, callback);

    pending++;
    client.getRecords({ShardIterator: iterator, Limit: options.limit}, (err, data) => {
      pending--;
      if (err) return callback(err);

      iterator = data.NextShardIterator;

      // #248 (aws-sdk v3): callback-adapter normalizes an omitted v3 `Records` to []; an empty batch
      // on an open stream keeps polling, only a consumer-initiated close() drains.
      if (data.Records.length === 0) {
        if (!drain) return setTimeout(read, readInterval, callback);
        data.Records = null;
      }

      callback(null, data);
    });
  }

  readable._read = function () {
    function gotRecords(err, data) {
      if (err) return checkpoint.emit('error', err);
      setTimeout(readable.push.bind(readable), readInterval, data.Records);
    }

    if (iterator) return read(gotRecords);

    describeStream(err => {
      if (err) return checkpoint.emit('error', err);
      read(gotRecords);
    });
  };

  checkpoint._transform = function (data, enc, callback) {
    checkpoint.emit('checkpoint', data.slice(-1)[0].SequenceNumber);
    callback(null, data);
  };

  checkpoint._flush = function (callback) {
    ended = true;
    callback();
  };

  /**
   * A Kinesis stream persists beyond the duration of a readable stream. To stop reading, call
   * `.close()`, then listen for `end` to know all read records have been passed downstream.
   *
   * @returns {stream.Transform} the checkpoint stream
   */
  checkpoint.close = function () {
    drain = true;
    if (!ended) readable._read();
    return checkpoint;
  };

  return readable.pipe(checkpoint);
}

module.exports = KinesisReadable;
