const {Writable} = require('stream');
const KinesisClient = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const {assign} = require('lodash/fp');

const {normalizeLog} = require('./log');
const KinesisEventDefinition = require('./kinesis-event-definition');
const KinesisEvent = require('./kinesis-event');

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
    this.client = new KinesisClient(this.options);

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
      await this.client.waitFor('streamExists', {StreamName: streamName}).promise();
      return await this.client
        .describeStream({
          StreamName: streamName
        })
        .promise();
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
        this.client,
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
