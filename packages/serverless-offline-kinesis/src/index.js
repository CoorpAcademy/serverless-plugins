const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const Kinesis = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const {
  filter,
  forEach,
  get,
  isEmpty,
  map,
  mapValues,
  matchesProperty,
  pipe,
  startsWith
} = require('lodash/fp');
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

const getConfig = (service, pluginName) => {
  return (service && service.custom && service.custom[pluginName]) || {};
};

const extractStreamNameFromARN = arn => {
  const [, , , , , StreamURI] = arn.split(':');
  const [, ...StreamNames] = StreamURI.split('/');
  return StreamNames.join('/');
};

class ServerlessOfflineKinesis {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = getConfig(this.service, 'serverless-offline-kinesis');

    this.commands = {};

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getClient() {
    const awsConfig = Object.assign(
      {
        region: this.options.region || this.service.provider.region || 'us-west-2'
      },
      this.config
    );
    return new Kinesis(awsConfig);
  }

  eventHandler(streamEvent, functionName, shardId, chunk, cb) {
    const streamName = this.getStreamName(streamEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const {location = '.'} = getConfig(this.service, 'serverless-offline');

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = Object.assign(
      {},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    );
    process.env = functionEnv;

    const servicePath = join(this.serverless.config.servicePath, location);
    const funOptions = getFunctionOptions(__function, functionName, servicePath);
    const handler = createHandler(funOptions, Object.assign({}, this.options, this.config));
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

    process.env = env;
  }

  getStreamName(streamEvent) {
    if (typeof streamEvent === 'string' && startsWith('arn:aws:kinesis', streamEvent))
      return extractStreamNameFromARN(streamEvent);
    if (typeof streamEvent.arn === 'string') return extractStreamNameFromARN(streamEvent.arn);
    if (typeof streamEvent.streamName === 'string') return streamEvent.streamName;

    if (streamEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = streamEvent.arn['Fn::GetAtt'];

      if (
        this.service &&
        this.service.resources &&
        this.service.resources.Resources &&
        this.service.resources.Resources[ResourceName] &&
        this.service.resources.Resources[ResourceName].Properties &&
        typeof this.service.resources.Resources[ResourceName].Properties.Name === 'string'
      )
        return this.service.resources.Resources[ResourceName].Properties.Name;
    }

    throw new Error(
      `StreamName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-kinesis#functions`
    );
  }

  async createKinesisReadable(functionName, streamEvent) {
    const client = this.getClient();
    const streamName = this.getStreamName(streamEvent);

    this.serverless.cli.log(`${streamName}`);

    const {StreamDescription: {Shards: shards}} = await fromCallback(cb =>
      client.describeStream(
        {
          StreamName: streamName
        },
        cb
      )
    );

    forEach(({ShardId: shardId}) => {
      const readable = KinesisReadable(
        client,
        streamName,
        Object.assign({}, this.config, {
          shardId,
          limit: streamEvent.batchSize,
          iterator: streamEvent.startingPosition || 'TRIM_HORIZON'
        })
      );

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
        filter(
          event =>
            !matchesProperty('stream.enabled', false)(event) &&
            (matchesProperty('stream.type', 'kinesis')(event) ||
              startsWith('arn:aws:kinesis', event.stream))
        ),
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
