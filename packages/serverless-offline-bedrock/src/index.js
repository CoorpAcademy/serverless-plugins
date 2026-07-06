const {get, isNil, isUndefined, omitBy, pick} = require('lodash/fp');

const {normalizeLog} = require('./log');
const Bedrock = require('./bedrock');
const {DEFAULT_HOST, DEFAULT_PORT} = require('./bedrock');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-bedrock';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

// Mirrors serverless-offline-sqs #222: allow disabling the whole emulator via
// `custom.serverless-offline-bedrock.enabled: false` without removing the plugin (AC-X1). YAML/CLI
// may deliver the value as the string "false", so treat that as off too; enabled by default.
const isPluginEnabled = options => {
  const enabled = get('enabled', options);
  if (isNil(enabled)) return true;
  if (enabled === 'false') return false;
  return Boolean(enabled);
};

// The endpoint the offline Lambda's Bedrock client must resolve to. host `0.0.0.0` is a bind-all
// address, not a connect target, so the connectable URL uses localhost. Pure/total.
const resolveEndpointUrl = options => {
  const host = options.host || DEFAULT_HOST;
  const connectHost = host === '0.0.0.0' ? 'localhost' : host;
  const port = Number(options.port) || DEFAULT_PORT;
  return `http://${connectHost}:${port}`;
};

class ServerlessOfflineBedrock {
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

    // AC-A1: inject the AWS SDK v3 endpoint env vars BEFORE _createLambda. serverless-offline copies
    // every `AWS_*` process.env key into the lazy per-function env snapshot (LambdaFunction.js), so
    // the unmodified BedrockRuntimeClient in the handler resolves to our local server with no app
    // code change. The service-specific spelling is derived from serviceId "Bedrock Runtime" by
    // @smithy/core getEndpointUrlConfig; the generic var is a belt-and-suspenders fallback. Injection
    // is a baseline default — an explicit YAML AWS_ENDPOINT_URL_* still wins (documented in README).
    this._injectEndpointEnv();

    const lambdas = this._getLambdas();

    await this._createLambda(lambdas);

    // AC-X1: when disabled, still create the lambdas (plain HTTP fns keep working) but skip the server.
    if (isPluginEnabled(this.options)) {
      await this._createBedrock();
    }

    this.log.notice(
      `Starting Offline Bedrock at stage ${this.options.stage} (${this.options.region})`
    );
  }

  _injectEndpointEnv() {
    const endpoint = resolveEndpointUrl(this.options);
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = endpoint;
    if (isNil(process.env.AWS_ENDPOINT_URL)) process.env.AWS_ENDPOINT_URL = endpoint;
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

    const modules = [];

    if (this.lambda) {
      modules.push(this.lambda.cleanup());
    }

    // AC-X2: stop the local server and release the port on shutdown.
    if (this.bedrock) {
      modules.push(this.bedrock.stop(SERVER_SHUTDOWN_TIMEOUT));
    }

    await Promise.all(modules);

    if (!skipExit) {
      process.exit(0);
    }
  }

  async _createLambda(lambdas) {
    const {default: Lambda} = await import('serverless-offline/lambda');
    this.lambda = new Lambda(this.serverless, this.options);

    this.lambda.create(lambdas);
  }

  async _createBedrock() {
    this.bedrock = new Bedrock(this.options, this.log);
    await this.bedrock.start();
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

    this.log.debug('bedrock options:', this.options);
  }

  _getLambdas() {
    const {service} = this.serverless;
    const functionKeys = service.getAllFunctions();

    return functionKeys.map(functionKey => {
      const functionDefinition = service.getFunction(functionKey);
      return {functionKey, functionDefinition};
    });
  }
}

module.exports = ServerlessOfflineBedrock;
module.exports.defaultOptions = defaultOptions;
module.exports.isPluginEnabled = isPluginEnabled;
module.exports.resolveEndpointUrl = resolveEndpointUrl;
