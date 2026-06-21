const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const DynamodbStreamsEvent = require('../src/dynamodb-streams-event');
const DynamodbStreamsEventDefinition = require('../src/dynamodb-streams-event-definition');
const DynamodbStreams = require('../src/dynamodb-streams');

const {
  assertStreamEnabled,
  chunkSequenceNumber,
  shouldContinueOnMissingResource,
  missingResourceWarning,
  TABLE_DESCRIBE_MAX_ATTEMPTS
} = DynamodbStreams;
const {resolveTableName} = require('../src/resolve-arn');
const {
  resolveDestinationArn,
  queueNameFromArn,
  buildFailurePayload,
  buildSuccessPayload,
  dispatchDestination,
  runDestinations
} = require('../src/destinations');
const {recordMatchesFilterPatterns, filterRecords} = require('../src/filter-patterns');
const {
  DEFAULT_STATE_FILE,
  checkpointKey,
  getCheckpoint,
  setCheckpoint,
  resolveIteratorOptions,
  resolveStateFilePath,
  loadState,
  saveState
} = require('../src/checkpoint-store');
const {
  buildClientConfig,
  buildCredentials,
  resolveRegion,
  ensureArray,
  DEFAULT_REGION
} = require('../src/client-config');
const {toCallbackMethod, buildCallbackClient} = require('../src/callback-adapter');

const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'success'];

// --- buildClientConfig (#248/#252 aws-sdk v3 migration) -------------------

// EARS5: accessKeyId without secretAccessKey must NOT build a half-empty credentials object.
test('buildCredentials returns undefined when only one key is provided (EARS5)', t => {
  t.is(buildCredentials({accessKeyId: 'local'}), undefined);
  t.is(buildCredentials({secretAccessKey: 'local'}), undefined);
});

test('buildCredentials returns credentials only when BOTH keys are present', t => {
  t.deepEqual(buildCredentials({accessKeyId: 'a', secretAccessKey: 's'}), {
    accessKeyId: 'a',
    secretAccessKey: 's'
  });
});

test('buildClientConfig omits credentials when only accessKeyId is set (EARS5)', t => {
  t.false('credentials' in buildClientConfig({accessKeyId: 'local', endpoint: 'http://x'}));
});

// EARS4: a custom endpoint without provider.region still works (default region supplied).
test('buildClientConfig injects a default region for an endpoint with no region (EARS4)', t => {
  t.is(buildClientConfig({endpoint: 'http://localhost:8000'}).region, DEFAULT_REGION);
});

test('resolveRegion keeps the provided region untouched', t => {
  t.is(resolveRegion({endpoint: 'http://x', region: 'eu-west-1'}), 'eu-west-1');
});

// EARS3: an omitted response array must be treated as [] (no undefined.length crash).
test('ensureArray returns [] for undefined/null (EARS3)', t => {
  t.deepEqual(ensureArray(undefined), []);
  t.deepEqual(ensureArray(null), []);
});

// --- callback-adapter (#248 promise->callback shim for the readable) -------

class FakeCommand {
  constructor(params) {
    this.params = params;
  }
}

test('toCallbackMethod forwards a resolved v3 send as (null, data)', async t => {
  const client = {send: command => Promise.resolve({echoed: command.params})};
  const method = toCallbackMethod(client, FakeCommand);
  const data = await new Promise((resolve, reject) => {
    method({StreamArn: 's'}, (err, d) => (err ? reject(err) : resolve(d)));
  });
  t.deepEqual(data, {echoed: {StreamArn: 's'}});
});

test('toCallbackMethod forwards a rejected v3 send as the err arg (no throw)', async t => {
  const boom = new Error('boom');
  const client = {send: () => Promise.reject(boom)};
  const method = toCallbackMethod(client, FakeCommand);
  const err = await new Promise(resolve => {
    method({}, e => resolve(e));
  });
  t.is(err, boom);
});

test('buildCallbackClient exposes a callback method per command plus a passthrough send', t => {
  const wrapped = buildCallbackClient(
    {send: () => Promise.resolve('ok')},
    {getRecords: FakeCommand, describeStream: FakeCommand, getShardIterator: FakeCommand}
  );
  t.is(typeof wrapped.getRecords, 'function');
  t.is(typeof wrapped.describeStream, 'function');
  t.is(typeof wrapped.getShardIterator, 'function');
  t.is(typeof wrapped.send, 'function');
});

// --- normalizeLog --------------------------------------------------------

test('normalizeLog exposes every log level as a function', t => {
  const log = normalizeLog({});
  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function', `expected log.${level} to be a function`);
  });
});

test('normalizeLog merges a partial logger and keeps it', t => {
  const notice = () => 'noticed';
  const log = normalizeLog({notice});

  t.is(log.notice, notice);
});

test('normalizeLog falls back to defaults for missing levels', t => {
  const notice = () => 'noticed';
  const log = normalizeLog({notice});

  t.is(log.debug, defaultLog.debug);
  t.is(log.warning, defaultLog.warning);
  t.is(log.error, defaultLog.error);
});

test('normalizeLog(undefined) is safe and returns the defaults', t => {
  const log = normalizeLog(undefined);

  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function');
  });
  t.is(log.debug, defaultLog.debug);
});

test('normalizeLog(null) is safe', t => {
  const log = normalizeLog(null);

  LOG_LEVELS.forEach(level => {
    t.is(typeof log[level], 'function');
  });
});

test('normalizeLog default debug is a quiet noop', t => {
  t.is(defaultLog.debug(), undefined);
});

test('normalizeLog does not mutate the injected logger', t => {
  const injected = {notice: () => {}};
  normalizeLog(injected);

  t.deepEqual(Object.keys(injected), ['notice']);
});

// --- DynamodbStreamsEvent mapper (#166 awsRegion guard) ------------------

const dynamodbRecord = {
  eventID: '1',
  eventName: 'INSERT',
  eventVersion: '1.1',
  eventSource: 'aws:dynamodb',
  dynamodb: {
    Keys: {Id: {S: '101'}},
    NewImage: {Message: {S: 'New item!'}, Id: {S: '101'}},
    SequenceNumber: '111',
    SizeBytes: 26,
    StreamViewType: 'NEW_AND_OLD_IMAGES'
  }
};

test('DynamodbStreamsEvent wraps records into the aws:dynamodb Lambda event shape', t => {
  const arn = 'arn:aws:dynamodb:eu-west-1:000000000000:table/myTable/stream/2024';
  const event = new DynamodbStreamsEvent([dynamodbRecord], 'eu-west-1', arn);

  t.true(Array.isArray(event.Records));
  t.is(event.Records.length, 1);
  t.is(event.Records[0].eventSource, 'aws:dynamodb');
  t.is(event.Records[0].eventSourceARN, arn);
  t.is(event.Records[0].dynamodb.SequenceNumber, '111');
});

test('DynamodbStreamsEvent sets the correct awsRegion on every record (#166)', t => {
  const arn = 'arn:aws:dynamodb:eu-central-1:000000000000:table/myTable/stream/2024';
  const event = new DynamodbStreamsEvent([dynamodbRecord, dynamodbRecord], 'eu-central-1', arn);

  event.Records.forEach(record => {
    t.is(record.awsRegion, 'eu-central-1');
    t.not(record.awsRegion, undefined);
  });
});

// --- assertStreamEnabled (#98 no-streams guard) --------------------------

test('assertStreamEnabled returns the arn when streams are enabled', t => {
  const arn = 'arn:aws:dynamodb:eu-west-1:000000000000:table/myTable/stream/2024';
  t.is(assertStreamEnabled('myTable', arn), arn);
});

test('assertStreamEnabled throws a clear error when LatestStreamArn is undefined (#98)', t => {
  const error = t.throws(() => assertStreamEnabled('myTable', undefined));
  t.is(error.message, 'Table myTable does not have streams enabled');
});

test('assertStreamEnabled throws a clear error when LatestStreamArn is null/empty (#98)', t => {
  t.is(
    t.throws(() => assertStreamEnabled('orders', null)).message,
    'Table orders does not have streams enabled'
  );
  t.is(
    t.throws(() => assertStreamEnabled('orders', '')).message,
    'Table orders does not have streams enabled'
  );
});

// --- DynamodbStreamsEventDefinition normalizer --------------------------

test('DynamodbStreamsEventDefinition derives tableName from a string ARN', t => {
  const arn = 'arn:aws:dynamodb:eu-west-1:000000000000:table/myTable/stream/2024';
  const definition = new DynamodbStreamsEventDefinition(arn, 'eu-west-1', '000000000000');

  t.is(definition.tableName, 'myTable');
  t.true(definition.enabled);
  t.is(definition.batchSize, 100);
  t.is(definition.maximumRetryAttempts, 10);
  t.is(definition.startingPosition, 'LATEST');
});

test('DynamodbStreamsEventDefinition derives tableName from an {arn} object', t => {
  const definition = new DynamodbStreamsEventDefinition(
    {arn: 'arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024', batchSize: 10},
    'eu-west-1',
    '000000000000'
  );

  t.is(definition.tableName, 'orders');
  t.is(definition.batchSize, 10);
});

test('DynamodbStreamsEventDefinition builds the arn from a {tableName} object', t => {
  const definition = new DynamodbStreamsEventDefinition(
    {tableName: 'myTable'},
    'eu-west-1',
    '000000000000'
  );

  t.is(definition.tableName, 'myTable');
  t.is(definition.arn, 'arn:aws:dynamodb:eu-west-1:000000000000:myTable');
});

// --- Regression guards: the v4 migration must not reintroduce removed APIs

const SRC_DIR = path.join(__dirname, '..', 'src');
const readSource = file => fs.readFileSync(path.join(SRC_DIR, file), 'utf8');

test('src/index.js does not use removed Serverless v4 logging APIs', t => {
  const source = readSource('index.js');

  t.false(source.includes('@serverless/utils/log'));
  t.false(source.includes('serverless.cli.log'));
});

test('src/index.js takes the logger from the 3rd constructor argument', t => {
  const source = readSource('index.js');

  t.true(source.includes('constructor(serverless, cliOptions, {log} = {})'));
  t.true(source.includes('this.log = normalizeLog(log)'));
});

test('src/dynamodb-streams.js does not use removed APIs and logs failures via log.warning', t => {
  const source = readSource('dynamodb-streams.js');

  t.false(source.includes('@serverless/utils/log'));
  t.false(source.includes('serverless.cli.log'));
  t.false(/\blog\.warn\b/.test(source));
  t.true(source.includes('this.log.warning'));
});

test('src/dynamodb-streams.js builds events with this.options.region, not this.region (#166)', t => {
  const source = readSource('dynamodb-streams.js');

  t.true(source.includes('this.options.region'));
  t.false(/new DynamodbStreamsEvent\(chunk, this\.region\b/.test(source));
});

test('src/dynamodb-streams-event.js exports a DynamodbStreamsEvent class (renamed from KinesisEvent)', t => {
  const source = readSource('dynamodb-streams-event.js');

  t.true(source.includes('class DynamodbStreamsEvent'));
  t.true(source.includes('module.exports = DynamodbStreamsEvent'));
  t.false(source.includes('KinesisEvent'));
});

// --- resolveTableName (#103 cwienands1) ----------------------------------

const RESOURCES = {Resources: {OrdersTable: {Properties: {TableName: 'orders'}}}};

test('resolveTableName: explicit tableName key wins', t => {
  t.is(resolveTableName({tableName: 'orders'}, RESOURCES), 'orders');
});

test('resolveTableName: string ARN derives the table name', t => {
  t.is(
    resolveTableName('arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024', RESOURCES),
    'orders'
  );
});

test('resolveTableName: {arn:string} derives the table name', t => {
  t.is(
    resolveTableName(
      {arn: 'arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024'},
      RESOURCES
    ),
    'orders'
  );
});

test('resolveTableName: Fn::GetAtt [Table, StreamArn] -> Properties.TableName', t => {
  t.is(resolveTableName({arn: {'Fn::GetAtt': ['OrdersTable', 'StreamArn']}}, RESOURCES), 'orders');
});

test('resolveTableName: Fn::GetAtt [Table, Arn] -> Properties.TableName (#103 issue-3)', t => {
  t.is(resolveTableName({arn: {'Fn::GetAtt': ['OrdersTable', 'Arn']}}, RESOURCES), 'orders');
});

test('resolveTableName: Ref to a table resource -> Properties.TableName (#103 issue-3)', t => {
  t.is(resolveTableName({arn: {Ref: 'OrdersTable'}}, RESOURCES), 'orders');
});

test('resolveTableName: unknown Fn::GetAtt logical id throws a clear error', t => {
  const err = t.throws(() =>
    resolveTableName({arn: {'Fn::GetAtt': ['Ghost', 'StreamArn']}}, RESOURCES)
  );
  t.true(/Ghost/.test(err.message));
});

test('resolveTableName: resource present but no TableName throws instead of undefined (#103 issue-2)', t => {
  const resources = {Resources: {OrdersTable: {Properties: {}}}};
  const err = t.throws(() =>
    resolveTableName({arn: {'Fn::GetAtt': ['OrdersTable', 'StreamArn']}}, resources)
  );
  t.true(/OrdersTable/.test(err.message));
  t.regex(err.message, /TableName/i);
});

test('resolveTableName: Fn::ImportValue (unresolvable offline) throws a descriptive error (#103 issue-3)', t => {
  const err = t.throws(() =>
    resolveTableName({arn: {'Fn::ImportValue': 'ExportedArn'}}, RESOURCES)
  );
  t.regex(err.message, /ImportValue|cannot|resolve/i);
});

test('resolveTableName does not mutate its inputs', t => {
  const event = {arn: {'Fn::GetAtt': ['OrdersTable', 'StreamArn']}};
  const eventBefore = JSON.parse(JSON.stringify(event));
  const resBefore = JSON.parse(JSON.stringify(RESOURCES));
  resolveTableName(event, RESOURCES);
  t.deepEqual(event, eventBefore);
  t.deepEqual(RESOURCES, resBefore);
});

// --- recordMatchesFilterPatterns / filterRecords (#242 cremoon) ----------

const insertRecord = {
  eventID: '1',
  eventName: 'INSERT',
  eventSource: 'aws:dynamodb',
  dynamodb: {Keys: {Id: {S: '101'}}, NewImage: {Status: {S: 'active'}, Id: {S: '101'}}}
};
const modifyRecord = {
  eventID: '2',
  eventName: 'MODIFY',
  eventSource: 'aws:dynamodb',
  dynamodb: {Keys: {Id: {S: '102'}}, NewImage: {Status: {S: 'inactive'}, Id: {S: '102'}}}
};

test('recordMatchesFilterPatterns: matches on eventName', t => {
  t.true(recordMatchesFilterPatterns([{eventName: ['INSERT']}], insertRecord));
  t.false(recordMatchesFilterPatterns([{eventName: ['INSERT']}], modifyRecord));
});

test('recordMatchesFilterPatterns: OR across the pattern array (record matches if ANY matches)', t => {
  t.true(
    recordMatchesFilterPatterns([{eventName: ['REMOVE']}, {eventName: ['INSERT']}], insertRecord)
  );
  t.false(
    recordMatchesFilterPatterns([{eventName: ['REMOVE']}, {eventName: ['MODIFY']}], insertRecord)
  );
});

test('recordMatchesFilterPatterns: nested DynamoDB attribute-value path', t => {
  const pattern = [{dynamodb: {NewImage: {Status: {S: ['active']}}}}];
  t.true(recordMatchesFilterPatterns(pattern, insertRecord));
  t.false(recordMatchesFilterPatterns(pattern, modifyRecord));
});

test('recordMatchesFilterPatterns: content-filter operators (prefix) reused from matchesPattern', t => {
  t.true(
    recordMatchesFilterPatterns([{dynamodb: {NewImage: {Id: {S: [{prefix: '10'}]}}}}], insertRecord)
  );
  t.false(
    recordMatchesFilterPatterns([{dynamodb: {NewImage: {Id: {S: [{prefix: '99'}]}}}}], insertRecord)
  );
});

test('recordMatchesFilterPatterns: absent/empty patterns let every record through (#242 default)', t => {
  t.true(recordMatchesFilterPatterns(undefined, insertRecord));
  t.true(recordMatchesFilterPatterns(null, insertRecord));
  t.true(recordMatchesFilterPatterns([], insertRecord));
});

test('filterRecords: keeps only matching records of a chunk', t => {
  t.deepEqual(filterRecords([{eventName: ['INSERT']}], [insertRecord, modifyRecord]), [
    insertRecord
  ]);
});

test('filterRecords: no patterns -> all records pass through unchanged', t => {
  const chunk = [insertRecord, modifyRecord];
  t.deepEqual(filterRecords(undefined, chunk), chunk);
});

test('filterRecords: no matches -> empty array (handler must be skipped by the caller)', t => {
  t.deepEqual(filterRecords([{eventName: ['REMOVE']}], [insertRecord, modifyRecord]), []);
});

test('recordMatchesFilterPatterns/filterRecords do not mutate inputs', t => {
  const patterns = [{eventName: ['INSERT']}];
  const records = [insertRecord, modifyRecord];
  const patternsBefore = JSON.parse(JSON.stringify(patterns));
  const recordsBefore = JSON.parse(JSON.stringify(records));
  filterRecords(patterns, records);
  t.deepEqual(patterns, patternsBefore);
  t.deepEqual(records, recordsBefore);
});

// ---------------------------------------------------------------------------
// checkpoint-store (#178 ddb-streams-checkpoint)
//
// Deterministic, docker-free unit coverage of the restart checkpoint. The
// TRIM_HORIZON no-replay guarantee (EARS1) is asserted here as a pure decision
// on the iterator options, so the regression runs in CI behind pretest:unit
// (EARS2) without needing DynamoDB Local.
// ---------------------------------------------------------------------------

const STREAM_ARN = 'arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024';
const OTHER_STREAM_ARN = 'arn:aws:dynamodb:eu-west-1:000000000000:table/users/stream/2024';

test('checkpointKey namespaces the sequence number by stream arn + shard', t => {
  t.is(checkpointKey(STREAM_ARN, 'shardId-1'), `${STREAM_ARN}::shardId-1`);
  t.not(checkpointKey(STREAM_ARN, 'shardId-1'), checkpointKey(OTHER_STREAM_ARN, 'shardId-1'));
});

test('getCheckpoint returns the saved sequence number for a (stream, shard)', t => {
  const state = {[checkpointKey(STREAM_ARN, 'shardId-1')]: '111'};
  t.is(getCheckpoint(state, STREAM_ARN, 'shardId-1'), '111');
});

test('getCheckpoint returns undefined when nothing is recorded (incl. null state)', t => {
  t.is(getCheckpoint({}, STREAM_ARN, 'shardId-1'), undefined);
  t.is(getCheckpoint(null, STREAM_ARN, 'shardId-1'), undefined);
  t.is(getCheckpoint(undefined, STREAM_ARN, 'shardId-1'), undefined);
});

test('getCheckpoint does not cross streams (per-stream isolation)', t => {
  const state = {[checkpointKey(STREAM_ARN, 'shardId-1')]: '111'};
  t.is(getCheckpoint(state, OTHER_STREAM_ARN, 'shardId-1'), undefined);
});

test('setCheckpoint advances a shard without mutating the input state', t => {
  const state = {};
  const next = setCheckpoint(state, STREAM_ARN, 'shardId-1', '222');
  t.is(getCheckpoint(next, STREAM_ARN, 'shardId-1'), '222');
  t.deepEqual(state, {}, 'original state untouched');
  t.not(next, state, 'returns a new object');
});

test('setCheckpoint overwrites an earlier checkpoint for the same shard', t => {
  const state = setCheckpoint({}, STREAM_ARN, 'shardId-1', '100');
  const next = setCheckpoint(state, STREAM_ARN, 'shardId-1', '200');
  t.is(getCheckpoint(next, STREAM_ARN, 'shardId-1'), '200');
});

test('setCheckpoint ignores a nil/empty/non-string sequence number (no clobber)', t => {
  const state = setCheckpoint({}, STREAM_ARN, 'shardId-1', '100');
  t.is(
    getCheckpoint(
      setCheckpoint(state, STREAM_ARN, 'shardId-1', undefined),
      STREAM_ARN,
      'shardId-1'
    ),
    '100'
  );
  t.is(
    getCheckpoint(setCheckpoint(state, STREAM_ARN, 'shardId-1', null), STREAM_ARN, 'shardId-1'),
    '100'
  );
  t.is(
    getCheckpoint(setCheckpoint(state, STREAM_ARN, 'shardId-1', ''), STREAM_ARN, 'shardId-1'),
    '100'
  );
});

// EARS1: a TRIM_HORIZON restart with a saved checkpoint must resume AFTER the
// processed sequence number, NOT replay from the horizon.
test('resolveIteratorOptions: TRIM_HORIZON with a saved checkpoint resumes AFTER it, no replay (#178 EARS1)', t => {
  const state = setCheckpoint({}, STREAM_ARN, 'shardId-1', '111');
  const options = resolveIteratorOptions(state, STREAM_ARN, 'shardId-1', 'TRIM_HORIZON');

  t.deepEqual(options, {startAfter: '111'});
  t.is(options.iterator, undefined, 'iterator must be omitted so startAfter wins in the readable');
});

test('resolveIteratorOptions: LATEST with a saved checkpoint also resumes AFTER it (#178)', t => {
  const state = setCheckpoint({}, STREAM_ARN, 'shardId-1', '999');
  t.deepEqual(resolveIteratorOptions(state, STREAM_ARN, 'shardId-1', 'LATEST'), {
    startAfter: '999'
  });
});

test('resolveIteratorOptions: no checkpoint -> honor the configured startingPosition (cold start)', t => {
  t.deepEqual(resolveIteratorOptions({}, STREAM_ARN, 'shardId-1', 'TRIM_HORIZON'), {
    iterator: 'TRIM_HORIZON'
  });
  t.deepEqual(resolveIteratorOptions({}, STREAM_ARN, 'shardId-1', 'LATEST'), {iterator: 'LATEST'});
});

test('resolveStateFilePath defaults to the gitignored state file anchored at cwd', t => {
  t.is(resolveStateFilePath(undefined, '/srv/app'), path.join('/srv/app', DEFAULT_STATE_FILE));
  t.is(DEFAULT_STATE_FILE, '.serverless-offline-dynamodb-streams.json');
});

test('resolveStateFilePath honors an absolute configured path as-is', t => {
  t.is(resolveStateFilePath('/var/lib/cp.json', '/srv/app'), '/var/lib/cp.json');
});

test('resolveStateFilePath resolves a relative configured path against cwd', t => {
  t.is(resolveStateFilePath('.cache/cp.json', '/srv/app'), path.join('/srv/app', '.cache/cp.json'));
});

// EARS4: loading a missing file is a clean cold start (no throw, no ENOENT spam).
test('loadState returns an empty map for a missing file (no throw, EARS4)', t => {
  const missing = path.join(os.tmpdir(), `ddb-cp-missing-${Date.now()}.json`);
  t.notThrows(() => loadState(missing));
  t.deepEqual(loadState(missing), {});
});

test('loadState returns an empty map for malformed JSON (cold start, never crash)', t => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-cp-')), 'corrupt.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  t.deepEqual(loadState(file), {});
});

// EARS4: saving into a not-yet-existing directory creates it (no ENOENT).
test('saveState creates a missing checkpoint dir and round-trips the state (EARS4)', t => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-cp-')), 'nested', 'deeper');
  const file = path.join(dir, DEFAULT_STATE_FILE);
  const state = setCheckpoint({}, STREAM_ARN, 'shardId-1', '111');

  t.false(fs.existsSync(dir), 'precondition: dir does not exist yet');
  t.notThrows(() => saveState(file, state));
  t.true(fs.existsSync(dir), 'missing dir was created');
  t.deepEqual(loadState(file), state, 'persisted state round-trips');
});

// chunkSequenceNumber: the high-water mark advanced after the handler resolves.
test('chunkSequenceNumber returns the SequenceNumber of the last record of a chunk', t => {
  const chunk = [
    {dynamodb: {SequenceNumber: '100'}},
    {dynamodb: {SequenceNumber: '101'}},
    {dynamodb: {SequenceNumber: '111'}}
  ];
  t.is(chunkSequenceNumber(chunk), '111');
});

test('chunkSequenceNumber is undefined for an empty/nil chunk (no checkpoint advance)', t => {
  t.is(chunkSequenceNumber([]), undefined);
  t.is(chunkSequenceNumber(undefined), undefined);
  t.is(chunkSequenceNumber(null), undefined);
});

// EARS1 source guard: the readable must NOT be wired with an unconditional
// `iterator: startingPosition` (that ignored any saved checkpoint and replayed
// from TRIM_HORIZON). It must route through resolveIteratorOptions.
test('src/dynamodb-streams.js resumes via the checkpoint store, not an unconditional iterator (#178 EARS1)', t => {
  const source = readSource('dynamodb-streams.js');

  t.false(
    /iterator:\s*startingPosition/.test(source),
    'must not hard-wire iterator: startingPosition (that replays from TRIM_HORIZON)'
  );
  t.true(source.includes('resolveIteratorOptions'));
  t.true(source.includes('_advanceCheckpoint'));
});

// EARS3 source guard: when the handler runs, the checkpoint advances only inside the
// post-resolve `.then`, never before the handler runs. (A fully-filtered batch that
// skips the handler advances in the isEmpty branch — covered behaviorally below.)
test('src/dynamodb-streams.js advances the checkpoint only after the handler resolves (#178 EARS3)', t => {
  const source = readSource('dynamodb-streams.js');
  const thenIdx = source.indexOf('.then(() => {');
  // The handler-path advance is the one that follows the post-resolve `.then`.
  const advanceIdx = source.indexOf('this._advanceCheckpoint(streamArn, shardId', thenIdx);

  t.true(advanceIdx > -1 && thenIdx > -1);
  t.true(advanceIdx > thenIdx, 'the handler-path advance call lives inside the post-handler .then');
});

// End-to-end of the pure store: process records, restart, and assert no replay.
test('checkpoint round-trip: a restart resumes AFTER the last processed record (#178 EARS1+EARS3)', t => {
  // First run processes up to sequence 111 and persists it.
  const afterFirstRun = setCheckpoint({}, STREAM_ARN, 'shardId-1', '111');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-cp-')), DEFAULT_STATE_FILE);
  saveState(file, afterFirstRun);

  // Restart: reload state and decide the iterator for TRIM_HORIZON.
  const reloaded = loadState(file);
  const options = resolveIteratorOptions(reloaded, STREAM_ARN, 'shardId-1', 'TRIM_HORIZON');

  t.deepEqual(options, {startAfter: '111'}, 'resumes after 111, does not replay 0..111');
});

// --- writable wiring (#178 + #242): the filterPatterns / checkpoint interaction
//
// Drives the REAL writable built by `_dynamodbStreamsEvent` (no AWS, no docker):
// only `_describeTable` and `streamsClient.describeStream` are stubbed so the plugin
// builds an actual readable+writable pair. The readable is left paused (start() is
// never called) so no polling timers fire — we push chunks through the writable
// directly and assert the checkpoint/handler behavior.

const SHARD_ID = 'shardId-00000001';
const HARNESS_STREAM_ARN = 'arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024';

const buildStreamsHarness = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-cp-')), DEFAULT_STATE_FILE);

  const handlerCalls = [];
  const lambda = {
    get: () => ({
      setEvent: event => handlerCalls.push(event),
      runHandler: () => Promise.resolve()
    })
  };

  const streams = new DynamodbStreams(
    lambda,
    {region: 'eu-west-1', accountId: '000000000000', checkpointFile: file},
    {}
  );

  // Stub the AWS edges so `_dynamodbStreamsEvent` resolves a single shard. #248 (aws-sdk v3): the
  // production client is driven via `send(new DescribeStreamCommand(...))`, so stub `send` (which
  // returns the response directly) rather than the v2 `describeStream().promise()` method.
  streams._describeTable = () => Promise.resolve({Table: {LatestStreamArn: HARNESS_STREAM_ARN}});
  streams.streamsClient.send = () =>
    Promise.resolve({StreamDescription: {Shards: [{ShardId: SHARD_ID}]}});

  return {streams, file, handlerCalls};
};

// Reach the actual Writable destination of the readable.pipe(writable) wiring.
// `_readableState.pipes` is an array in modern Node and a single ref in older ones.
const writableOf = readable => {
  const {pipes} = readable._readableState;
  return Array.isArray(pipes) ? pipes[0] : pipes;
};

const writeChunk = (writable, chunk) =>
  new Promise((resolve, reject) => {
    writable.write(chunk, err => (err ? reject(err) : resolve()));
  });

test('write: a batch fully dropped by filterPatterns still advances the checkpoint (#178/#242)', async t => {
  // filterPatterns matches neither INSERT nor MODIFY -> the whole batch is dropped.
  const {streams, file, handlerCalls} = buildStreamsHarness();

  await streams._dynamodbStreamsEvent(
    'fnKey',
    undefined,
    new DynamodbStreamsEventDefinition(
      {
        arn: HARNESS_STREAM_ARN,
        startingPosition: 'TRIM_HORIZON',
        filterPatterns: [{eventName: ['REMOVE']}]
      },
      'eu-west-1',
      '000000000000'
    )
  );

  const writable = writableOf(streams.readables[0]);

  const chunk = [
    {...insertRecord, dynamodb: {...insertRecord.dynamodb, SequenceNumber: '100'}},
    {...modifyRecord, dynamodb: {...modifyRecord.dynamodb, SequenceNumber: '111'}}
  ];

  await writeChunk(writable, chunk);

  // The handler must NOT run (no record matched) ...
  t.is(handlerCalls.length, 0, 'handler is skipped for a fully-filtered batch');
  // ... yet the checkpoint must advance to the FULL chunk high-water mark, so those
  // already-scanned records are never re-scanned on restart.
  t.is(
    getCheckpoint(streams.checkpointState, HARNESS_STREAM_ARN, SHARD_ID),
    '111',
    'checkpoint advanced to the last record of the dropped batch'
  );
  t.deepEqual(
    loadState(file),
    {[checkpointKey(HARNESS_STREAM_ARN, SHARD_ID)]: '111'},
    'advanced checkpoint is persisted to disk'
  );
});

test('write: a partially-matching batch runs the handler and advances to the FULL chunk seq (#178/#242)', async t => {
  const {streams, handlerCalls} = buildStreamsHarness();

  await streams._dynamodbStreamsEvent(
    'fnKey',
    undefined,
    new DynamodbStreamsEventDefinition(
      {
        arn: HARNESS_STREAM_ARN,
        startingPosition: 'TRIM_HORIZON',
        filterPatterns: [{eventName: ['INSERT']}]
      },
      'eu-west-1',
      '000000000000'
    )
  );

  const writable = writableOf(streams.readables[0]);
  const chunk = [
    {...insertRecord, dynamodb: {...insertRecord.dynamodb, SequenceNumber: '100'}},
    {...modifyRecord, dynamodb: {...modifyRecord.dynamodb, SequenceNumber: '111'}}
  ];

  await writeChunk(writable, chunk);

  // The handler runs with only the matching (INSERT) record ...
  t.is(handlerCalls.length, 1, 'handler runs for a partially-matching batch');
  t.is(handlerCalls[0].Records.length, 1);
  t.is(handlerCalls[0].Records[0].eventName, 'INSERT');
  // ... but the checkpoint still advances to the FULL chunk high-water mark (111),
  // not just the matched subset (100), so the filtered MODIFY is not re-scanned.
  t.is(getCheckpoint(streams.checkpointState, HARNESS_STREAM_ARN, SHARD_ID), '111');
});

// ---------------------------------------------------------------------------
// missing table / missing stream (#241 lqueryvg)
//
// The reporter's table/stream may be absent when Localstack is not fully up. The
// plugin must NOT hang forever (the old catch re-waited unconditionally) and must
// NOT silently abort serverless-offline. Default: fail fast with a CLEAR error
// naming the table. Opt-in `continueOnMissingResource`: log a warning and skip
// that event source so the rest of serverless-offline still starts.
// ---------------------------------------------------------------------------

// EARS3: the opt-in decision is a pure read of the custom option (default false).
test('shouldContinueOnMissingResource defaults to false (#241)', t => {
  t.false(shouldContinueOnMissingResource({}));
  t.false(shouldContinueOnMissingResource(undefined));
  t.false(shouldContinueOnMissingResource({continueOnMissingResource: false}));
});

test('shouldContinueOnMissingResource is true only when the opt-in flag is set (#241)', t => {
  t.true(shouldContinueOnMissingResource({continueOnMissingResource: true}));
});

// EARS2: the warning names the table and the underlying cause (pure, no side effect).
test('missingResourceWarning names the table and the cause (#241)', t => {
  const message = missingResourceWarning('orders', new Error('table not found'));
  t.regex(message, /orders/);
  t.regex(message, /table not found/);
  t.regex(message, /skip/i);
});

test('missingResourceWarning is pure and tolerates a non-Error cause (#241)', t => {
  t.regex(missingResourceWarning('orders', undefined), /orders/);
});

// EARS1: a genuinely-missing table must fail fast after a BOUNDED number of attempts
// with a clear error naming the table — never an unbounded re-wait loop.
test('TABLE_DESCRIBE_MAX_ATTEMPTS is a finite positive bound (#241)', t => {
  t.true(Number.isInteger(TABLE_DESCRIBE_MAX_ATTEMPTS));
  t.true(TABLE_DESCRIBE_MAX_ATTEMPTS >= 1);
  t.true(Number.isFinite(TABLE_DESCRIBE_MAX_ATTEMPTS));
});

const buildMissingTableStreams = (options = {}) => {
  const warnings = [];
  const streams = new DynamodbStreams(
    {get: () => ({setEvent: () => {}, runHandler: () => Promise.resolve()})},
    {...options, region: 'eu-west-1', accountId: '000000000000'},
    {warning: message => warnings.push(message)}
  );
  return {streams, warnings};
};

const missingTableEvent = () =>
  new DynamodbStreamsEventDefinition({tableName: 'ghostTable'}, 'eu-west-1', '000000000000');

// EARS1: _describeTable must throw a CLEAR error naming the table after the bound,
// rather than recursing forever (the old `catch { return this._describeTable() }`).
test('_describeTable fails fast with a clear error naming the table when it never appears (#241)', async t => {
  const {streams} = buildMissingTableStreams();
  let attempts = 0;
  // Stub the AWS waiter edge so the table is always "missing".
  streams.client = {
    send: () => {
      attempts += 1;
      return Promise.reject(new Error('ResourceNotFoundException'));
    }
  };
  // Make the bounded waiter resolve to a rejection immediately (no real 120s wait).
  streams._waitUntilTableExists = () => Promise.reject(new Error('ResourceNotFoundException'));

  const error = await t.throwsAsync(() => streams._describeTable('ghostTable'));
  t.regex(error.message, /ghostTable/, 'the error names the missing table');
  t.true(attempts <= TABLE_DESCRIBE_MAX_ATTEMPTS + 1, 'the retry is bounded, not infinite');
});

// EARS1 (default): with no opt-in, a missing resource aborts start with a clear error.
test('_dynamodbStreamsEvent rejects with a clear error when the table is missing and no opt-in (#241)', async t => {
  const {streams} = buildMissingTableStreams();
  streams._describeTable = () => Promise.reject(new Error('Table ghostTable not found'));

  const error = await t.throwsAsync(() =>
    streams._dynamodbStreamsEvent('fnKey', undefined, missingTableEvent())
  );
  t.regex(error.message, /ghostTable/);
  t.is(streams.readables.length, 0, 'no readable was wired for the missing resource');
});

// EARS2: with the opt-in flag, a missing resource is WARNED and SKIPPED so the rest
// of serverless-offline still starts (the reporter's actual ask).
test('_dynamodbStreamsEvent warns and skips a missing table when continueOnMissingResource is set (#241)', async t => {
  const {streams, warnings} = buildMissingTableStreams({continueOnMissingResource: true});
  streams._describeTable = () => Promise.reject(new Error('Table ghostTable not found'));

  await t.notThrowsAsync(() =>
    streams._dynamodbStreamsEvent('fnKey', undefined, missingTableEvent())
  );
  t.is(streams.readables.length, 0, 'the missing event source is skipped');
  t.is(warnings.length, 1, 'a single warning was logged');
  t.regex(warnings[0], /ghostTable/, 'the warning names the table');
});

// EARS2: a table that exists but has no stream is also a "missing resource" — same
// opt-in warn-and-skip path (assertStreamEnabled throws).
test('_dynamodbStreamsEvent warns and skips a table without streams when continueOnMissingResource is set (#241)', async t => {
  const {streams, warnings} = buildMissingTableStreams({continueOnMissingResource: true});
  // Table exists, but LatestStreamArn is absent -> assertStreamEnabled throws.
  streams._describeTable = () => Promise.resolve({Table: {LatestStreamArn: undefined}});

  await t.notThrowsAsync(() =>
    streams._dynamodbStreamsEvent('fnKey', undefined, missingTableEvent())
  );
  t.is(streams.readables.length, 0);
  t.is(warnings.length, 1);
  t.regex(warnings[0], /ghostTable/);
});

// EARS1 (default, no stream): without the opt-in, a stream-less table still aborts.
test('_dynamodbStreamsEvent rejects for a table without streams when no opt-in (#241)', async t => {
  const {streams} = buildMissingTableStreams();
  streams._describeTable = () => Promise.resolve({Table: {LatestStreamArn: undefined}});

  const error = await t.throwsAsync(() =>
    streams._dynamodbStreamsEvent('fnKey', undefined, missingTableEvent())
  );
  t.regex(error.message, /streams/i);
});

// EARS1 source guard: the old unconditional self-recursion is gone.
test('src/dynamodb-streams.js no longer re-waits unconditionally in _describeTable (#241)', t => {
  const source = readSource('dynamodb-streams.js');
  t.false(
    /catch\s*\([^)]*\)\s*{\s*return this\._describeTable\(tableName\);?\s*}/.test(source),
    'the unbounded `catch { return this._describeTable(tableName) }` must be removed'
  );
});

// ---------------------------------------------------------------------------
// Lambda async destinations (onFailure / onSuccess) — spec B2
// ---------------------------------------------------------------------------

const CTX = {'AWS::Region': 'eu-west-1', 'AWS::AccountId': '000000000000'};

const fakeSqsClient = (impl = {}) => {
  const calls = [];
  return {
    calls,
    send: command => {
      const name = command.constructor.name;
      calls.push({name, input: command.input});
      if (name === 'GetQueueUrlCommand') {
        if (impl.getQueueUrlError) throw impl.getQueueUrlError;
        return Promise.resolve({QueueUrl: impl.queueUrl || 'http://localhost:9324/000/q'});
      }
      if (name === 'SendMessageCommand') return Promise.resolve({MessageId: 'm-1'});
      return Promise.resolve({});
    }
  };
};

test('destinations: resolveDestinationArn / queueNameFromArn (EARS1, EARS6)', t => {
  t.is(resolveDestinationArn({arn: {Ref: 'AWS::Region'}}, CTX), 'eu-west-1');
  t.is(resolveDestinationArn({arn: {'Fn::ImportValue': 'X'}}, CTX), undefined);
  t.is(queueNameFromArn('arn:aws:sqs:eu-west-1:0:my-dlq'), 'my-dlq');
});

test('destinations: build*Payload shapes (EARS5, EARS8)', t => {
  t.deepEqual(buildFailurePayload({a: 1}, Object.assign(new Error('boom'), {name: 'E'})), {
    requestPayload: {a: 1},
    responsePayload: {errorMessage: 'boom', errorType: 'E'}
  });
  t.deepEqual(buildSuccessPayload({a: 1}, {ok: 1}), {
    requestPayload: {a: 1},
    responsePayload: {ok: 1}
  });
});

test('destinations: dispatchDestination swallows a client error and warns (EARS7)', async t => {
  const client = fakeSqsClient({getQueueUrlError: new Error('gone')});
  const warnings = [];
  await t.notThrowsAsync(
    dispatchDestination({
      client,
      target: 'arn:aws:sqs:eu-west-1:0:dlq',
      ctx: CTX,
      payload: {},
      log: normalizeLog({warning: m => warnings.push(m)})
    })
  );
  t.is(warnings.length, 1);
});

test('destinations: runDestinations is a no-op (no client) when simulateDestinations is false (EARS2)', async t => {
  let built = false;
  await runDestinations({
    simulateDestinations: false,
    destinations: {onFailure: 'arn:aws:sqs:eu-west-1:0:dlq'},
    ctx: CTX,
    makeClient: () => {
      built = true;
      return fakeSqsClient();
    },
    log: normalizeLog(),
    requestPayload: {},
    error: new Error('boom')
  });
  t.false(built);
});

// A harness that drives the REAL writable with a configurable handler + injected SQS client, so we
// can exercise the retry-vs-exhaustion destinations wiring end-to-end (no AWS, no docker).
const buildDestinationsHarness = ({runHandler, destinations, sqsClient}) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-dest-')), DEFAULT_STATE_FILE);
  const handlerCalls = [];
  const lambda = {
    get: () => ({
      setEvent: event => handlerCalls.push(event),
      runHandler
    })
  };

  const streams = new DynamodbStreams(
    lambda,
    {
      region: 'eu-west-1',
      accountId: '000000000000',
      checkpointFile: file,
      simulateDestinations: true
    },
    {}
  );

  streams._describeTable = () => Promise.resolve({Table: {LatestStreamArn: HARNESS_STREAM_ARN}});
  streams.streamsClient.send = () =>
    Promise.resolve({StreamDescription: {Shards: [{ShardId: SHARD_ID}]}});
  // Inject the fake SQS client so destinations dispatch hits no real AWS.
  streams.sqsClient = sqsClient;

  return {streams, handlerCalls, destinations};
};

const runOneBatch = async ({runHandler, destinations, sqsClient}) => {
  const {streams} = buildDestinationsHarness({runHandler, destinations, sqsClient});
  await streams._dynamodbStreamsEvent(
    'fnKey',
    destinations,
    new DynamodbStreamsEventDefinition(
      {arn: HARNESS_STREAM_ARN, startingPosition: 'TRIM_HORIZON', maximumRetryAttempts: 3},
      'eu-west-1',
      '000000000000'
    )
  );
  const writable = writableOf(streams.readables[0]);
  await writeChunk(writable, [
    {...insertRecord, dynamodb: {...insertRecord.dynamodb, SequenceNumber: '100'}}
  ]);
};

// EARS4: retries exhausted -> exactly one onFailure dispatch with the stream records + error.
test('DDB: a handler that exhausts its retries dispatches onFailure once (EARS4)', async t => {
  const client = fakeSqsClient();
  await runOneBatch({
    runHandler: () => Promise.reject(Object.assign(new Error('boom'), {name: 'E'})),
    destinations: {onFailure: 'arn:aws:sqs:eu-west-1:0:my-dlq'},
    sqsClient: client
  });
  const sends = client.calls.filter(({name}) => name === 'SendMessageCommand');
  t.is(sends.length, 1, 'exactly one onFailure dispatch');
  const body = JSON.parse(sends[0].input.MessageBody);
  t.is(body.responsePayload.errorMessage, 'boom');
  t.is(body.responsePayload.errorType, 'E');
  t.truthy(body.requestPayload.Records, 'requestPayload carries the stream records');
});

// Edge 5: a handler that succeeds on a retry does NOT fire onFailure; onSuccess fires once.
test('DDB: a handler that succeeds on a retry fires onSuccess once, never onFailure (edge 5, EARS5)', async t => {
  const client = fakeSqsClient();
  let attempts = 0;
  await runOneBatch({
    runHandler: () => {
      attempts += 1;
      return attempts < 2
        ? Promise.reject(new Error('transient'))
        : Promise.resolve({statusCode: 200});
    },
    destinations: {
      onFailure: 'arn:aws:sqs:eu-west-1:0:dlq',
      onSuccess: 'arn:aws:sqs:eu-west-1:0:ok'
    },
    sqsClient: client
  });
  const getQueue = client.calls.find(({name}) => name === 'GetQueueUrlCommand');
  const sends = client.calls.filter(({name}) => name === 'SendMessageCommand');
  t.is(sends.length, 1, 'exactly one dispatch');
  t.is(getQueue.input.QueueName, 'ok', 'dispatched to onSuccess, not onFailure');
  t.deepEqual(JSON.parse(sends[0].input.MessageBody).responsePayload, {statusCode: 200});
});

// EARS5: a clean first-attempt run fires onSuccess once.
test('DDB: a clean handler run dispatches onSuccess once (EARS5)', async t => {
  const client = fakeSqsClient();
  await runOneBatch({
    runHandler: () => Promise.resolve({ok: true}),
    destinations: {onSuccess: 'arn:aws:sqs:eu-west-1:0:ok'},
    sqsClient: client
  });
  const sends = client.calls.filter(({name}) => name === 'SendMessageCommand');
  t.is(sends.length, 1);
  t.deepEqual(JSON.parse(sends[0].input.MessageBody).responsePayload, {ok: true});
});

// Edge 1: no destinations declared -> no SQS calls at all.
test('DDB: no destinations -> no SQS dispatch (edge 1)', async t => {
  const client = fakeSqsClient();
  await runOneBatch({
    runHandler: () => Promise.resolve({ok: true}),
    destinations: undefined,
    sqsClient: client
  });
  t.deepEqual(client.calls, []);
});

// EARS6: a Fn::GetAtt / Ref destination ARN pointing at a Queue declared in this.options.resources
// resolves to that queue. Build a minimal streams object so the test targets only the resolution path.
const buildStreamsForDispatch = (client, resources) => {
  const streams = Object.create(DynamodbStreams.prototype);
  streams.options = {
    region: 'eu-west-1',
    accountId: '000000000000',
    simulateDestinations: true,
    resources: {Resources: resources}
  };
  streams.sqsClient = client;
  streams.log = normalizeLog();
  return streams;
};

test('DDB._dispatchDestination resolves a Fn::GetAtt destination via options.resources (EARS6)', async t => {
  const client = fakeSqsClient();
  const streams = buildStreamsForDispatch(client, {
    MyDlq: {Type: 'AWS::SQS::Queue', Properties: {QueueName: 'my-dlq'}}
  });
  await streams._dispatchDestination(
    {onFailure: {'Fn::GetAtt': ['MyDlq', 'Arn']}},
    {Records: [{eventID: '1'}]},
    {error: Object.assign(new Error('boom'), {name: 'E'})}
  );
  t.is(client.calls[0].input.QueueName, 'my-dlq');
});

test('DDB._dispatchDestination resolves a {Ref: <Queue>} destination via options.resources (EARS6)', async t => {
  const client = fakeSqsClient();
  const streams = buildStreamsForDispatch(client, {OkQueue: {Type: 'AWS::SQS::Queue'}});
  await streams._dispatchDestination(
    {onSuccess: {Ref: 'OkQueue'}},
    {Records: [{eventID: '1'}]},
    {result: {ok: true}}
  );
  // No explicit QueueName -> falls back to the logical id.
  t.is(client.calls[0].input.QueueName, 'OkQueue');
});
