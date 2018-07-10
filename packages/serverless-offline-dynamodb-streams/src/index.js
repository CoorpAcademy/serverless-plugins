const {join} = require('path');
const {Writable} = require('stream');
const figures = require('figures');
const DynamoDBStreams = require('aws-sdk/clients/dynamodbstreams');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const {mapValues, isEmpty, forEach, map, matchesProperty, filter, get, pipe} = require('lodash/fp');
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

class ServerlessOfflineDynamoDBStreams {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.service = serverless.service;
    this.options = options;
    this.config = this.service.custom['serverless-offline-dynamodb-streams'];

    this.commands = {};

    this.client = new DynamoDBStreams(this.config);

    this.hooks = {
      'before:offline:start:init': this.offlineStartInit.bind(this),
      'before:offline:start:end': this.offlineStartEnd.bind(this)
    };

    this.streams = [];
  }

  eventHandler(streamEvent, functionName, shardId, Records, cb) {
    this.serverless.cli.log(`${streamEvent.arn} (λ: ${functionName})`);

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
      Records
    };

    handler(event, lambdaContext, lambdaContext.done);
  }

  async createDynamoDBStreamReadable(functionName, streamEvent) {
    const arn = streamEvent.tableName
      ? await fromCallback(cb =>
          new DynamoDB(this.config).describeTable(
            {
              TableName: streamEvent.tableName
            },
            cb
          )
        ).then(get('Table.LatestStreamArn'))
      : streamEvent.arn;

    this.serverless.cli.log(`${arn}`);

    const {StreamDescription: {Shards: shards}} = await fromCallback(cb =>
      this.client.describeStream(
        {
          StreamArn: arn
        },
        cb
      )
    );

    forEach(({ShardId: shardId}) => {
      const readable = DynamoDBReadable(this.client, arn, {
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
        filter(matchesProperty('stream.type', 'dynamodb')),
        map(get('stream'))
      )(_function);

      if (!isEmpty(streams)) {
        printBlankLine();
        this.serverless.cli.log(`Kinesis for ${functionName}:`);
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
