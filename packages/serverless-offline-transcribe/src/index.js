const {get, isNil, isUndefined, omitBy, pick} = require('lodash/fp');

const {normalizeLog} = require('./log');
const Transcribe = require('./transcribe');
const {DEFAULT_HOST, DEFAULT_PORT, resolvePort} = require('./transcribe');

const OFFLINE_OPTION = 'serverless-offline';
const CUSTOM_OPTION = 'serverless-offline-transcribe';

const SERVER_SHUTDOWN_TIMEOUT = 5000;

const defaultOptions = {
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
  accountId: '000000000000',
  // Whisper model (base is the smallest useful default; tiny/small/medium/large also valid).
  model: 'base',
  // Local S3 (Minio) defaults — mirror the serverless-offline-s3 convention.
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKey: 'minioadmin',
  secretKey: 'minioadmin'
};

const omitUndefined = omitBy(isUndefined);

// Deep-redact secret-bearing keys before debug-logging the merged options: the config carries the
// local S3 (Minio) `accessKey`/`secretKey` (and any `provider.environment` secrets), and serverless
// debug output is routinely captured by CI/support tooling (Codex F5). Pure — returns a redacted
// copy, never mutates the input.
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

// Mirrors the sibling plugins' #222 convention: disable the whole emulator via
// `custom.serverless-offline-transcribe.enabled: false` (AC-X1). YAML/CLI may deliver the string
// "false"; treat that as off too. Enabled by default.
const isPluginEnabled = options => {
  const enabled = get('enabled', options);
  if (isNil(enabled)) return true;
  if (enabled === 'false') return false;
  return Boolean(enabled);
};

// The endpoint the offline Lambda's Transcribe client must resolve to. host `0.0.0.0` is a bind-all
// address, not a connect target, so the connectable URL uses localhost. Pure/total.
const resolveEndpointUrl = options => {
  const host = options.host || DEFAULT_HOST;
  const connectHost = host === '0.0.0.0' ? 'localhost' : host;
  const port = resolvePort(options.port);
  return `http://${connectHost}:${port}`;
};

class ServerlessOfflineTranscribe {
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

    // AC-C1/AC-X1 (Codex F1): only stand up the server AND inject the endpoint when enabled, and in
    // this order. Bind FIRST so we know the REAL port — `port: 0` asks the OS for a free port only
    // known after start(); injecting the configured `0` would point the client at a dead `:0`
    // endpoint. Then inject BEFORE _createLambda so the unmodified TranscribeClient resolves to our
    // local server (serverless-offline copies AWS_* into the per-function env snapshot). serviceId
    // "Transcribe" → the single-word var AWS_ENDPOINT_URL_TRANSCRIBE. We do NOT set the generic
    // AWS_ENDPOINT_URL (it would misroute the app's S3/other clients to this port). When DISABLED we
    // inject nothing, so the app's Transcribe client keeps its own target rather than a dead port. An
    // explicit YAML override still wins (documented).
    if (isPluginEnabled(this.options)) {
      await this._createTranscribe();
      this._injectEndpointEnv();
    }

    const lambdas = this._getLambdas();

    await this._createLambda(lambdas);

    this.log.notice(
      `Starting Offline Transcribe at stage ${this.options.stage} (${this.options.region})`
    );
  }

  // Inject the endpoint using the ACTUAL bound port (known only after the server is listening, so
  // `port: 0` resolves to the OS-assigned port rather than a useless `:0`).
  _injectEndpointEnv() {
    process.env.AWS_ENDPOINT_URL_TRANSCRIBE = resolveEndpointUrl({
      host: this.options.host,
      port: this.transcribe.port
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
    if (this.transcribe) {
      modules.push(this.transcribe.stop(SERVER_SHUTDOWN_TIMEOUT));
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

  async _createTranscribe() {
    this.transcribe = new Transcribe(this.options, this.log);
    await this.transcribe.start();
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

    this.log.debug('transcribe options:', redactSecrets(this.options));
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

module.exports = ServerlessOfflineTranscribe;
module.exports.defaultOptions = defaultOptions;
module.exports.isPluginEnabled = isPluginEnabled;
module.exports.resolveEndpointUrl = resolveEndpointUrl;
module.exports.redactSecrets = redactSecrets;
