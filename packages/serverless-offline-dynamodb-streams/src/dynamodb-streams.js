const {Writable} = require('stream');
// #248 (EdgarOrtegaRamirez): migrated off aws-sdk v2 (`aws-sdk/clients/dynamodb(streams)`), which
// emitted the maintenance-mode warning, to the modular @aws-sdk v3 clients/commands/waiters.
const {
  DynamoDBClient,
  DescribeTableCommand,
  waitUntilTableExists
} = require('@aws-sdk/client-dynamodb');
const {DynamoDBStreamsClient, DescribeStreamCommand} = require('@aws-sdk/client-dynamodb-streams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign, isEmpty} = require('lodash/fp');

const {normalizeLog} = require('./log');
const {toClientConfig} = require('./aws-client');
const {toCallbackStreamsClient} = require('./dynamodb-streams-client');
const DynamodbStreamsEventDefinition = require('./dynamodb-streams-event-definition');
const DynamodbStreamsEvent = require('./dynamodb-streams-event');
const {filterRecords} = require('./filter-patterns');

// Bound the v3 `waitUntilTableExists` waiter so a not-yet-created table makes the waiter reject
// promptly; our recursive retry in `_describeTable` then re-arms it (preserving the v2 behaviour of
// blocking until the table appears) instead of one call hanging forever.
const TABLE_EXISTS_MAX_WAIT_SECONDS = 60;

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

class DynamodbStreams {
  constructor(lambda, options, log) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;
    this.log = normalizeLog(log);

    // #248: v3 wants region/endpoint at the top level and credentials nested — `toClientConfig`
    // normalizes the flat v2-style options bag once at this boundary.
    const clientConfig = toClientConfig(this.options);
    this.client = new DynamoDBClient(clientConfig);
    this.streamsClient = new DynamoDBStreamsClient(clientConfig);
    // The readable consumes the v2 callback contract; adapt the v3 streams client to it.
    this.streamsCallbackClient = toCallbackStreamsClient(this.streamsClient);

    this.readables = [];
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
      // #248: v3 replaces v2 `waitFor('tableExists')` with the standalone `waitUntilTableExists`
      // waiter and `describeTable().promise()` with `client.send(new DescribeTableCommand(...))`.
      await waitUntilTableExists(
        {client: this.client, maxWaitTime: TABLE_EXISTS_MAX_WAIT_SECONDS},
        {TableName: tableName}
      );
      return await this.client.send(new DescribeTableCommand({TableName: tableName}));
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
    } = await this.streamsClient.send(new DescribeStreamCommand({StreamArn: streamArn}));

    shards.forEach(({ShardId: shardId}) => {
      const readable = DynamodbStreamsReadable(
        // #248: the readable still speaks the v2 callback API; hand it the adapter, not the raw v3
        // client (which only exposes `send`).
        this.streamsCallbackClient,
        streamArn,
        assign(dynamodbStreamsEvent, {
          shardId,
          limit: batchSize,
          iterator: startingPosition
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
