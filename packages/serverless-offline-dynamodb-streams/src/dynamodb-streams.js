const {Writable} = require('stream');
const DynamodbClient = require('aws-sdk/clients/dynamodb');
const DynamodbStreamsClient = require('aws-sdk/clients/dynamodbstreams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign, isEmpty} = require('lodash/fp');

const {normalizeLog} = require('./log');
const DynamodbStreamsEventDefinition = require('./dynamodb-streams-event-definition');
const DynamodbStreamsEvent = require('./dynamodb-streams-event');
const {filterRecords} = require('./filter-patterns');
const {
  mergeCheckpoint,
  resolveStartAfter,
  readCheckpointState,
  writeCheckpointState,
  resolveCheckpointPath,
  DEFAULT_CHECKPOINT_FILE
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

// #178 (jjohnson1994): build the readable's iterator options for one shard. When a sequence
// number was checkpointed on a previous run, resume *after* it (the readable maps
// `startAfter` -> AFTER_SEQUENCE_NUMBER) instead of re-deriving a TRIM_HORIZON/LATEST
// iterator that would replay records the local stream still retains. `iterator` MUST be
// omitted in that case — the readable prefers `iterator` over `startAfter`.
const resolveIteratorOptions = (state, {streamArn, shardId, startingPosition}) => {
  const startAfter = resolveStartAfter(state, {streamArn, shardId});
  return startAfter ? {shardId, startAfter} : {shardId, iterator: startingPosition};
};

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

    // #178 (jjohnson1994): resume from persisted read progress across offline restarts.
    // Opt out with `custom.serverless-offline-dynamodb-streams.checkpoint: false`.
    this.checkpointEnabled = options.checkpoint !== false;
    this.checkpointPath = resolveCheckpointPath(
      options.location,
      typeof options.checkpoint === 'string' ? options.checkpoint : DEFAULT_CHECKPOINT_FILE
    );
    this.checkpointState = this.checkpointEnabled ? readCheckpointState(this.checkpointPath) : {};
  }

  // #178 (jjohnson1994): merge one shard's latest sequence number into the in-memory state and
  // flush it to disk so the next `serverless offline start` resumes past it. Best-effort:
  // a write failure is logged, never thrown (offline progress is a convenience).
  _persistCheckpoint(streamArn, shardId, sequenceNumber) {
    if (!this.checkpointEnabled) return;
    this.checkpointState = mergeCheckpoint(this.checkpointState, {
      streamArn,
      shardId,
      sequenceNumber
    });
    try {
      writeCheckpointState(this.checkpointPath, this.checkpointState);
    } catch (err) {
      this.log.warning(`ddb-streams: failed to persist checkpoint: ${err.message}`);
    }
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
      // #178 (jjohnson1994): on a warm restart resume past the last checkpointed sequence number
      // (startAfter) instead of re-deriving a TRIM_HORIZON/LATEST iterator that replays
      // already-processed records; on a cold start fall back to the configured position.
      const iteratorOptions = resolveIteratorOptions(this.checkpointState, {
        streamArn,
        shardId,
        startingPosition
      });

      const readable = DynamodbStreamsReadable(
        this.streamsClient,
        streamArn,
        assign(dynamodbStreamsEvent, {
          ...iteratorOptions,
          limit: batchSize
        })
      );

      // #178 (jjohnson1994): persist progress as the readable advances. The readable emits
      // `checkpoint` with the last SequenceNumber it passed downstream.
      readable.on('checkpoint', sequenceNumber =>
        this._persistCheckpoint(streamArn, shardId, sequenceNumber)
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
            .then(() => cb())
            .catch(cb);
        }
      });

      readable.pipe(writable);
      readable.pause();

      this.readables.push(readable);
    });
  }
}

module.exports = DynamodbStreams;
module.exports.assertStreamEnabled = assertStreamEnabled;
module.exports.resolveIteratorOptions = resolveIteratorOptions;
