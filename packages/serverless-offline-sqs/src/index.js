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

const log = require('@serverless/utils/log').log;

const SQS = require('./sqs');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-sqs';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  batchSize: 100,
  startingPosition: 'TRIM_HORIZON',
  autoCreate: false,

  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

class ServerlessOfflineSQS {
  constructor(serverless, cliOptions) {
    this.cliOptions = null;
    this.options = null;
    this.sqs = null;
    this.lambda = null;
    this.serverless = null;

    this.cliOptions = cliOptions;
    this.serverless = serverless;

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

    this.serverless.cli.log(
      `Starting Offline SQS at stage ${this.options.stage} (${this.options.region})`
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
        this.serverless.cli.log(`Got ${signal} signal. Offline Halting...`);

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

    this.serverless.cli.log('Halting offline server');

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

    this.sqs = new SQS(this.lambda, resources, this.options);

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

    log.debug('options:', this.options);
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
