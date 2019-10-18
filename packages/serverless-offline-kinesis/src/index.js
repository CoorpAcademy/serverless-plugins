const path = require('path');
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
  isObject,
  isArray,
  pipe,
  startsWith
} = require('lodash/fp');
const functionHelper = require('serverless-offline/src/functionHelper');
const LambdaContext = require('serverless-offline/src/LambdaContext');

const NO_KINESIS_FOUND = 'Could not find kinesis stream';
const KINESIS_RETRY_DELAY = 200;
const KINESIS_RETRY_TIMEOUT = 30000;

const printBlankLine = () => console.log();

const extractStreamNameFromARN = arn => {
  const [, , , , , StreamURI] = arn.split(':');
  const [, ...StreamNames] = StreamURI.split('/');
  return StreamNames.join('/');
};

const extractRessourceNameFromGetAtt = getAtt => {
  if (isArray(getAtt)) return getAtt[0];
  if (isString(getAtt) && getAtt.endsWith('.Arn')) return getAtt.replace(/\.Arn$/, '');
  throw new Error('Unable to parse Fn::GetAtt for stream cross-reference');
};

const extractStreamNameFromJoin = ([delimiter, parts]) => {
  const resolvedParts = parts.map(part => {
    if (isString(part)) return part;
    if (isObject(part)) return ''; // empty string as placeholder
    return '';
  });
  return extractStreamNameFromARN(resolvedParts.join(delimiter));
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
    const servicePath = path.join(this.serverless.config.servicePath, location);
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

    const {'Fn::GetAtt': getAtt, 'Fn::Join': join} = streamEvent.arn;
    if (getAtt) {
      const ResourceName = extractRessourceNameFromGetAtt(getAtt);
      const streamName = get(`resources.Resources.${ResourceName}.Properties.Name`, this.service);
      if (isString(streamName)) return streamName;
    }
    if (join) {
      // TODO possible improvement: handle getAtt in Join
      const streamName = extractStreamNameFromJoin(join);
      if (isString(streamName)) return streamName;
    }

    this.serverless.cli.log(
      `Could not resolve stream name for spec: ${JSON.stringify(streamEvent, null, 2)}`
    );

    throw new Error(
      `StreamName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-kinesis#functions`
    );
  }

  async createKinesisReadable(functionName, streamEvent, delay = null) {
    const client = this.getClient();
    const streamName = this.getStreamName(streamEvent);

    this.serverless.cli.log(`Waiting for ${streamName} to become active`);

    const kinesisStream = await client
      .describeStream({
        StreamName: streamName
      })
      .promise()
      .then(({StreamDescription}) => {
        if (StreamDescription.StreamStatus !== 'ACTIVE')
          throw new Error('Stream found but not yet active');
        return {StreamDescription};
      })
      .catch(err => err);

    if (kinesisStream instanceof Error) {
      if (delay === null) throw new Error(NO_KINESIS_FOUND);
      if (delay < KINESIS_RETRY_DELAY)
        throw new Error(`Stream ${streamName} did not become active within specified timeout`);

      this.serverless.cli.log(
        `${streamName} - not found because of ${
          kinesisStream.code
        }, retrying in ${KINESIS_RETRY_DELAY}ms`
      );
      return setTimeout(() => {
        this.createKinesisReadable(functionName, streamEvent, delay - KINESIS_RETRY_DELAY);
      }, KINESIS_RETRY_DELAY);
    }

    const {
      StreamDescription: {Shards: shards}
    } = kinesisStream;
    this.serverless.cli.log(`${streamName} - creating listeners for ${shards.length} shards`);

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

        const waitForStreamDelay = this.getConfig().waitForActiveTimeout || KINESIS_RETRY_TIMEOUT;
        // ! FIXME: probably rename (and document the variable name)
        forEach(streamEvent => {
          this.createKinesisReadable(functionName, streamEvent, waitForStreamDelay);
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
