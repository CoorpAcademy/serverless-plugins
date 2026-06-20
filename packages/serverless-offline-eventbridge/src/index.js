const {fromPairs, get, getOr, isUndefined, omitBy, pick, upperFirst} = require('lodash/fp');

const {normalizeLog} = require('./log');
const EventBridge = require('./eventbridge');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-eventbridge';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  host: '127.0.0.1',
  port: 4010,
  pollInterval: 1000,
  maximumRetryAttempts: 10,
  retryDelayMs: 500,
  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

// Serverless derives a function's CloudFormation logical id as
// `upperFirst(functionKey stripped of non-alphanumerics) + "LambdaFunction"`. We rebuild that map so
// a raw `AWS::Events::Rule` target (`{Fn::GetAtt: [<LogicalId>, Arn]}`) can be traced back to its
// function key. (#naming — serverless/lib/plugins/aws/lib/naming.js getLambdaLogicalId)
const toLogicalId = functionKey =>
  `${upperFirst(functionKey.replace(/[^0-9A-Za-z]/g, ''))}LambdaFunction`;

class ServerlessOfflineEventBridge {
  constructor(serverless, cliOptions, {log} = {}) {
    this.cliOptions = cliOptions;
    this.serverless = serverless;
    this.log = normalizeLog(log);

    this.hooks = {
      'offline:start:init': this.start.bind(this),
      'offline:start:ready': this.ready.bind(this),
      'offline:start': this._startWithReady.bind(this),
      'offline:start:end': this.end.bind(this)
    };
  }

  async start() {
    process.env.IS_OFFLINE = true;

    this._mergeOptions();

    const {eventBridgeEvents, lambdas} = this._getEvents();

    await this._createLambda(lambdas);

    const eventModules = [];

    if (eventBridgeEvents.length > 0 || this._hasResourceRules()) {
      eventModules.push(this._createEventBridge(eventBridgeEvents));
    }

    await Promise.all(eventModules);

    this.log.notice(
      `Starting Offline EventBridge at stage ${this.options.stage} (${this.options.region})`
    );
  }

  ready() {
    if (process.env.NODE_ENV !== 'test') {
      this._listenForTermination();
    }
  }

  _listenForTermination() {
    const signals = ['SIGINT', 'SIGTERM'];

    signals.map(signal =>
      process.on(signal, async () => {
        this.log.notice(`Got ${signal} signal. Offline Halting...`);

        await this.end();
      })
    );
  }

  async _startWithReady() {
    await this.start();
    this.ready();
  }

  async end(skipExit) {
    if (process.env.NODE_ENV === 'test' && skipExit === undefined) {
      return;
    }

    this.log.notice('Halting offline server');

    const eventModules = [];

    if (this.lambda) {
      eventModules.push(this.lambda.cleanup());
    }

    if (this.eventBridge) {
      eventModules.push(this.eventBridge.stop(SERVER_SHUTDOWN_TIMEOUT));
    }

    await Promise.all(eventModules);

    if (!skipExit) {
      process.exit(0);
    }
  }

  async _createLambda(lambdas) {
    const {default: Lambda} = await import('serverless-offline/lambda');
    this.lambda = new Lambda(this.serverless, this.options);

    this.lambda.create(lambdas);
  }

  async _createEventBridge(events, skipStart) {
    this.eventBridge = new EventBridge(this.lambda, this.options, this.log);

    await this.eventBridge.create(events);

    if (!skipStart) {
      await this.eventBridge.start();
    }
  }

  _hasResourceRules() {
    const Resources = getOr({}, ['service', 'resources', 'Resources'], this.serverless);
    return Object.values(Resources).some(resource => get('Type', resource) === 'AWS::Events::Rule');
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
      omitUndefined(pick(['location', 'localEnvironment'], offlineOptions)), // serverless-webpack support
      omitUndefined(customOptions),
      omitUndefined(this.cliOptions),
      // CFN-rule discovery surfaces (consumed by EventBridge.create); always overwritten here so
      // user config can never shadow them.
      {
        resources: getOr({}, ['service', 'resources'], this.serverless),
        functionsByLogicalId: this._functionsByLogicalId(),
        destinationsByFunction: this._destinationsByFunction()
      }
    );

    this.log.debug('eventbridge options:', this.options);
  }

  _functionsByLogicalId() {
    const {service} = this.serverless;
    return fromPairs(
      service.getAllFunctions().map(functionKey => [toLogicalId(functionKey), functionKey])
    );
  }

  _destinationsByFunction() {
    const {service} = this.serverless;
    return fromPairs(
      service
        .getAllFunctions()
        .map(functionKey => [functionKey, get('destinations', service.getFunction(functionKey))])
    );
  }

  _getEvents() {
    const {service} = this.serverless;

    const lambdas = [];
    const eventBridgeEvents = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {eventBridge} = event;

        if (eventBridge && functionDefinition.handler) {
          eventBridgeEvents.push({
            functionKey,
            handler: functionDefinition.handler,
            destinations: get('destinations', functionDefinition),
            eventBridge
          });
        }
      });
    });

    return {
      eventBridgeEvents,
      lambdas
    };
  }
}

module.exports = ServerlessOfflineEventBridge;
module.exports.toLogicalId = toLogicalId;
