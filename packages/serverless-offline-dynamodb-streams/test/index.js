const fs = require('fs');
const os = require('os');
const path = require('path');

const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const DynamodbStreamsEvent = require('../src/dynamodb-streams-event');
const DynamodbStreamsEventDefinition = require('../src/dynamodb-streams-event-definition');
const {assertStreamEnabled, chunkSequenceNumber} = require('../src/dynamodb-streams');
const {resolveTableName} = require('../src/resolve-arn');
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

const LOG_LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'success'];

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

// EARS3 source guard: the checkpoint advances only inside the post-resolve `.then`,
// never before the handler runs.
test('src/dynamodb-streams.js advances the checkpoint only after the handler resolves (#178 EARS3)', t => {
  const source = readSource('dynamodb-streams.js');
  const thenIdx = source.indexOf('.then(() => {');
  const advanceIdx = source.indexOf('this._advanceCheckpoint(streamArn, shardId');

  t.true(advanceIdx > -1 && thenIdx > -1);
  t.true(advanceIdx > thenIdx, 'the advance call lives inside the post-handler .then');
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
