const {
  compact,
  fromPairs,
  get,
  has,
  isPlainObject,
  isUndefined,
  map,
  omitBy,
  pick,
  pipe,
  toPairs
} = require('lodash/fp');

const {normalizeLog} = require('./log');
const SQS = require('./sqs');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-sqs';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  batchSize: 100,
  startingPosition: 'TRIM_HORIZON',
  autoCreate: false,

  // #158 (raymond-w-ko): serverless-offline's LambdaFunctionPool schedules its idle-cleanup timer
  // as setTimeout(fn, options.<idleOption> * 1000). The plugin builds its own pool options, so when
  // the option is missing the product is NaN and the timer busy-loops at ~50% CPU on idle. The key
  // was renamed across serverless-offline versions (functionCleanupIdleTimeSeconds <= v12,
  // terminateIdleLambdaTime >= v13); default both to serverless-offline's own default (60s).
  functionCleanupIdleTimeSeconds: 60,
  terminateIdleLambdaTime: 60,

  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineSQS {
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

    const {sqsEvents, lambdas} = this._getEvents();

    await this._createLambda(lambdas);

    const eventModules = [];

    if (sqsEvents.length > 0) {
      eventModules.push(this._createSqs(sqsEvents));
    }

    await Promise.all(eventModules);

    this.log.notice(`Starting Offline SQS at stage ${this.options.stage} (${this.options.region})`);
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

    if (this.sqs) {
      eventModules.push(this.sqs.stop(SERVER_SHUTDOWN_TIMEOUT));
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

  async _createSqs(events, skipStart) {
    const resources = this._getResources();

    this.sqs = new SQS(this.lambda, resources, this.options, this.log);

    await this.sqs.create(events);

    if (!skipStart) {
      await this.sqs.start();
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
      omitUndefined(pick(['location', 'localEnvironment'], offlineOptions)), // serverless-webpack support
      omitUndefined(customOptions),
      omitUndefined(this.cliOptions)
    );

    this.log.debug('sqs options:', this.options);
  }

  _getEvents() {
    const {service} = this.serverless;

    const lambdas = [];
    const sqsEvents = [];

    const functionKeys = service.getAllFunctions();

    functionKeys.forEach(functionKey => {
      const functionDefinition = service.getFunction(functionKey);

      lambdas.push({functionKey, functionDefinition});

      const events = service.getAllEventsInFunction(functionKey) || [];

      events.forEach(event => {
        const {sqs} = this._resolveFn(event);

        if (sqs && functionDefinition.handler) {
          sqsEvents.push({
            functionKey,
            handler: functionDefinition.handler,
            sqs
          });
        }
      });
    });

    return {
      sqsEvents,
      lambdas
    };
  }

  _resolveFn(obj) {
    const Resources = get(['service', 'resources', 'Resources'], this.serverless);

    return pipe(
      toPairs,
      map(([key, value]) => {
        if (!isPlainObject(value)) return [key, value];

        if (has('Fn::GetAtt', value)) {
          const [resourceName, attribute] = value['Fn::GetAtt'];

          switch (attribute) {
            case 'Arn': {
              const type = get([resourceName, 'Type'], Resources);

              switch (type) {
                case 'AWS::SQS::Queue': {
                  const queueName = get([resourceName, 'Properties', 'QueueName'], Resources);
                  return [
                    key,
                    `arn:aws:sqs:${this.options.region}:${this.options.accountId}:${queueName}`
                  ];
                }
                default: {
                  return null;
                }
              }
            }
            default: {
              return null;
            }
          }
        }
        return [key, this._resolveFn(value)];
      }),
      compact,
      fromPairs
    )(obj);
  }

  _getResources() {
    const Resources = get(['service', 'resources', 'Resources'], this.serverless);
    return this._resolveFn(Resources);
  }
}

module.exports = ServerlessOfflineSQS;
module.exports.defaultOptions = defaultOptions;
