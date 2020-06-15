const {Writable} = require('stream');
const KinesisClient = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const KinesisEventDefinition = require('./kinesis-event-definition');
const KinesisEvent = require('./kinesis-event');

const delay = timeout => new Promise(resolve => setTimeout(resolve, timeout));

class Kinesis {
  constructor(lambda, options) {
    this.lambda = null;
    this.options = null;

    this.lambda = lambda;
    this.options = options;

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

  _create(functionKey, rawSqsEventDefinition) {
    const kinesisEvent = new KinesisEventDefinition(
      rawSqsEventDefinition,
      this.options.region,
      this.options.accountId
    );

    return this._kinesisEvent(functionKey, kinesisEvent);
  }

  async _kinesisEvent(functionKey, kinesisEvent) {
    const {enabled, streamName, arn} = kinesisEvent;

    if (!enabled) return;

    const {
      StreamDescription: {Shards: shards}
    } = await this.client
      .describeStream({
        StreamName: streamName
      })
      .promise();

    shards.forEach(({ShardId: shardId}) => {
      const readable = KinesisReadable(this.client, streamName, kinesisEvent);

      const writable = new Writable({
        objectMode: true,
        write: (chunk, _, cb) => {
          const task = async () => {
            try {
              const lambdaFunction = this.lambda.get(functionKey);

              const event = new KinesisEvent(chunk, this.region, arn, shardId);
              lambdaFunction.setEvent(event);

              await lambdaFunction.runHandler();
            } catch (err) {
              await delay(500);
              return task();
            }
          };

          task()
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
