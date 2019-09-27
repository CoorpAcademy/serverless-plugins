const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const Kinesis = require('aws-sdk/clients/kinesis');
const KinesisReadable = require('kinesis-readable');
const {
  assign,
  assignAll,
  filter,
  forEach,
  get,
  isEmpty,
  isUndefined,
  map,
  toPairs,
  negate,
  overEvery,
  overSome,
  matchesProperty,
  omitBy,
  isString,
  pipe,
  startsWith
} = require('lodash/fp');
const functionHelper = require('serverless-offline/src/functionHelper');
const LambdaContext = require('serverless-offline/src/LambdaContext');

const NO_KINESIS_FOUND = 'Could not find kinesis stream';
const KINESIS_RETRY_DELAY = 2000;

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

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

    this.commands = {};

    this.hooks = {
      'before:offline:start': this.offlineStartInit.bind(this),
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getConfig() {
    return assignAll(
      [
        this.options,
        this.service,
        this.service.provider,
        get(['custom', 'serverless-offline'], this.service),
        get(['custom', 'serverless-offline-kinesis'], this.service)
      ].map(omitBy(isUndefined))
    );
  }

  getClient() {
    return new Kinesis(this.getConfig());
  }

  eventHandler(streamEvent, functionName, shardId, chunk, cb) {
    const streamName = this.getStreamName(streamEvent);
    this.serverless.cli.log(`${streamName} (λ: ${functionName})`);

    const {location = '.'} = this.getConfig();

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = assignAll([
      {AWS_REGION: get('service.provider.region', this)},
      env,
      get('service.provider.environment', this),
      get('environment', __function)
    ]);
    process.env = functionEnv;

    const serviceRuntime = this.service.provider.runtime;
    const servicePath = join(this.serverless.config.servicePath, location);
    const funOptions = functionHelper.getFunctionOptions(
      __function,
      functionName,
      servicePath,
      serviceRuntime
    );
    const handler = functionHelper.createHandler(funOptions, this.getConfig());
    const lambdaContext = new LambdaContext(__function, this.service.provider, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${functionName} ${JSON.stringify(data) || ''}`
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
        awsRegion: get('service.provider.region', this)
      }))
    };

    const x = handler(event, lambdaContext, lambdaContext.done);
    if (x && typeof x.then === 'function' && typeof x.catch === 'function')
      x.then(lambdaContext.succeed).catch(lambdaContext.fail);
    else if (x instanceof Error) lambdaContext.fail(x);

    process.env = env;
  }

  getStreamName(streamEvent) {
    if (isString(streamEvent) && startsWith('arn:aws:kinesis', streamEvent))
      return extractStreamNameFromARN(streamEvent);
    if (isString(streamEvent.arn)) return extractStreamNameFromARN(streamEvent.arn);
    if (isString(streamEvent.streamName)) return streamEvent.streamName;

    if (streamEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = streamEvent.arn['Fn::GetAtt'];

      const name = get(`resources.Resources.${ResourceName}.Properties.Name`, this.service);
      if (isString(name)) return name;
    }

    throw new Error(
      `StreamName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-kinesis#functions`
    );
  }

  async createKinesisReadable(functionName, streamEvent, retry = false) {
    const client = this.getClient();
    const streamName = this.getStreamName(streamEvent);

    this.serverless.cli.log(`${streamName}`);

    const kinesisStream = await fromCallback(cb =>
      client.describeStream(
        {
          StreamName: streamName
        },
        cb
      )
    ).catch(err => null);
    if (!kinesisStream) {
      if (retry) {
        this.serverless.cli.log(`${streamName} - not Found, retrying in ${KINESIS_RETRY_DELAY}ms`);
        setTimeout(
          this.createKinesisReadable.bind(this),
          KINESIS_RETRY_DELAY,
          functionName,
          streamEvent,
          retry
        );
        return;
      } else throw new Error(NO_KINESIS_FOUND);
    }
    const {
      StreamDescription: {Shards: shards}
    } = kinesisStream;

    forEach(({ShardId: shardId}) => {
      const readable = KinesisReadable(
        client,
        streamName,
        assign(this.getConfig(), {
          shardId,
          limit: streamEvent.batchSize,
          iterator: streamEvent.startingPosition || 'TRIM_HORIZON'
        })
      );

      readable.pipe(
        new Writable({
          objectMode: true,
          write: (chunk, encoding, cb) => {
            const handleAttempt = () => {
              this.eventHandler(streamEvent, functionName, shardId, chunk, err =>
                err ? handleAttempt() : cb()
              );
            };

            handleAttempt();
          }
        })
      );
    }, shards);
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline Kinesis.`);

    forEach(([functionName, functionConfiguration]) => {
      const streams = pipe(
        get('events'),
        filter(
          overEvery([
            negate(matchesProperty('stream.enabled', false)),
            overSome([
              matchesProperty('stream.type', 'kinesis'),
              pipe(
                get('stream'),
                startsWith('arn:aws:kinesis')
              )
            ])
          ])
        ),
        map('stream')
      )(functionConfiguration);

      if (!isEmpty(streams)) {
        printBlankLine();
        this.serverless.cli.log(`Kinesis for ${functionName}:`);

        forEach(streamEvent => {
          this.createKinesisReadable(functionName, streamEvent, true); // TMP: retry is not configurable so far
        }, streams);

        printBlankLine();
      }
    })(toPairs(this.service.functions));
  }

  offlineStartEnd() {
    this.serverless.cli.log('offline-start-end');
  }
}

module.exports = ServerlessOfflineKinesis;
