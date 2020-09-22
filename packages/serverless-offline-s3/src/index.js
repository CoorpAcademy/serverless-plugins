const {get, isUndefined, omitBy, pick} = require('lodash/fp');

const debugLog = require('serverless-offline/dist/debugLog').default;
const {default: serverlessLog, setLog} = require('serverless-offline/dist/serverlessLog');
const Lambda = require('serverless-offline/dist/lambda').default;

const S3 = require('./s3');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-s3';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  batchSize: 100,
  startingPosition: 'TRIM_HORIZON'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineS3 {
  constructor(serverless, cliOptions) {
    this.cliOptions = null;
    this.options = null;
    this.s3 = null;
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

    const {s3Events, lambdas} = this._getEvents();

    this._createLambda(lambdas);

    const eventModules = [];

    if (s3Events.length > 0) {
      eventModules.push(this._createS3(s3Events));
    }

    await Promise.all(eventModules);

    serverlessLog(`Starting Offline S3: ${this.options.endPoint}/${this.options.region}.`);
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

    if (this.s3) {
      eventModules.push(this.s3.stop(SERVER_SHUTDOWN_TIMEOUT));
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

  async _createS3(events, skipStart) {
    const resources = this._getResources();

    this.s3 = new S3(this.lambda, resources, this.options);

    await this.s3.create(events);

    if (!skipStart) {
      await this.s3.start();
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
    const s3Events = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {s3} = event;

        if (s3 && functionDefinition.handler) {
          s3Events.push({
            functionKey,
            handler: functionDefinition.handler,
            s3
          });
        }
      });
    });

    return {
      s3Events,
      lambdas
    };
  }

  _getResources() {
    const Resources = get(['service', 'resources', 'Resources'], this.serverless);
    return Resources;
  }
}

module.exports = ServerlessOfflineS3;
