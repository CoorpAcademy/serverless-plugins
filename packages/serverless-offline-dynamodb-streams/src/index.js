const {assign, omitBy, isUndefined, get, startsWith, pick} = require('lodash/fp');

const debugLog = require('serverless-offline/dist/debugLog').default;
const {default: serverlessLog, setLog} = require('serverless-offline/dist/serverlessLog');
const Lambda = require('serverless-offline/dist/lambda').default;

const DynamodbStreams = require('./dynamodb-streams');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-dynamodb-streams';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  accessKeyId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineDynamodbStreams {
  constructor(serverless, cliOptions) {
    this.cliOptions = null;
    this.options = null;
    this.dynamodbStreams = null;
    this.lambda = null;
    this.serverless = null;

    this.cliOptions = cliOptions;
    this.serverless = serverless;

    setLog((...args) => serverless.cli.log(...args));

    this.hooks = {
      'offline:start:init': this.start.bind(this),
      'offline:start:ready': this.ready.bind(this),
      'offline:start': this._startWithExplicitEnd.bind(this),
      'offline:start:end': this.end.bind(this)
    };
  }

  async start() {
    process.env.IS_OFFLINE = true;

    this._mergeOptions();

    const {dynamodbStreamsEvents, lambdas} = this._getEvents();

    this._createLambda(lambdas);

    const eventModules = [];

    if (dynamodbStreamsEvents.length > 0) {
      eventModules.push(this._createDynamodbStreams(dynamodbStreamsEvents));
    }

    await Promise.all(eventModules);

    serverlessLog(
      `Starting Offline Dynamodb Streams: ${this.options.stage}/${this.options.region}.`
    );
  }

  async ready() {
    if (process.env.NODE_ENV !== 'test') {
      await this._listenForTermination();
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async _listenForTermination() {
    const command = await new Promise(resolve => {
      process.on('SIGINT', () => resolve('SIGINT')).on('SIGTERM', () => resolve('SIGTERM'));
    });

    serverlessLog(`Got ${command} signal. Offline Halting...`);
  }

  async _startWithExplicitEnd() {
    await this.start();
    await this.ready();
    this.end();
  }

  async end(skipExit) {
    if (process.env.NODE_ENV === 'test' && skipExit === undefined) {
      return;
    }

    serverlessLog('Halting offline server');

    const eventModules = [];

    if (this.lambda) {
      eventModules.push(this.lambda.cleanup());
    }

    if (this.dynamodbStreams) {
      eventModules.push(this.dynamodbStreams.stop(SERVER_SHUTDOWN_TIMEOUT));
    }

    await Promise.all(eventModules);

    if (!skipExit) {
      process.exit(0);
    }
  }

  _createLambda(lambdas) {
    this.lambda = new Lambda(this.serverless, this.options);

    this.lambda.create(lambdas);
  }

  async _createDynamodbStreams(events, skipStart) {
    this.dynamodbStreams = new DynamodbStreams(this.lambda, this.options);

    await this.dynamodbStreams.create(events);

    if (!skipStart) {
      await this.dynamodbStreams.start();
    }
  }

  _mergeOptions() {
    const {
      service: {custom = {}, provider}
    } = this.serverless;

    const offlineOptions = custom[OFFLINE_OPTION];
    const customOptions = custom[CUSTOM_OPTION];

    this.options = Object.assign(
      {},
      omitUndefined(defaultOptions),
      omitUndefined(provider),
      omitUndefined(pick('location', offlineOptions)), // serverless-webpack support
      omitUndefined(customOptions),
      omitUndefined(this.cliOptions)
    );

    debugLog('options:', this.options);
  }

  _getEvents() {
    const {service} = this.serverless;

    const lambdas = [];
    const dynamodbStreamsEvents = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {stream} = event;

        if (
          stream &&
          (stream.type === 'dynamodb' || startsWith('arn:aws:dynamodb', stream)) &&
          functionDefinition.handler
        ) {
          dynamodbStreamsEvents.push({
            functionKey,
            handler: functionDefinition.handler,
            dynamodbStreams: this._resolveFn(stream)
          });
        }
      });
    });

    return {
      dynamodbStreamsEvents,
      lambdas
    };
  }

  _resolveFn(event) {
    if (typeof event.tableName === 'string') return event;

    const getAtt = get(['arn', 'Fn::GetAtt'], event);
    if (getAtt) {
      const [resourceName] = getAtt;

      const properties = get(
        ['service', 'resources', 'Resources', resourceName, 'Properties'],
        this.serverless
      );
      if (!properties) throw new Error(`No resource defined with name ${resourceName}`);

      return assign(event, {tableName: properties.TableName});
    }

    return event;
  }
}

module.exports = ServerlessOfflineDynamodbStreams;
