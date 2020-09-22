const stream = require('stream');

/**
 * A factory to generate a {@link KinesisClient} that pulls records from a DynamoDB stream
 *
 * @param {object} client - an AWS.DynamoDBStream client capable of reading the desired stream
 * @param {string} [name] - the name of the shard to read. Not required if already
 * set by the provided AWS.DynamoDBStream client.
 * @param {object} [options] - configuration details
 * @param {string} [options.shardId] - the shard id to read from. Each DynamoDBStreamReadable
 * instance is only capable of reading a single shard. If unspecified, the instance
 * will read from the first shard returned by a DescribeStream request.
 * @param {string} [options.iterator] - the iterator type. One of `LATEST` or `TRIM_HORIZON`.
 * If unspecified, defaults to `TRIM_HORIZON`
 * @param {string} [options.startAt] - a sequence number to start reading from.
 * @param {string} [options.startAfter] - a sequence number to start reading after.
 * @param {number} [options.limit] - the maximum number of records that will
 * be passed to any single `data` event.
 * @param {number} [options.readInterval] - time in ms to wait between getRecords API calls
 * @returns {DynamoDBStreamClient} a readable stream of DynamoDB records
 */
function DynamoDBStreamReadable(client, arn, options) {
  if (typeof arn === 'object') {
    options = arn;
    arn = undefined;
  }

  if (!options) options = {};

  if (options.iterator && options.iterator !== 'LATEST' && options.iterator !== 'TRIM_HORIZON')
    throw new Error('options.iterator must be one of LATEST or TRIM_HORIZON');

  const readable = new stream.Readable({
    objectMode: true,
    highWaterMark: 100
  });

  const checkpoint = new stream.Transform({
    objectMode: true,
    highWaterMark: 100
  });

  let iterator,
    drain,
    ended,
    pending = 0;

  function getShardIterator(shardId, callback) {
    const params = {
      ShardId: shardId,
      StreamArn: arn
    };

    if (options.iterator) {
      params.ShardIteratorType = options.iterator;
    } else if (options.startAt) {
      params.ShardIteratorType = 'AT_SEQUENCE_NUMBER';
      params.SequenceNumber = options.startAt;
    } else if (options.startAfter) {
      params.ShardIteratorType = 'AFTER_SEQUENCE_NUMBER';
      params.SequenceNumber = options.startAfter;
    } else {
      params.ShardIteratorType = 'TRIM_HORIZON';
    }

    pending++;
    client.getShardIterator(params, function (err, data) {
      pending--;
      if (err) return callback(err);
      iterator = data.ShardIterator;
      callback();
    });
  }

  function describeStream(callback) {
    pending++;
    client.describeStream({StreamArn: arn}, function (err, data) {
      pending--;
      if (err) return callback(err);

      const shardId = options.shardId
        ? data.StreamDescription.Shards.filter(function (shard) {
            return shard.ShardId === options.shardId;
          }).map(function (shard) {
            return shard.ShardId;
          })[0]
        : data.StreamDescription.Shards[0].ShardId;

      if (!shardId) return callback(new Error(`Shard ${options.shardId} does not exist`));
      getShardIterator(shardId, callback);
    });
  }

  function read(callback) {
    if ((drain && !pending) || !iterator) return callback(null, {Records: null});
    if (drain && pending) return setImmediate(read, callback);

    pending++;
    client.getRecords(
      {
        ShardIterator: iterator,
        Limit: options.limit
      },
      function (err, data) {
        pending--;

        if (err) {
          if (err.name === 'TrimmedDataAccessException') {
            return describeStream(function (e) {
              if (e) return checkpoint.emit('error', e);
              read(callback);
            });
          }
          return callback(err);
        }

        if (data.NextShardIterator) {
          iterator = data.NextShardIterator;
        } else {
          drain = true;
        }

        if (data.Records.length === 0) {
          if (!drain) return setTimeout(read, options.readInterval || 500, callback);
          data.Records = null;
        }

        callback(null, data);
      }
    );
  }

  readable._read = function () {
    function gotRecords(err, data) {
      if (err) return checkpoint.emit('error', err);
      setTimeout(readable.push.bind(readable), options.readInterval || 500, data.Records);
    }

    if (iterator) return read(gotRecords);

    describeStream(function (err) {
      if (err) return checkpoint.emit('error', err);
      read(gotRecords);
    });
  };

  checkpoint._transform = function (data, enc, callback) {
    checkpoint.emit('checkpoint', data.slice(-1)[0].dynamodb.SequenceNumber);
    callback(null, data);
  };

  checkpoint._flush = function (callback) {
    ended = true;
    callback();
  };

  /**
   * A dynamodb stream persists beyond the duration of a readable stream. In order
   * to stop reading from the stream, call `.close()`. Then listen for the `end`
   * event to indicate that all data that as been read from dynamodb has been passed
   * downstream.
   *
   * @instance
   * @memberof DynamoDBStreamClient
   * @returns {DynamoDBStreamClient}
   */
  checkpoint.close = function () {
    drain = true;
    if (!ended) readable._read();
    return checkpoint;
  };

  /**
   * A client that implements a node.js readable stream interface for reading dynamodb
   * records. See node.js documentation for details.
   *
   * In addition to the normal events emitted by a readable stream, the DynamoDBStreamClient
   * emits `checkpoint` events, which indicate the most recent sequence number that
   * has been read from DynamoDB and passed downstream.
   *
   * @name DynamoDBStreamClient
   */
  return readable.pipe(checkpoint);
}

module.exports = DynamoDBStreamReadable;
