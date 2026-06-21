const {
  compact,
  fromPairs,
  get,
  has,
  isNil,
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

  // #123: default receiveMessage long-poll WaitTimeSeconds. Overridable per service via
  // custom.serverless-offline-sqs.waitTimeSeconds or the --waitTimeSeconds CLI flag (both threaded
  // through _mergeOptions over this default); a per-event `maximumBatchingWindow` still wins. Kept at
  // the historical 5s — do NOT raise it (a higher default slows local short-poll dev loops). Coerced
  // and clamped to [0, 20] at use in resolveWaitTimeSeconds, so a string from YAML/CLI is honored.
  waitTimeSeconds: 5,

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

// #222 (gndelia): allow locally skipping the whole SQS emulator (e.g. when only HTTP lambdas are
// needed and no local queue system is running) without commenting out the plugin. Honors
// `custom.serverless-offline-sqs.enabled: false` (also a `--enabled false` CLI flag); enabled by
// default when unset. YAML/CLI may deliver the value as the string "false", so treat that as off too.
const isPluginEnabled = options => {
  const enabled = get('enabled', options);
  if (isNil(enabled)) return true;
  if (enabled === 'false') return false;
  return Boolean(enabled);
};

// #255 (10Bude10, visrut-at-handldigital): an SQS event `arn` may be a bare `{Ref: <QueueLogicalId>}`
// pointing at a queue declared in resources.Resources — CloudFormation's Ref on an AWS::SQS::Queue
// yields the queue URL, but offline we only need a stable ARN whose last segment is the queue name.
// Mirror the Fn::GetAtt Arn branch: resolve a Ref to an AWS::SQS::Queue to its ARN, preferring the
// declared Properties.QueueName and falling back to the logical id (the name serverless gives an
// auto-named queue locally). Returns undefined for a Ref to anything that is not an SQS queue (e.g.
// AWS::* pseudo-params, other resource types) so the caller leaves the intrinsic untouched.
// Pure + non-throwing.
const resolveSqsRefArn = (resources, refName, region, accountId) => {
  if (get([refName, 'Type'], resources) !== 'AWS::SQS::Queue') return undefined;
  const queueName = get([refName, 'Properties', 'QueueName'], resources) || refName;
  return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
};

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

    // #222 (gndelia): skip SQS setup entirely when disabled, but still create the lambdas so plain
    // HTTP functions keep working under serverless-offline.
    if (isPluginEnabled(this.options) && sqsEvents.length > 0) {
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
            destinations: get('destinations', functionDefinition),
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
              const arn = resolveSqsRefArn(
                Resources,
                resourceName,
                this.options.region,
                this.options.accountId
              );
              return arn ? [key, arn] : null;
            }
            default: {
              return null;
            }
          }
        }

        // #255: a bare `{Ref: <QueueLogicalId>}` to an AWS::SQS::Queue resolves to that queue's ARN,
        // mirroring the Fn::GetAtt Arn branch. A Ref to anything else (e.g. AWS pseudo-params) is left
        // untouched for the downstream resolveCfnValue path.
        if (has('Ref', value)) {
          const arn = resolveSqsRefArn(
            Resources,
            value.Ref,
            this.options.region,
            this.options.accountId
          );
          return arn ? [key, arn] : [key, value];
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
module.exports.isPluginEnabled = isPluginEnabled;
module.exports.resolveSqsRefArn = resolveSqsRefArn;
