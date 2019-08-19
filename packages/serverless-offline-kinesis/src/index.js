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
  mapValues,
  matchesProperty,
  omitBy,
  pipe,
  startsWith
} = require('lodash/fp');
const functionHelper = require('serverless-offline/src/functionHelper');
const LambdaContext = require('serverless-offline/src/LambdaContext');

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

const extractStreamNameFromGetAtt = getAtt => {
  let logicalResourceName;
  if (Array.isArray(getAtt)) {
    logicalResourceName = getAtt[0];
  } else if (typeof getAtt === 'string' && /\w+\.Arn$/.test(getAtt)) {
    logicalResourceName = /(\w+)\.Arn$/.exec(getAtt)[1];
  } else {
    throw new Error('Unable to parse Fn::GetAtt for stream cross-reference');
  }
  return logicalResourceName;
}

const extractStreamNameFromJoin = join => {
  const [delimiter, parts] = join;
  const resolvedParts = parts.map(part => {
    if (typeof part === 'string') {
      return part
    } else if (typeof part === 'object') {
      return 'placeholder';
    }
  });
  const arn = resolvedParts.join(delimiter);
  return extractStreamNameFromARN(arn);
}

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
    return assignAll([
      omitBy(isUndefined, this.options),
      omitBy(isUndefined, this.service),
      omitBy(isUndefined, this.service.provider),
      omitBy(isUndefined, get(['custom', 'serverless-offline'], this.service)),
      omitBy(isUndefined, get(['custom', 'serverless-offline-kinesis'], this.service))
    ]);
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
    if (typeof streamEvent === 'string' && startsWith('arn:aws:kinesis', streamEvent))
      return extractStreamNameFromARN(streamEvent);
    if (typeof streamEvent.arn === 'string') return extractStreamNameFromARN(streamEvent.arn);
    if (typeof streamEvent.streamName === 'string') return streamEvent.streamName;

    const getAtt = streamEvent.arn['Fn::GetAtt'];
    if (getAtt) {
      const logicalResourceName = extractStreamNameFromGetAtt(getAtt);
      const physicalResourceName = get(['service', 'resources', 'Resources', logicalResourceName, 'Properties', 'Name'])(this);
      if (typeof physicalResourceName === 'string')
        return physicalResourceName;
    }
    const join = streamEvent.arn['Fn::Join'];
    if (join) {
      const physicalResourceName = extractStreamNameFromJoin(join);
      if (typeof physicalResourceName === 'string')
        return physicalResourceName;
    }

    throw new Error(
      `StreamName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-kinesis#functions`
    );
  }

  pollStreamUntilActive(streamName, timeout) {
    const client = this.getClient();
    const lastTime = Date.now() + timeout;
    return new Promise((resolve, reject) => {
      const poll = async () => {
        const { StreamDescription: { StreamStatus } } = await client.describeStream({ StreamName: streamName }).promise();
        if (StreamStatus === 'ACTIVE') {
          resolve();
        } else if (Date.now() > lastTime) {
          reject(new Error(`Stream ${streamName} did not become active within timeout of ${Math.floor(timeout/1000)}s`));
        } else {
          setTimeout(poll, 1000);
        }
      };
      poll();
    });
  }

  async createKinesisReadable(functionName, streamEvent) {
    const client = this.getClient();
    const streamName = this.getStreamName(streamEvent);

    this.serverless.cli.log(`Waiting for ${streamName} to become active`);

    await this.pollStreamUntilActive(streamName, this.getConfig().waitForActiveTimeout || 30000);

    const {
      StreamDescription: {Shards: shards}
    } = await client.describeStream(
      {
        StreamName: streamName
      },
    ).promise();
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
module.exports.extractStreamNameFromGetAtt = extractStreamNameFromGetAtt;
