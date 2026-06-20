const stream = require('stream');
const {getOr} = require('lodash/fp');

const {normalizeLog} = require('./log');
const {
  selectShardId,
  isRecoverableIteratorError,
  nextRetryState,
  shouldKeepPolling,
  canRead
} = require('./stream-helpers');

const DEFAULT_READ_INTERVAL = 500;
const DEFAULT_MAX_ITERATOR_RETRIES = 10;

/**
 * A factory to generate a {@link DynamoDBStreamClient} that pulls records from a DynamoDB stream
 *
 * @param {object} client - an AWS.DynamoDBStream client capable of reading the desired stream
 * @param {string} [arn] - the stream ARN to read. Not required if already
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
 * @param {number} [options.maxIteratorRetries] - max consecutive iterator recoveries before failing
 * @param {object} [options.log] - a normalized logger ({debug,info,warning,...}); defaults to console
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

  const log = normalizeLog(options.log);
  const readInterval = getOr(DEFAULT_READ_INTERVAL, 'readInterval', options);
  const maxIteratorRetries = getOr(DEFAULT_MAX_ITERATOR_RETRIES, 'maxIteratorRetries', options);

  const readable = new stream.Readable({
    objectMode: true,
    highWaterMark: 100
  });

  const checkpoint = new stream.Transform({
    objectMode: true,
    highWaterMark: 100
  });

  // Mutable stream lifecycle state — the only mutation in this module. Every *decision* about this
  // state (drain/keep-polling/recoverable/select-shard/can-read) lives in the pure helpers; this
  // wiring layer merely applies them and performs the AWS side effects.
  let iterator,
    drain = false,
    ended = false,
    closed = false, // #197 (cnuss): set by close(); short-circuits every further read
    endPushed = false, // guards a single `push(null)` so close()/pending-read end the stream once
    pending = 0,
    recovery = {attempt: 0, max: maxIteratorRetries};

  // #54 (asprouse): push the end-of-stream sentinel exactly once (close() and a pending read racing
  // to finish must not double-push null).
  function pushEnd() {
    if (endPushed) return;
    endPushed = true;
    readable.push(null);
  }

  // A genuinely sealed shard (real AWS returns NextShardIterator=null permanently) would set this;
  // local emulators do not reliably signal sealing, so by default only close() drains the stream.
  const sealed = false;

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
    if (closed) return callback(); // #197 (cnuss): no describeStream against a shutting-down endpoint
    pending++;
    client.describeStream({StreamArn: arn}, function (err, data) {
      pending--;
      if (err) return callback(err);

      // #164 (mdrijwan/rynvelt): select the shard via the pure helper — no silent Shards[0] fallback
      // when a specific shardId was requested but is absent.
      const shardId = selectShardId(data.StreamDescription.Shards, options.shardId);
      if (!shardId) return callback(new Error(`Shard ${options.shardId} does not exist`));

      getShardIterator(shardId, callback);
    });
  }

  function read(callback) {
    // #197 (cnuss): a closed/destroyed stream (or one without an iterator yet) issues no read.
    if (!canRead({closed, iterator, drain, pending})) return callback(null, {Records: null});
    if (drain && pending) return setImmediate(read, callback);

    pending++;
    client.getRecords(
      {
        ShardIterator: iterator,
        Limit: options.limit
      },
      function (err, data) {
        pending--;

        // #197 (cnuss): the endpoint may have been torn down while this read was in flight; swallow
        // the late response (success or ECONNREFUSED) and let the stream end cleanly.
        if (closed) return callback(null, {Records: null});

        if (err) {
          // #154 (mshick) / #164 (mdrijwan): a stale/expired/invalid iterator is recoverable —
          // re-describe for a fresh iterator and retry, within a bounded budget.
          if (isRecoverableIteratorError(err)) {
            const step = nextRetryState(recovery);
            recovery = {attempt: step.attempt, max: step.max};
            if (!step.retry) return callback(err); // bounded exhausted -> surface the error
            log.warning(
              `ddb-streams: re-fetching shard iterator after ${err.name} (attempt ${step.attempt}/${step.max})`
            );
            iterator = undefined; // force a fresh iterator on the next read
            return describeStream(function (e) {
              if (e) return callback(e);
              read(callback);
            });
          }
          return callback(err);
        }

        // #154/#164: a successful getRecords is real forward progress — reset the bounded recovery
        // budget so future stale-iterator errors get a full retry allowance (not consumed by a past,
        // already-recovered hiccup).
        if (recovery.attempt !== 0) recovery = {...recovery, attempt: 0};

        // origin/master latched drain=true here on an absent NextShardIterator; we no longer do.
        iterator = data.NextShardIterator;

        // #248 (aws-sdk v3): a v3 GetRecords response OMITS `Records` entirely when empty (aws-sdk v2
        // always returned []). Guard here in the I/O wiring (the pure stream-helpers stay untouched)
        // so `.length` never reads `undefined` and the empty-batch poll loop below keeps working.
        const records = getOr([], 'Records', data);

        if (records.length === 0) {
          // #54 (asprouse) / #82 (kalitamih) / #163 (mcopik): an empty batch on an OPEN, non-closed
          // stream must keep polling — even when NextShardIterator is absent (re-describe first).
          if (shouldKeepPolling({closed, sealed})) {
            if (!iterator)
              return describeStream(function (e) {
                if (e) return callback(e);
                setTimeout(read, readInterval, callback);
              });
            return setTimeout(read, readInterval, callback);
          }
          // Only a consumer-initiated close (or a genuinely sealed shard) ends the stream.
          drain = true;
          data.Records = null;
        }

        callback(null, data);
      }
    );
  }

  readable._read = function () {
    if (closed) return pushEnd(); // #197 (cnuss): never read after close

    function gotRecords(err, data) {
      // #197 (cnuss): once closed, do not push late records — end the stream exactly once instead.
      if (closed) return pushEnd();
      if (err) return checkpoint.emit('error', err);
      setTimeout(readable.push.bind(readable), readInterval, data.Records);
    }

    if (iterator) return read(gotRecords);

    describeStream(function (err) {
      if (closed) return;
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
    // #54 (asprouse) / #197 (cnuss): close() stops scheduling new polls and ends the stream by
    // pushing `null` once — it must NOT trigger a brand-new network read (origin/master called
    // readable._read() here, firing a getRecords against a shutting-down endpoint -> ECONNREFUSED).
    closed = true;
    drain = true;
    // If a read is in flight, its post-close guard ends the readable via pushEnd(); only end here
    // ourselves when nothing is pending and the stream has not already ended.
    if (!pending && !ended) pushEnd();
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
