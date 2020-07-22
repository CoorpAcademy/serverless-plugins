const {assign, omitBy, isUndefined, get, startsWith, pick} = require('lodash/fp');

const debugLog = require('serverless-offline/dist/debugLog').default;
const {default: serverlessLog, setLog} = require('serverless-offline/dist/serverlessLog');
const Lambda = require('serverless-offline/dist/lambda').default;

const Kinesis = require('./kinesis');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-kinesis';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineKinesis {
  constructor(serverless, cliOptions) {
    this.cliOptions = null;
    this.options = null;
    this.kinesis = null;
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

    const {kinesisEvents, lambdas} = this._getEvents();

    this._createLambda(lambdas);

    const eventModules = [];

    if (kinesisEvents.length > 0) {
      eventModules.push(this._createKinesis(kinesisEvents));
    }

    await Promise.all(eventModules);

    serverlessLog(`Starting Offline Kinesis: ${this.options.stage}/${this.options.region}.`);
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
    this.ready()
      .then(this.end)
      .catch(() => null);
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

    if (this.kinesis) {
      eventModules.push(this.kinesis.stop(SERVER_SHUTDOWN_TIMEOUT));
    }

    await Promise.all(eventModules);

    if (!skipExit) {
      // eslint-disable-next-line unicorn/no-process-exit
      process.exit(0);
    }
  }

  _createLambda(lambdas) {
    this.lambda = new Lambda(this.serverless, this.options);

    this.lambda.create(lambdas);
  }

  async _createKinesis(events, skipStart) {
    this.kinesis = new Kinesis(this.lambda, this.options);

    await this.kinesis.create(events);

    if (!skipStart) {
      await this.kinesis.start();
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
    const kinesisEvents = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {stream} = event;

        if (
          stream &&
          (stream.type === 'kinesis' || startsWith('arn:aws:kinesis', stream)) &&
          functionDefinition.handler
        ) {
          kinesisEvents.push({
            functionKey,
            handler: functionDefinition.handler,
            kinesis: this._resolveFn(stream)
          });
        }
      });
    });

    return {
      kinesisEvents,
      lambdas
    };
  }

  _resolveFn(event) {
    if (typeof event.streamName === 'string') return event;

    const getAtt = get(['arn', 'Fn::GetAtt'], event);
    if (getAtt) {
      const [resourceName] = getAtt;

      const properties = get(
        ['service', 'resources', 'Resources', resourceName, 'Properties'],
        this.serverless
      );
      if (!properties) throw new Error(`No resource defined with name ${resourceName}`);

      return assign(event, {streamName: properties.Name});
    }

    return event;
  }
}

module.exports = ServerlessOfflineKinesis;
