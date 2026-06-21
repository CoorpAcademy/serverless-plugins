const {execFile: execFileCb} = require('child_process');
const {promisify} = require('util');
const {get, isNil, isPlainObject} = require('lodash/fp');

const {normalizeLog} = require('./log');

// #146 (tstackhouse, tristan-mastrodicasa): opt-in `autoStart` — spawn an ElasticMQ container from
// the plugin's own lifecycle so `autoStart: true` + `autoCreate: true` is a zero-setup local SQS.
// ALL Docker side effects live here; the plugin class only orchestrates. The Docker CLI is driven
// through child_process.execFile (argv array, no shell) so we add NO new runtime dependency, and
// readiness is probed with the built-in fetch (Node 18+). Both are injectable (see `deps`) so the
// whole lifecycle is unit-testable with mocks and never touches real Docker.

// Pin a concrete image tag (NOT :latest) so a local/CI autoStart is reproducible; `pullPolicy:
// missing` caches the pull. The exact engine the repo's test suite + docker-compose already use.
const DEFAULT_AUTOSTART_IMAGE = 'softwaremill/elasticmq-native:1.6.11';
// ElasticMQ's SQS REST API port, matching docker-compose.yml.
const DEFAULT_AUTOSTART_PORT = 9324;
// The container's fixed internal SQS port; only the host port is configurable.
const CONTAINER_PORT = 9324;
const DEFAULT_PULL_POLICY = 'missing';
// Generous default: a cold ElasticMQ container is ready well under 30s.
const DEFAULT_READINESS_TIMEOUT = 30000;
// A fixed name so a leaked container (hard crash, SIGKILL) is reclaimed on the next start — the real
// safety net behind `--rm`, not the SIGINT handler.
const DEFAULT_CONTAINER_NAME = 'serverless-offline-sqs-autostart';
const READINESS_POLL_INTERVAL = 250;

// #146/#222: mirror isPluginEnabled's string coercion. autoStart is opt-in, so an absent value is
// OFF (the inverse default of `enabled`). The string 'false' (YAML/CLI) is off; any other truthy
// value — including the object config form `{port: ...}` — is on. Pure + non-throwing.
const isAutoStartEnabled = options => {
  const autoStart = get('autoStart', options);
  if (isNil(autoStart)) return false;
  if (autoStart === 'false') return false;
  return Boolean(autoStart);
};

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// resolveAutoStartOptions(options) -> {image, port, pullPolicy, readinessTimeout, name}
// Pure + non-mutating. `autoStart` may be `true`/`'true'` (all defaults) or an object of overrides
// (#146 AC9). A non-object autoStart contributes no overrides, so the pinned defaults stand.
const resolveAutoStartOptions = options => {
  const autoStart = get('autoStart', options);
  const config = isPlainObject(autoStart) ? autoStart : {};
  return {
    image: isNil(config.image) ? DEFAULT_AUTOSTART_IMAGE : config.image,
    port: isNil(config.port) ? DEFAULT_AUTOSTART_PORT : config.port,
    pullPolicy: isNil(config.pullPolicy) ? DEFAULT_PULL_POLICY : config.pullPolicy,
    readinessTimeout: isNil(config.readinessTimeout)
      ? DEFAULT_READINESS_TIMEOUT
      : config.readinessTimeout,
    name: isNil(config.name) ? DEFAULT_CONTAINER_NAME : config.name
  };
};

// buildContainerArgs(opts) -> the `docker run` argv. Detached, self-removing (`--rm`), fixed
// `--name` (idempotent reclaim) and the `-Dnode-address.host="*"` flag the docker-compose service
// uses so the container answers on the host endpoint. Pure (#146 AC2/AC9).
const buildContainerArgs = ({name, port, image}) => [
  'run',
  '-d',
  '--rm',
  '--name',
  name,
  '-p',
  `${port}:${CONTAINER_PORT}`,
  image,
  '-Dnode-address.host=*'
];

// The host endpoint the SQS client is pointed at; also the readiness probe target (#146 AC2).
const buildReadinessUrl = ({port}) => `http://localhost:${port}`;

// #146: to be truly zero-setup, autoStart must not require the user to also configure credentials.
// ElasticMQ ignores credential VALUES, but the @aws-sdk v3 client still needs SOME credentials to
// sign — with none, buildCredentials returns undefined and the default provider chain hangs/throws
// ("Could not load credentials from any providers"). Inject harmless local placeholders, but ONLY
// when the user supplied neither key (an explicit pair still wins). Pure + non-mutating: returns a
// new options object.
const LOCAL_CREDENTIAL = 'localAutoStart';
const ensureLocalCredentials = options => {
  const accessKeyId = get('accessKeyId', options);
  const secretAccessKey = get('secretAccessKey', options);
  if (!isNil(accessKeyId) || !isNil(secretAccessKey)) return options;
  return {...options, accessKeyId: LOCAL_CREDENTIAL, secretAccessKey: LOCAL_CREDENTIAL};
};

// Build the error thrown when `docker version` fails — names Docker and points at the documented
// manual docker-compose fallback so the message is actionable (#146 AC6).
const dockerUnavailableError = cause =>
  new Error(
    'serverless-offline-sqs autoStart requires Docker, but `docker version` failed ' +
      `(${cause && cause.message ? cause.message : cause}). Start Docker, or run an ElasticMQ ` +
      'container yourself and set custom.serverless-offline-sqs.endpoint (see the README).'
  );

// startElasticMq(opts, log, deps?) -> Promise<{endpoint, stop()}>
// `opts` is the output of resolveAutoStartOptions. `deps` injects execFile/fetch/delay for tests.
// Sequence: preflight `docker version` (fail fast, AC6) -> ensure the image per pullPolicy ->
// reclaim a leaked `<name>` (`rm -f`, idempotent) -> `docker run` -> poll readiness until the port
// answers or readinessTimeout (then tear down + throw, AC7). The returned `stop()` is
// guarded-idempotent so SIGINT-then-offline:start:end does not double-remove (AC4).
const startElasticMq = async (opts, log, deps = {}) => {
  const logger = normalizeLog(log);
  const execFile = deps.execFile || promisify(execFileCb);
  // Node 18+ exposes a global `fetch` (the package `engines` requires >=18). Read it off `global`
  // (defined in the node ESLint env) so no polyfill/dependency is pulled in.
  const fetchFn = deps.fetch || global.fetch;
  const sleep = deps.delay || delay;

  const docker = (...args) => execFile('docker', args);
  // Never let a probe/teardown throw — these are best-effort checks, not the happy path.
  const dockerQuiet = async (...args) => {
    try {
      await docker(...args);
      return true;
    } catch (err) {
      return false;
    }
  };

  // AC6: preflight — fail fast BEFORE any `docker run`, so nothing is left dangling.
  try {
    await docker('version');
  } catch (err) {
    throw dockerUnavailableError(err);
  }

  // AC9: honor the pull policy. `missing` => inspect, pull only on a miss; `always` => always pull.
  if (opts.pullPolicy === 'always') {
    await docker('pull', opts.image);
  } else if (opts.pullPolicy === 'missing') {
    const present = await dockerQuiet('image', 'inspect', opts.image);
    if (!present) await docker('pull', opts.image);
  }

  // Idempotent reclaim: force-remove a leaked container of our fixed name before (re)creating it.
  await dockerQuiet('rm', '-f', opts.name);

  await docker(...buildContainerArgs(opts));

  const endpoint = buildReadinessUrl(opts);

  // Guarded-idempotent teardown (AC4): `stop` removes the container at most once.
  const stopState = {stopped: false};
  const stop = async () => {
    if (stopState.stopped) return;
    stopState.stopped = true;
    logger.notice('Stopping autostarted ElasticMQ container');
    await dockerQuiet('stop', opts.name);
    await dockerQuiet('rm', '-f', opts.name);
  };

  // AC7: poll the SQS port until ANY HTTP answer (even a 4xx means the port is up). A
  // connection-refused while booting is the expected not-ready signal — swallow + retry until the
  // readinessTimeout, then tear the container down and throw a descriptive error.
  const deadline = Date.now() + opts.readinessTimeout;
  const waitUntilReady = async () => {
    try {
      await fetchFn(endpoint);
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        await stop();
        throw new Error(
          `serverless-offline-sqs autoStart: ElasticMQ did not become ready at ${endpoint} ` +
            `within ${opts.readinessTimeout}ms. Is the port free? Override with ` +
            'custom.serverless-offline-sqs.autoStart.port.'
        );
      }
      await sleep(READINESS_POLL_INTERVAL);
      return waitUntilReady();
    }
  };
  await waitUntilReady();

  logger.notice(`Started autostarted ElasticMQ container at ${endpoint}`);

  return {endpoint, stop};
};

module.exports = {
  startElasticMq,
  isAutoStartEnabled,
  resolveAutoStartOptions,
  buildContainerArgs,
  buildReadinessUrl,
  ensureLocalCredentials,
  DEFAULT_AUTOSTART_IMAGE,
  DEFAULT_AUTOSTART_PORT,
  DEFAULT_PULL_POLICY,
  DEFAULT_READINESS_TIMEOUT,
  DEFAULT_CONTAINER_NAME,
  LOCAL_CREDENTIAL
};
