const {Writable} = require('stream');
const {
  KinesisClient,
  DescribeStreamCommand,
  GetRecordsCommand,
  GetShardIteratorCommand,
  waitUntilStreamExists
} = require('@aws-sdk/client-kinesis');
const {assign} = require('lodash/fp');
const KinesisReadable = require('./kinesis-readable');

const {normalizeLog} = require('./log');
const {buildClientConfig} = require('./client-config');
const {buildCallbackClient} = require('./callback-adapter');
const KinesisEventDefinition = require('./kinesis-event-definition');
const KinesisEvent = require('./kinesis-event');

// #248 (aws-sdk v3): the v2 callback methods `kinesis-readable` calls, mapped to their v3 Commands.
const KINESIS_READABLE_COMMANDS = {
  describeStream: DescribeStreamCommand,
  getShardIterator: GetShardIteratorCommand,
  getRecords: GetRecordsCommand
};

// waitUntilStreamExists needs a bounded max wait; mirror the v2 waiter's generous polling budget.
const STREAM_EXISTS_MAX_WAIT_SECONDS = 120;

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// #100 (dolsem): bounded retry (mirrors dynamodb-streams) — stops after N attempts
// instead of recursing forever. Pure attempt-counter: another retry is allowed
// only while attempts remain.
const shouldRetry = remainingAttempts => remainingAttempts > 0;

class Kinesis {
  constructor(lambda, options, log) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;
    this.log = normalizeLog(log);
    this.client = new KinesisClient(buildClientConfig(this.options));
    // #248 (aws-sdk v3): kinesis-readable drives the client via v2 callback methods; wrap the v3
    // client in a promise->callback shim so the readable's pure logic is untouched.
    this.readableClient = buildCallbackClient(this.client, KINESIS_READABLE_COMMANDS);

    this.readables = [];
  }

  create(events) {
    return Promise.all(events.map(({functionKey, kinesis}) => this._create(functionKey, kinesis)));
  }

  start() {
    this.readables.forEach(readable => readable.resume());
  }

  stop(timeout) {
    this.readables.forEach(readable => readable.pause());
  }

  _create(functionKey, rawKinesisEventDefinition) {
    const kinesisEvent = new KinesisEventDefinition(
      rawKinesisEventDefinition,
      this.options.region,
      this.options.accountId
    );

    return this._kinesisEvent(functionKey, kinesisEvent);
  }

  async _describeStream(streamName) {
    try {
      await waitUntilStreamExists(
        {client: this.client, maxWaitTime: STREAM_EXISTS_MAX_WAIT_SECONDS},
        {StreamName: streamName}
      );
      return await this.client.send(new DescribeStreamCommand({StreamName: streamName}));
    } catch (err) {
      return this._describeStream(streamName);
    }
  }

  async _kinesisEvent(functionKey, kinesisEvent) {
    const {enabled, streamName, arn, batchSize, startingPosition, maximumRetryAttempts} =
      kinesisEvent;

    if (!enabled) return;

    const {
      StreamDescription: {Shards: shards}
    } = await this._describeStream(streamName);

    shards.forEach(({ShardId: shardId}) => {
      const readable = KinesisReadable(
        this.readableClient,
        streamName,
        assign(kinesisEvent, {
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

              const event = new KinesisEvent(chunk, this.options.region, arn, shardId);
              lambdaFunction.setEvent(event);

              await lambdaFunction.runHandler();
            } catch (err) {
              const attempt = maximumRetryAttempts - remainingAttempts;
              this.log.warning(
                `Kinesis handler for ${functionKey} failed (attempt ${attempt}/${maximumRetryAttempts}): ${err.stack}`
              );
              if (shouldRetry(remainingAttempts)) {
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

module.exports = Kinesis;
module.exports.shouldRetry = shouldRetry;
