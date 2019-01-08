const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const DynamoDBStreams = require('aws-sdk/clients/dynamodbstreams');
const DynamoDB = require('aws-sdk/clients/dynamodb');
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
const DynamoDBReadable = require('dynamodb-streams-readable');

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
    this.config = getConfig(this.service, 'serverless-offline-dynamodb-streams');

    this.commands = {};

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  getDynamoDBClient() {
    const awsConfig = Object.assign(
      {
        region: this.options.region || this.service.provider.region || 'us-west-2'
      },
      this.config
    );
    return new DynamoDB(awsConfig);
  }

  getDynamoDBStreamsClient() {
    const awsConfig = Object.assign(
      {
        region: this.options.region || this.service.provider.region || 'us-west-2'
      },
      this.config
    );
    return new DynamoDBStreams(awsConfig);
  }

  eventHandler(streamARN, functionName, shardId, Records, cb) {
    this.serverless.cli.log(`${extractTableNameFromARN(streamARN)} (λ: ${functionName})`);

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
      Records
    };

    if (handler.length < 3)
      handler(event, lambdaContext)
        .then(res => lambdaContext.done(null, res))
        .catch(lambdaContext.done);
    else handler(event, lambdaContext, lambdaContext.done);

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

    const {StreamDescription: {Shards: shards}} = await fromCallback(cb =>
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
        Object.assign({}, this.config, {
          shardId,
          limit: tableEvent.batchSize,
          iterator: tableEvent.startingPosition || 'TRIM_HORIZON'
        })
      );

      readable.pipe(
        new Writable({
          objectMode: true,
          write: (chunk, encoding, cb) => {
            this.eventHandler(streamARN, functionName, shardId, chunk, cb);
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
      `TableName not found. See https://github.com/godu/serverless/tree/master/packages/serverless-offline-dynamodb-streams#functions`
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
