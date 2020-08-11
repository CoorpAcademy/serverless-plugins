const {Writable} = require('stream');
const DynamodbClient = require('aws-sdk/clients/dynamodb');
const DynamodbStreamsClient = require('aws-sdk/clients/dynamodbstreams');
const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {assign} = require('lodash/fp');
const DynamodbStreamsEventDefinition = require('./dynamodb-streams-event-definition');
const DynamodbStreamsEvent = require('./dynamodb-streams-event');

const delay = timeout => new Promise(resolve => setTimeout(resolve, timeout));

class DynamodbStreams {
  constructor(lambda, options) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;

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
      return this._waitFor(tableName);
    }
  }

  async _dynamodbStreamsEvent(functionKey, dynamodbStreamsEvent) {
    const {
      enabled,
      tableName,
      arn,
      batchSize,
      startingPosition,
      maximumRetryAttempts
    } = dynamodbStreamsEvent;

    if (!enabled) return;

    const {
      Table: {LatestStreamArn}
    } = await this._describeTable(tableName);

    const {
      StreamDescription: {Shards: shards}
    } = await this.streamsClient
      .describeStream({
        StreamArn: LatestStreamArn
      })
      .promise();

    shards.forEach(({ShardId: shardId}) => {
      const readable = DynamodbStreamsReadable(
        this.streamsClient,
        LatestStreamArn,
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

              const event = new DynamodbStreamsEvent(chunk, this.region, arn);
              lambdaFunction.setEvent(event);

              await lambdaFunction.runHandler();
            } catch (err) {
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
