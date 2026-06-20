const {
  compact,
  fromPairs,
  get,
  has,
  isNil,
  isPlainObject,
  isUndefined,
  map,
  mapValues,
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

// #132 (sqs-http-cofunction-registration): serverless-offline v13 owns the whole `offline:start`
// lifecycle. Its hook map is:
//   offline:start        -> #startWithExplicitEnd  (start + ready + end; ready BLOCKS on a signal)
//   offline:start:init   -> start
//   offline:start:ready  -> ready
//   offline:start:end    -> end
// The documented contract (serverless-offline README, "Usage with other plugins") is that
// augmenting plugins listen to `offline:start:init` / `offline:start:end` and the user runs
// `serverless offline start`. This plugin used to ALSO register the bare `offline:start` hook
// (`_startWithReady`), which then co-ran on the same lifecycle event as serverless-offline's own
// `#startWithExplicitEnd`. The two compete: if serverless-offline's hook runs first it blocks in
// `#ready()` and the SQS start never runs (HTTP up, SQS dead); if ours runs first its `ready()`
// installs `process.exit(0)` SIGINT/SIGTERM handlers that tear the shared process down from under
// serverless-offline's HTTP server. Either way only one side wires up — the reported symptom.
//
// Fix: build the hook map WITHOUT the bare `offline:start` key, so the plugin only AUGMENTS
// serverless-offline's lifecycle (init/ready/end) and never pre-empts it. Keep the decision as a
// pure, exported value so it is unit-testable in isolation from the Serverless runtime.
// `offline:start:end` maps to `stop` (not `end`) so the plugin tears down only its own SQS/lambda
// resources and lets serverless-offline own the `process.exit` — see #132 note above.
const HOOK_METHOD_BY_EVENT = {
  'offline:start:init': 'start',
  'offline:start:ready': 'ready',
  'offline:start:end': 'stop'
};

const buildHookMap = () => ({...HOOK_METHOD_BY_EVENT});

// #132: the SIGINT/SIGTERM listener is what makes AVA/CI hang and what would `process.exit` the
// shared run, so it is skipped entirely under NODE_ENV=test. Extracted as a pure predicate so the
// gate (test env -> no termination trap) is asserted directly.
const shouldListenForTermination = nodeEnv => nodeEnv !== 'test';

class ServerlessOfflineSQS {
  constructor(serverless, cliOptions, {log} = {}) {
    this.cliOptions = cliOptions;
    this.serverless = serverless;
    this.log = normalizeLog(log);

    // #132: register only the augmenting lifecycle hooks (init/ready/end). Binding the methods named
    // by the pure hook map keeps the wiring declarative and free of the bare `offline:start` hook
    // that used to compete with serverless-offline's own start path.
    this.hooks = mapValues(methodName => this[methodName].bind(this), buildHookMap());
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
    if (shouldListenForTermination(process.env.NODE_ENV)) {
      this._listenForTermination();
    }
  }

  _listenForTermination() {
    const signals = ['SIGINT', 'SIGTERM'];

    signals.map(signal =>
      process.on(signal, async () => {
        this.log.notice(`Got ${signal} signal. Offline Halting...`);

        // #132: clean up only our own lambda/sqs resources and let serverless-offline own process
        // termination. Calling end() with skipExit avoids a `process.exit(0)` that would tear down
        // the shared run (and its HTTP server) out from under serverless-offline's own SIGINT path.
        await this.end(true);
      })
    );
  }

  // #132: the `offline:start:end` lifecycle hook. Cleans up the SQS/lambda resources but never
  // forces a process exit, so serverless-offline's own `offline:start:end` handler is free to run
  // and own the shutdown of the shared HTTP server / process.
  async stop() {
    await this.end(true);
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
module.exports.isPluginEnabled = isPluginEnabled;
module.exports.buildHookMap = buildHookMap;
module.exports.shouldListenForTermination = shouldListenForTermination;
