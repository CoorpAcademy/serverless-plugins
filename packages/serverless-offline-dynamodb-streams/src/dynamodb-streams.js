const {Writable} = require('stream');
const {
  DynamoDBClient,
  DescribeTableCommand,
  waitUntilTableExists
} = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetRecordsCommand,
  GetShardIteratorCommand
} = require('@aws-sdk/client-dynamodb-streams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign, isEmpty, last, get} = require('lodash/fp');

const {normalizeLog} = require('./log');
const {buildClientConfig} = require('./client-config');
const {buildCallbackClient} = require('./callback-adapter');
const DynamodbStreamsEventDefinition = require('./dynamodb-streams-event-definition');
const DynamodbStreamsEvent = require('./dynamodb-streams-event');
const {filterRecords} = require('./filter-patterns');
const {
  resolveIteratorOptions,
  resolveStateFilePath,
  setCheckpoint,
  loadState,
  saveState
} = require('./checkpoint-store');

// #248 (aws-sdk v3): the v2 callback methods `dynamodb-streams-readable` calls, mapped to v3 Commands.
const DDB_STREAMS_READABLE_COMMANDS = {
  describeStream: DescribeStreamCommand,
  getShardIterator: GetShardIteratorCommand,
  getRecords: GetRecordsCommand
};

// waitUntilTableExists needs a bounded max wait; mirror the v2 waiter's generous polling budget.
const TABLE_EXISTS_MAX_WAIT_SECONDS = 120;

// #241 (lqueryvg): how many times `_describeTable` may wait-and-retry before giving up.
// The previous code recursed UNCONDITIONALLY on any waiter failure, so a genuinely-missing
// table (e.g. Localstack not up) hung `serverless offline` forever with no error. Bound the
// retry so a missing table fails fast with a clear, named error instead of spinning.
const TABLE_DESCRIBE_MAX_ATTEMPTS = 3;

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// #98 (dolsem): fail fast with a clear message when the table has no stream
// instead of letting `describeStream({StreamArn: undefined})` fail cryptically.
const assertStreamEnabled = (tableName, latestStreamArn) => {
  if (!latestStreamArn) throw new Error(`Table ${tableName} does not have streams enabled`);
  return latestStreamArn;
};

// #241 (lqueryvg): opt-in to a non-blocking startup. Default false preserves the current
// fail-fast behavior; when set, a missing table/stream is warned-and-skipped so the rest of
// serverless-offline still starts. Pure read of the merged custom options. `undefined`/missing
// -> false.
const shouldContinueOnMissingResource = options =>
  Boolean(get('continueOnMissingResource', options));

// #241 (lqueryvg): the warning shown when a missing table/stream is skipped (opt-in path).
// Pure: names the table and the underlying cause so the developer knows what was skipped and
// why. Tolerates a nil/non-Error cause.
const missingResourceWarning = (tableName, err) =>
  `serverless-offline-dynamodb-streams: skipping table "${tableName}" — its table or stream ` +
  `is unavailable offline (${get('message', err) || err}). ` +
  `Set custom.serverless-offline-dynamodb-streams.continueOnMissingResource: false to fail fast instead.`;

// #178 (ddb-streams-checkpoint): the sequence number of the LAST record in a chunk —
// the high-water mark the handler has processed up to. `undefined` for an empty/sentinel
// chunk so the caller skips advancing the checkpoint. Pure.
const chunkSequenceNumber = chunk => get(['dynamodb', 'SequenceNumber'], last(chunk));

class DynamodbStreams {
  constructor(lambda, options, log) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;
    this.log = normalizeLog(log);

    this.client = new DynamoDBClient(buildClientConfig(this.options));
    this.streamsClient = new DynamoDBStreamsClient(buildClientConfig(this.options));
    // #248 (aws-sdk v3): dynamodb-streams-readable drives the streams client via v2 callback methods;
    // wrap the v3 client in a promise->callback shim so the readable's pure logic stays untouched.
    this.readableStreamsClient = buildCallbackClient(
      this.streamsClient,
      DDB_STREAMS_READABLE_COMMANDS
    );

    this.readables = [];

    // #178 (ddb-streams-checkpoint): resolve and load the restart checkpoint once. The
    // configured `checkpointFile` (custom option) is anchored at process cwd; a missing
    // file is a clean cold start (loadState returns {}). The in-memory map is the single
    // source of truth during the run and is persisted after each handler completes.
    this.checkpointFile = resolveStateFilePath(this.options.checkpointFile, process.cwd());
    this.checkpointState = loadState(this.checkpointFile);
  }

  create(events) {
    return Promise.all(
      events.map(({functionKey, dynamodbStreams}) => this._create(functionKey, dynamodbStreams))
    );
  }

  start() {
    this.readables.forEach(readable => readable.resume());
  }

  stop(timeout) {
    this.readables.forEach(readable => readable.pause());
  }

  _create(functionKey, rawDynamodbStreamsEventDefinition) {
    const dynamodbStreamsEvent = new DynamodbStreamsEventDefinition(
      rawDynamodbStreamsEventDefinition,
      this.options.region,
      this.options.accountId
    );

    return this._dynamodbStreamsEvent(functionKey, dynamodbStreamsEvent);
  }

  // #248 (aws-sdk v3): the bounded waiter, extracted as a seam so unit tests can stub the
  // 120s poll without hitting AWS. Production wiring is unchanged.
  _waitUntilTableExists(tableName) {
    return waitUntilTableExists(
      {client: this.client, maxWaitTime: TABLE_EXISTS_MAX_WAIT_SECONDS},
      {TableName: tableName}
    );
  }

  // #241 (lqueryvg): wait for the table, then describe it. The previous catch recursed
  // UNCONDITIONALLY, so a genuinely-missing table looped forever and `serverless offline`
  // hung with no error. Bound the retry to TABLE_DESCRIBE_MAX_ATTEMPTS and, on exhaustion,
  // throw a CLEAR error naming the table (the caller decides whether to fail fast or skip).
  async _describeTable(tableName, remainingAttempts = TABLE_DESCRIBE_MAX_ATTEMPTS) {
    try {
      await this._waitUntilTableExists(tableName);
      return await this.client.send(new DescribeTableCommand({TableName: tableName}));
    } catch (err) {
      if (remainingAttempts > 1) return this._describeTable(tableName, remainingAttempts - 1);
      throw new Error(
        `Table ${tableName} could not be described after ${TABLE_DESCRIBE_MAX_ATTEMPTS} ` +
          `attempts (${get('message', err) || err}). Is the table created and DynamoDB reachable?`
      );
    }
  }

  async _dynamodbStreamsEvent(functionKey, dynamodbStreamsEvent) {
    const {
      enabled,
      tableName,
      arn,
      batchSize,
      startingPosition,
      maximumRetryAttempts,
      filterPatterns
    } = dynamodbStreamsEvent;

    if (!enabled) return;

    // #241 (lqueryvg): resolving the table/stream is the one startup step that can fail when
    // the resource is absent offline (Localstack down, table/stream not created). Keep it in a
    // single try so the default path fails fast with a clear error, while the opt-in path warns
    // and SKIPS this event source so the rest of serverless-offline still starts.
    let streamArn;
    let shards;
    try {
      const {
        Table: {LatestStreamArn}
      } = await this._describeTable(tableName);

      streamArn = assertStreamEnabled(tableName, LatestStreamArn);

      ({
        StreamDescription: {Shards: shards}
      } = await this.streamsClient.send(new DescribeStreamCommand({StreamArn: streamArn})));
    } catch (err) {
      if (!shouldContinueOnMissingResource(this.options)) throw err;
      this.log.warning(missingResourceWarning(tableName, err));
      return;
    }

    shards.forEach(({ShardId: shardId}) => {
      // #178 (ddb-streams-checkpoint): pick the iterator from any saved checkpoint —
      // a resume yields {startAfter: seq} (NOT an `iterator`) so already-processed
      // records are never re-delivered, even under TRIM_HORIZON; a cold start yields the
      // configured starting position. The readable gives `iterator` precedence over
      // `startAfter`, which is exactly why the resume path omits `iterator`.
      const iteratorOptions = resolveIteratorOptions(
        this.checkpointState,
        streamArn,
        shardId,
        startingPosition
      );

      const readable = DynamodbStreamsReadable(
        this.readableStreamsClient,
        streamArn,
        assign(dynamodbStreamsEvent, {
          ...iteratorOptions,
          shardId,
          limit: batchSize
        })
      );

      const writable = new Writable({
        objectMode: true,
        write: (chunk, _, cb) => {
          // #242 (cremoon): honor event-source-mapping `filterPatterns`. Keep only the
          // matching records and skip the handler entirely when none match (AWS does not
          // invoke the function for an empty match, rather than delivering Records: []).
          const matching = filterRecords(filterPatterns, chunk);
          if (isEmpty(matching)) {
            // #178: a batch fully dropped by filterPatterns still moves the cursor
            // forward — the handler is skipped (no record matched) but every record was
            // seen, so advance the checkpoint to the FULL chunk's last sequence number.
            // Without this, those already-scanned, filtered records would be re-scanned
            // on restart. No handler ran, so there is nothing to wait on: advance and
            // ack the batch immediately.
            this._advanceCheckpoint(streamArn, shardId, chunkSequenceNumber(chunk));
            return cb();
          }

          const task = async remainingAttempts => {
            try {
              const lambdaFunction = this.lambda.get(functionKey);

              const event = new DynamodbStreamsEvent(matching, this.options.region, arn);
              lambdaFunction.setEvent(event);

              await lambdaFunction.runHandler();
            } catch (err) {
              this.log.warning(err.stack);
              if (remainingAttempts > 0) {
                await delay(500);
                return task(remainingAttempts - 1);
              }
            }
          };

          task(maximumRetryAttempts - 1)
            .then(() => {
              // #178: advance the checkpoint to the LAST record of the FULL chunk only
              // AFTER the handler has resolved (at-most-once: a crash before this line
              // re-delivers the in-flight batch on restart — documented in the README).
              // We use the full-chunk sequence number (not the filtered subset) so that
              // records filtered out within a partially-matching batch are not re-scanned
              // on restart. A fully-dropped batch is acked in the isEmpty branch above.
              this._advanceCheckpoint(streamArn, shardId, chunkSequenceNumber(chunk));
              return cb();
            })
            .catch(cb);
        }
      });

      readable.pipe(writable);
      readable.pause();

      this.readables.push(readable);
    });
  }

  // #178 (ddb-streams-checkpoint): persist the per-shard high-water mark. Thin I/O edge:
  // updates the in-memory map (pure setCheckpoint) then best-effort writes it. A write
  // failure is logged, never thrown — losing a checkpoint must not break the stream.
  _advanceCheckpoint(streamArn, shardId, sequenceNumber) {
    if (isEmpty(sequenceNumber)) return;

    this.checkpointState = setCheckpoint(this.checkpointState, streamArn, shardId, sequenceNumber);

    try {
      saveState(this.checkpointFile, this.checkpointState);
    } catch (err) {
      this.log.warning(`ddb-streams: failed to persist checkpoint: ${err.message}`);
    }
  }
}

module.exports = DynamodbStreams;
module.exports.assertStreamEnabled = assertStreamEnabled;
module.exports.chunkSequenceNumber = chunkSequenceNumber;
module.exports.shouldContinueOnMissingResource = shouldContinueOnMissingResource;
module.exports.missingResourceWarning = missingResourceWarning;
module.exports.TABLE_DESCRIBE_MAX_ATTEMPTS = TABLE_DESCRIBE_MAX_ATTEMPTS;
