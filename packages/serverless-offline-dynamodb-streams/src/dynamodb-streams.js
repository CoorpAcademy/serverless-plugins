const {Writable} = require('stream');
const DynamodbClient = require('aws-sdk/clients/dynamodb');
const DynamodbStreamsClient = require('aws-sdk/clients/dynamodbstreams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign, isEmpty, last, get} = require('lodash/fp');

const {normalizeLog} = require('./log');
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

    this.client = new DynamodbClient(this.options);
    this.streamsClient = new DynamodbStreamsClient(this.options);

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

  async _describeTable(tableName) {
    try {
      await this.client.waitFor('tableExists', {TableName: tableName}).promise();
      return await this.client
        .describeTable({
          TableName: tableName
        })
        .promise();
    } catch (err) {
      return this._describeTable(tableName);
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

    const {
      Table: {LatestStreamArn}
    } = await this._describeTable(tableName);

    const streamArn = assertStreamEnabled(tableName, LatestStreamArn);

    const {
      StreamDescription: {Shards: shards}
    } = await this.streamsClient
      .describeStream({
        StreamArn: streamArn
      })
      .promise();

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
        this.streamsClient,
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
          if (isEmpty(matching)) return cb();

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
              // We use the full-chunk sequence number (not the filtered subset) so a
              // batch fully dropped by filterPatterns still moves the cursor forward.
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
