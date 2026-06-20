const fs = require('fs');
const path = require('path');

const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const DynamodbStreamsEvent = require('../src/dynamodb-streams-event');
const DynamodbStreamsEventDefinition = require('../src/dynamodb-streams-event-definition');
const {assertStreamEnabled} = require('../src/dynamodb-streams');

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
