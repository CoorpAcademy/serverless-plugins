const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const DynamoDBStreams = require('aws-sdk/clients/dynamodbstreams');
const DynamoDB = require('aws-sdk/clients/dynamodb');
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
const createLambdaContext = require('serverless-offline/src/createLambdaContext');
const DynamoDBReadable = require('dynamodb-streams-readable');

const fromCallback = fun =>
  new Promise((resolve, reject) => {
    fun((err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

const printBlankLine = () => console.log();

const extractTableNameFromARN = arn => {
  const [, , , , , TableURI] = arn.split(':');
  const [, TableName] = TableURI.split('/');
  return TableName;
};

class ServerlessOfflineDynamoDBStreams {
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
      omitBy(isUndefined, get(['custom', 'serverless-offline-dynamodb-streams'], this.service))
    ]);
  }

  getDynamoDBClient() {
    return new DynamoDB(this.getConfig());
  }

  getDynamoDBStreamsClient() {
    return new DynamoDBStreams(this.getConfig());
  }

  eventHandler(streamARN, functionName, shardId, Records, cb) {
    this.serverless.cli.log(`${extractTableNameFromARN(streamARN)} (λ: ${functionName})`);

    const {location = '.'} = this.getConfig();

    const __function = this.service.getFunction(functionName);

    const {env} = process;
    const functionEnv = assignAll([
      {},
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

    const lambdaContext = createLambdaContext(__function, this.service.provider, (err, data) => {
      this.serverless.cli.log(
        `[${err ? figures.cross : figures.tick}] ${JSON.stringify(data) || ''}`
      );
      cb(err, data);
    });
    const event = {
      Records
    };

    const x = handler(event, lambdaContext, lambdaContext.done);
    if (x && typeof x.then === 'function' && typeof x.catch === 'function')
      x.then(lambdaContext.succeed).catch(lambdaContext.fail);
    else if (x instanceof Error) lambdaContext.fail(x);

    process.env = env;
  }

  async createDynamoDBStreamReadable(functionName, tableEvent) {
    const dynamodbClient = this.getDynamoDBClient();
    const dynamodbStreamsClient = this.getDynamoDBStreamsClient();
    const tableName = this.getTableName(tableEvent);

    const streamARN = await fromCallback(cb =>
      dynamodbClient.describeTable(
        {
          TableName: tableName
        },
        cb
      )
    ).then(get('Table.LatestStreamArn'));

    this.serverless.cli.log(`${streamARN}`);

    const {
      StreamDescription: {Shards: shards}
    } = await fromCallback(cb =>
      dynamodbStreamsClient.describeStream(
        {
          StreamArn: streamARN
        },
        cb
      )
    );

    forEach(({ShardId: shardId}) => {
      const readable = DynamoDBReadable(
        dynamodbStreamsClient,
        streamARN,
        assign(this.getConfig(), {
          shardId,
          limit: tableEvent.batchSize,
          iterator: tableEvent.startingPosition || 'TRIM_HORIZON'
        })
      );

      readable.pipe(
        new Writable({
          objectMode: true,
          write: (chunk, encoding, cb) => {
            const handleAttempt = () => {
              this.eventHandler(streamARN, functionName, shardId, chunk, err =>
                err ? handleAttempt() : cb()
              );
            };

            handleAttempt();
          }
        })
      );
    }, shards);
  }

  getTableName(tableEvent) {
    if (typeof tableEvent === 'string' && startsWith('arn:aws:dynamodb', tableEvent))
      return extractTableNameFromARN(tableEvent);
    if (typeof tableEvent.arn === 'string') return extractTableNameFromARN(tableEvent.arn);
    if (typeof tableEvent.streamName === 'string') return tableEvent.streamName;

    if (tableEvent.arn['Fn::GetAtt']) {
      const [ResourceName] = tableEvent.arn['Fn::GetAtt'];

      if (
        this.service &&
        this.service.resources &&
        this.service.resources.Resources &&
        this.service.resources.Resources[ResourceName] &&
        this.service.resources.Resources[ResourceName].Properties &&
        typeof this.service.resources.Resources[ResourceName].Properties.TableName === 'string'
      )
        return this.service.resources.Resources[ResourceName].Properties.TableName;
    }

    throw new Error(
      `TableName not found. See https://github.com/CoorpAcademy/serverless-plugins/tree/master/packages/serverless-offline-dynamodb-streams#functions`
    );
  }

  offlineStartInit() {
    this.serverless.cli.log(`Starting Offline DynamodbStream.`);

    mapValues.convert({cap: false})((_function, functionName) => {
      const streams = pipe(
        get('events'),
        filter(
          event =>
            !matchesProperty('stream.enabled', false)(event) &&
            (matchesProperty('stream.type', 'dynamodb')(event) ||
              startsWith('arn:aws:dynamodb', event.stream))
        ),
        map(get('stream'))
      )(_function);

      if (!isEmpty(streams)) {
        printBlankLine();
        this.serverless.cli.log(`DynamodbStream for ${functionName}:`);
      }

      forEach(streamEvent => {
        this.createDynamoDBStreamReadable(functionName, streamEvent);
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

module.exports = ServerlessOfflineDynamoDBStreams;
