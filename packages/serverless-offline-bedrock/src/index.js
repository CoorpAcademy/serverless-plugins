const {get, isNil, isUndefined, omitBy, pick} = require('lodash/fp');

const {normalizeLog} = require('./log');
const Bedrock = require('./bedrock');
const {DEFAULT_HOST, DEFAULT_PORT, resolvePort} = require('./bedrock');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-bedrock';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  accountId: '000000000000'
};

const omitUndefined = omitBy(isUndefined);

// Deep-redact secret-bearing keys before debug-logging the merged options: the config can carry a
// backend `apiKey` or `provider.environment` secrets, and serverless debug output is routinely
// captured by CI/support tooling (Codex F5). Pure — returns a redacted copy, never mutates the input.
const SECRET_KEY = /(secret|token|password|api[-_]?key|access[-_]?key)/i;
const redactSecrets = value => {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        SECRET_KEY.test(key) ? '***' : redactSecrets(val)
      ])
    );
  return value;
};

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
  const port = resolvePort(options.port);
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

    // AC-A1/AC-X1 (Codex F1): only stand up the server AND inject the endpoint when enabled, and in
    // this order. Two orderings matter:
    //   • bind the server FIRST so we know the REAL port — `port: 0` asks the OS for a free port that
    //     is only known after listen(); injecting the configured `0` would point the client at a dead
    //     `:0` endpoint.
    //   • inject the endpoint env var BEFORE _createLambda: serverless-offline snapshots every `AWS_*`
    //     process.env key into each function's env at Lambda construction (LambdaFunction.js), so the
    //     unmodified BedrockRuntimeClient resolves to our local server with no app code change. The
    //     service-specific spelling AWS_ENDPOINT_URL_BEDROCK_RUNTIME is derived from serviceId
    //     "Bedrock Runtime" (proven by SPIKE 1). We deliberately do NOT set the generic
    //     AWS_ENDPOINT_URL — it would misroute the app's OTHER AWS clients (S3/SQS/DynamoDB) in a
    //     multi-service stack. When DISABLED we inject nothing, so the app's Bedrock client keeps its
    //     own target rather than a port nothing is listening on. Injection is a baseline default — an
    //     explicit YAML AWS_ENDPOINT_URL_BEDROCK_RUNTIME still wins (README).
    if (isPluginEnabled(this.options)) {
      await this._createBedrock();
      this._injectEndpointEnv();
    }

    const lambdas = this._getLambdas();

    await this._createLambda(lambdas);

    this.log.notice(
      `Starting Offline Bedrock at stage ${this.options.stage} (${this.options.region})`
    );
  }

  // Inject the endpoint using the ACTUAL bound port (known only after the server is listening, so
  // `port: 0` resolves to the OS-assigned port rather than a useless `:0`).
  _injectEndpointEnv() {
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = resolveEndpointUrl({
      host: this.options.host,
      port: this.bedrock.port
    });
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

    this.log.debug('bedrock options:', redactSecrets(this.options));
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
module.exports.redactSecrets = redactSecrets;
