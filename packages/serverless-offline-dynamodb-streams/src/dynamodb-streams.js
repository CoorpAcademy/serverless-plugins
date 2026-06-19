const {Writable} = require('stream');
const DynamodbClient = require('aws-sdk/clients/dynamodb');
const DynamodbStreamsClient = require('aws-sdk/clients/dynamodbstreams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign} = require('lodash/fp');

const {normalizeLog} = require('./log');
const DynamodbStreamsEventDefinition = require('./dynamodb-streams-event-definition');
const DynamodbStreamsEvent = require('./dynamodb-streams-event');

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

    this.client = new DynamodbClient(this.options);
    this.streamsClient = new DynamodbStreamsClient(this.options);

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
    const {enabled, tableName, arn, batchSize, startingPosition, maximumRetryAttempts} =
      dynamodbStreamsEvent;

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
      const readable = DynamodbStreamsReadable(
        this.streamsClient,
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
          const task = async remainingAttempts => {
            try {
              const lambdaFunction = this.lambda.get(functionKey);

              const event = new DynamodbStreamsEvent(chunk, this.options.region, arn);
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
