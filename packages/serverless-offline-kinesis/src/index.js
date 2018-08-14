const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const Kinesis = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const {mapValues, isEmpty, forEach, map, matchesProperty, filter, get, pipe} = require('lodash/fp');
const {createHandler, getFunctionOptions} = require('serverless-offline/src/functionHelper');
const createLambdaContext = require('serverless-offline/src/createLambdaContext');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

class ServerlessOfflineKinesis {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = this.service.custom['serverless-offline-kinesis'];

    this.commands = {};

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  eventHandler(streamEvent, functionName, shardId, chunk, cb) {
    const streamName = streamEvent.arn.split('/')[1];
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const {location = '.'} = this.service.custom['serverless-offline'];

    const __function = this.service.getFunction(functionName);
    const servicePath = join(this.serverless.config.servicePath, location);
    const funOptions = getFunctionOptions(__function, functionName, servicePath);
    const handler = createHandler(funOptions, {});

    const lambdaContext = createLambdaContext(__function, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });

    const event = {
      Records: chunk.map(({SequenceNumber, ApproximateArrivalTimestamp, Data, PartitionKey}) => ({
        kinesis: {
          partitionKey: PartitionKey,
          kinesisSchemaVersion: '1.0',
          data: Data.toString('base64'),
          sequenceNumber: SequenceNumber
        },
        eventSource: 'aws:kinesis',
        eventID: `${shardId}:${SequenceNumber}`,
        invokeIdentityArn: 'arn:aws:iam::serverless:role/offline',
        eventVersion: '1.0',
        eventName: 'aws:kinesis:record',
        eventSourceARN: streamEvent.arn,
        awsRegion: 'us-west-2'
      }))
    };

    if (handler.length < 3)
      handler(event, lambdaContext)
        .then(res => lambdaContext.done(null, res))
        .catch(lambdaContext.done);
    else handler(event, lambdaContext, lambdaContext.done);
  }

  async createKinesisReadable(functionName, streamEvent) {
    const streamName = streamEvent.arn.split('/')[1];

    this.serverless.cli.log(`${streamName}`);

    if(!this.client) { 
      this.client = new Kinesis(this.config); 
    }

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
            this.eventHandler(streamEvent, functionName, shardId, chunk, cb);
          }
        })
      );
    }, shards);
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline Kinesis.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const streams = pipe(
        get('events'),
        filter(matchesProperty('stream.type', 'kinesis')),
        map(get('stream'))
      )(_function);

      if (!isEmpty(streams)) {
        printBlankLine();
        this.serverless.cli.log(`Kinesis for ${functionName}:`);
      }

      forEach(streamEvent => {
        this.createKinesisReadable(functionName, streamEvent);
      }, streams);

      if (!isEmpty(streams)) {
        printBlankLine();
      }
    }, this.service.functions);
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineKinesis;
