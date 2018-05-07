const {join} = require('path');
const {Writable} = require('stream');
const Kinesis = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const {mapValues, forEach, map, matchesProperty, filter, get, pipe} = require('lodash/fp');
const {createHandler, getFunctionOptions} = require('serverless-offline/src/functionHelper');
const createLambdaContext = require('serverless-offline/src/createLambdaContext');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

class ServerlessOfflineDynamoDBStreams {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = this.service.custom['serverless-offline-dynamodb-streams'];

    this.commands = {};

    this.client = new Kinesis(this.config);

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  eventHandler(functionName, chunk, cb) {
    this.serverless.cli.log(`Kinesis ${JSON.stringify(chunk, null, 4)}`);

    const {location = '.'} = this.service.custom['serverless-offline'];

    const __function = this.service.getFunction(functionName);
    const servicePath = join(this.serverless.config.servicePath, location);
    const funOptions = getFunctionOptions(__function, functionName, servicePath);
    const handler = createHandler(funOptions, {});

    const lambdaContext = createLambdaContext(__function, cb);

    const event = chunk;

    handler(event, lambdaContext, lambdaContext.done);
  }

  async createKinesisReadable(functionName, streamEvent) {
    const streamName = streamEvent.arn.split('/')[1];

    const {StreamDescription: {Shards: shards}} = await fromCallback(cb =>
      this.client.describeStream(
        {
          StreamName: streamName
        },
        cb
      )
    );

    forEach(({ShardId: shardId}) => {
      const readable = KinesisReadable(this.client, streamName, {
        shardId,
        limit: streamEvent.batchSize,
        iterator: streamEvent.startingPosition || 'TRIM_HORIZON'
      });

      readable.pipe(
        new Writable({
          objectMode: true,
          write: (chunk, encoding, cb) => {
            this.eventHandler(functionName, chunk, cb);
          }
        })
      );
    }, shards);
  }

  offlineStartInit() {
    this.serverless.cli.log('offline-start-init');

    mapValues.convert({cap: false})((_function, functionName) => {
      return pipe(
        get('events'),
        filter(matchesProperty('stream.type', 'kinesis')),
        map(
          pipe(get('stream'), streamEvent => {
            this.serverless.cli.log(`Kinesis ${functionName} ${JSON.stringify(streamEvent)}`);
            this.createKinesisReadable(functionName, streamEvent);
          })
        )
      )(_function);
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineDynamoDBStreams;
