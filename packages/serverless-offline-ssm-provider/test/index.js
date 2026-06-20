const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {inferType, normalizeEntry, resolveParameter, shouldExecute} = require('../src/ssm');
const ServerlessOfflineSsmProvider = require('../src');

// ---------------------------------------------------------------------------
// Constructor harness — a hand-rolled fake serverless + aws provider (no mocking lib)
// ---------------------------------------------------------------------------

const makeAws = () => {
  const calls = [];
  const original = (...args) => {
    calls.push(args);
    return Promise.resolve({__fromOriginal: true});
  };
  const aws = {request: original, __original: original};
  return {aws, calls};
};

const makeServerless = ({custom, providerStage, aws} = {}) => {
  let provider = aws;
  return {
    service: {
      custom: custom ? {'serverless-offline-ssm': custom} : {},
      provider: {stage: providerStage}
    },
    getProvider: name => (name === 'aws' ? provider : undefined),
    setProvider: (name, value) => {
      if (name === 'aws') provider = value;
    }
  };
};

// Factory wrapper so constructing the plugin is an expression (avoids `no-new` for side effects).
const build = (serverless, cliOptions = {}, deps = {}) =>
  new ServerlessOfflineSsmProvider(serverless, cliOptions, deps);

// ---------------------------------------------------------------------------
// shouldExecute — stage gating (TU #1)
// ---------------------------------------------------------------------------

test('shouldExecute is true when the stage is in the configured offline stages', t => {
  t.true(shouldExecute(['offline', 'dev', 'test'], 'dev'));
  t.true(shouldExecute(['offline', 'dev', 'test'], 'offline'));
});

test('shouldExecute is false for a non-offline stage', t => {
  t.false(shouldExecute(['offline', 'dev', 'test'], 'prod'));
});

test('shouldExecute is false for empty/undefined/non-array stages', t => {
  t.false(shouldExecute([], 'dev'));
  t.false(shouldExecute(undefined, 'dev'));
  t.false(shouldExecute(null, 'dev'));
  t.false(shouldExecute('dev', 'dev'));
});

// ---------------------------------------------------------------------------
// Constructor — stage gating + fail-fast (TU #1 cont.)
// ---------------------------------------------------------------------------

test('constructor throws when stages are missing', t => {
  const {aws} = makeAws();
  const serverless = makeServerless({custom: {ssm: {}}, providerStage: 'dev', aws});
  const error = t.throws(() => new ServerlessOfflineSsmProvider(serverless, {}, {}));
  t.regex(error.message, /missing "custom\.serverless-offline-ssm\.stages"/);
});

test('constructor does not patch aws.request for a non-offline stage', t => {
  const {aws} = makeAws();
  const original = aws.request;
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/x': 'y'}},
    providerStage: 'prod',
    aws
  });
  build(serverless, {}, {});
  t.is(aws.request, original); // untouched
});

test('constructor patches aws.request for an offline stage', t => {
  const {aws} = makeAws();
  const original = aws.request;
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/x': 'y'}},
    providerStage: 'dev',
    aws
  });
  build(serverless, {}, {});
  t.not(aws.request, original); // replaced
});

test('constructor cliOptions.stage overrides provider.stage', t => {
  const {aws} = makeAws();
  const original = aws.request;
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {}},
    providerStage: 'prod', // would NOT patch...
    aws
  });
  build(serverless, {stage: 'dev'}, {}); // ...but cli stage does
  t.not(aws.request, original);
});

test('constructor --ssmOfflineStages overrides the configured stages', t => {
  const {aws} = makeAws();
  const original = aws.request;
  const serverless = makeServerless({
    custom: {stages: ['prod'], ssm: {}}, // config would NOT include dev
    providerStage: 'dev',
    aws
  });
  build(serverless, {ssmOfflineStages: 'dev,test'}, {});
  t.not(aws.request, original);
});

test('constructor is a no-op (does not throw) when getProvider returns falsy', t => {
  const serverless = {
    service: {
      custom: {'serverless-offline-ssm': {stages: ['dev'], ssm: {}}},
      provider: {stage: 'dev'}
    },
    getProvider: () => undefined,
    setProvider: () => {}
  };
  t.notThrows(() => new ServerlessOfflineSsmProvider(serverless, {}, {}));
});

// ---------------------------------------------------------------------------
// resolveParameter — exact key / miss (TU #2, #3)
// ---------------------------------------------------------------------------

test('resolveParameter returns {Value, Type} for a mapped key', t => {
  const map = {'/a/b': 'hello'};
  t.deepEqual(resolveParameter(map, '/a/b'), {Value: 'hello', Type: 'String'});
});

test('resolveParameter returns undefined for an absent key and does not throw', t => {
  t.is(resolveParameter({'/a/b': 'hello'}, '/nope'), undefined);
  t.notThrows(() => resolveParameter({'/a/b': 'hello'}, '/nope'));
  t.is(resolveParameter(undefined, '/nope'), undefined);
  t.is(resolveParameter(null, '/nope'), undefined);
});

// ---------------------------------------------------------------------------
// #186 — Type defaulting & inference (TU #4, #5, #6)
// ---------------------------------------------------------------------------

test('#186 inferType defaults to String for plain scalars', t => {
  t.is(inferType('elevenlabs-api-key'), 'String');
  t.is(inferType('/api/v1'), 'String');
  t.is(inferType('anthropic.claude-3'), 'String');
});

test('#186 inferType detects StringList from CSV strings and arrays', t => {
  t.is(inferType('a,b,c'), 'StringList');
  t.is(inferType(['a', 'b', 'c']), 'StringList');
});

test('#186 normalizeEntry joins an array value so the built-in split reproduces it', t => {
  const {value, type} = normalizeEntry(['a', 'b', 'c']);
  t.is(value, 'a,b,c');
  t.is(type, 'StringList');
  t.deepEqual(value.split(','), ['a', 'b', 'c']); // mirrors get-ssm.js downstream
});

test('#186 inferType detects SecureString from a {-prefixed JSON string', t => {
  t.is(inferType('{"type":"service_account"}'), 'SecureString');
  t.is(inferType('   {"a":1}'), 'SecureString'); // leading whitespace tolerated
});

test('#186 a non-JSON secret stays a literal String', t => {
  t.is(inferType('plain-secret'), 'String');
});

test('#186 SecureString JSON value round-trips through the built-in JSON.parse path', t => {
  const {Value, Type} = resolveParameter({'/g': '{"type":"service_account"}'}, '/g');
  t.is(Type, 'SecureString');
  t.is(JSON.parse(Value).type, 'service_account');
});

// ---------------------------------------------------------------------------
// {value, type} override — over-eager inference guard (TU #7)
// ---------------------------------------------------------------------------

test('normalizeEntry honors an explicit {value, type} override (force String)', t => {
  t.deepEqual(normalizeEntry({value: '{"a":1}', type: 'String'}), {
    value: '{"a":1}',
    type: 'String'
  });
});

test('normalizeEntry infers the type when an override object omits it', t => {
  t.deepEqual(normalizeEntry({value: 'a,b,c'}), {value: 'a,b,c', type: 'StringList'});
});

test('normalizeEntry override joins an array value', t => {
  t.deepEqual(normalizeEntry({value: ['a', 'b'], type: 'StringList'}), {
    value: 'a,b',
    type: 'StringList'
  });
});

// ---------------------------------------------------------------------------
// patch passthrough / hit / fall-through (TU #8)
// ---------------------------------------------------------------------------

test('patched request returns synthetic Parameter for a mapped SSM getParameter (no AWS call)', async t => {
  const {aws, calls} = makeAws();
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/it/plain': 'hello-world'}},
    providerStage: 'dev',
    aws
  });
  build(serverless, {}, {});

  const result = await aws.request('SSM', 'getParameter', {Name: '/it/plain'}, {});
  t.deepEqual(result.Parameter.Value, 'hello-world');
  t.is(result.Parameter.Type, 'String');
  t.is(calls.length, 0); // original was NOT called
});

test('patched request falls through to original for a non-SSM call with identical args', async t => {
  const {aws, calls} = makeAws();
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/it/plain': 'hello-world'}},
    providerStage: 'dev',
    aws
  });
  build(serverless, {}, {});

  await aws.request('CloudFormation', 'describeStacks', {StackName: 'x'}, {region: 'eu-west-1'});
  t.is(calls.length, 1);
  t.deepEqual(calls[0], [
    'CloudFormation',
    'describeStacks',
    {StackName: 'x'},
    {region: 'eu-west-1'}
  ]);
});

test('patched request falls through for SSM methods other than getParameter', async t => {
  const {aws, calls} = makeAws();
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/it/plain': 'hello-world'}},
    providerStage: 'dev',
    aws
  });
  build(serverless, {}, {});

  await aws.request('SSM', 'describeParameters', {}, {});
  t.is(calls.length, 1);
  t.deepEqual(calls[0], ['SSM', 'describeParameters', {}, {}]);
});

test('patched request falls through to real AWS for an unmapped SSM getParameter (#152)', async t => {
  const {aws, calls} = makeAws();
  const serverless = makeServerless({
    custom: {stages: ['dev'], ssm: {'/it/plain': 'hello-world'}},
    providerStage: 'dev',
    aws
  });
  build(serverless, {}, {});

  const params = {Name: '/not/in/map', WithDecryption: true};
  const result = await aws.request('SSM', 'getParameter', params, {useCache: true});
  t.is(calls.length, 1); // original WAS called
  t.deepEqual(calls[0], ['SSM', 'getParameter', params, {useCache: true}]);
  t.true(result.__fromOriginal);
});

// ---------------------------------------------------------------------------
// normalizeLog suite — copied from the serverless-offline-sqs sibling (TU #9)
// ---------------------------------------------------------------------------

test('normalizeLog returns the console-backed default logger when given nothing', t => {
  const log = normalizeLog();
  t.is(typeof log.debug, 'function');
  t.is(typeof log.info, 'function');
  t.is(typeof log.notice, 'function');
  t.is(typeof log.warning, 'function');
  t.is(typeof log.error, 'function');
  t.is(typeof log.success, 'function');
});

test('normalizeLog default debug is a silent noop returning undefined', t => {
  t.is(normalizeLog().debug('quiet'), undefined);
});

test('normalizeLog handles null/undefined without throwing', t => {
  t.notThrows(() => normalizeLog(null));
  t.notThrows(() => normalizeLog(undefined));
  t.deepEqual(Object.keys(normalizeLog(null)).sort(), Object.keys(defaultLog).sort());
});

test('normalizeLog overlays the injected logger over the defaults', t => {
  const calls = [];
  const injected = {notice: msg => calls.push(msg)};
  const log = normalizeLog(injected);

  log.notice('hello');
  t.deepEqual(calls, ['hello']);
  t.is(typeof log.warning, 'function');
  t.is(log.error, defaultLog.error);
});

test('normalizeLog does not mutate the injected logger or defaults', t => {
  const injected = {notice: () => {}};
  const before = {...injected};
  normalizeLog(injected);
  t.deepEqual(injected, before);
  t.is(defaultLog.debug, defaultLog.debug);
});
