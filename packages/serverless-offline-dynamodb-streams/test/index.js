const fs = require('fs');
const path = require('path');

const test = require('ava');

const DynamodbStreamsReadable = require('dynamodb-streams-readable');
const {defaultLog, normalizeLog} = require('../src/log');
const DynamodbStreamsEvent = require('../src/dynamodb-streams-event');
const DynamodbStreamsEventDefinition = require('../src/dynamodb-streams-event-definition');
const {assertStreamEnabled} = require('../src/dynamodb-streams');
const {resolveTableName} = require('../src/resolve-arn');
const {recordMatchesFilterPatterns, filterRecords} = require('../src/filter-patterns');
const {toClientConfig, toCredentials} = require('../src/aws-client');
const {toCallbackMethod, toCallbackStreamsClient} = require('../src/dynamodb-streams-client');

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
// aws-sdk v3 migration (#248 EdgarOrtegaRamirez)
// ---------------------------------------------------------------------------
// Repro for #248: the plugin imported aws-sdk v2 (`aws-sdk/clients/dynamodb(streams)`), which printed
// the maintenance-mode warning. These guards FAIL on the pre-migration source (which `require`d
// aws-sdk v2 and called `.promise()` / `waitFor`) and PASS once the package speaks @aws-sdk v3.

// Scan executable code only: drop `//` line comments and `/* */` block comments so the guards match
// real imports/calls, not the issue references the migration leaves in the comments.
const stripComments = source =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('src no longer imports aws-sdk v2 anywhere (#248)', t => {
  ['dynamodb-streams.js', 'aws-client.js', 'dynamodb-streams-client.js'].forEach(file => {
    const code = stripComments(readSource(file));
    t.false(code.includes("require('aws-sdk"), `${file} must not require aws-sdk v2`);
    t.false(/aws-sdk\/clients\//.test(code), `${file} must not import an aws-sdk v2 client`);
  });
});

test('dynamodb-streams.js uses @aws-sdk v3 clients/commands/waiter, not v2 .promise()/waitFor (#248)', t => {
  const code = stripComments(readSource('dynamodb-streams.js'));

  t.true(code.includes("@aws-sdk/client-dynamodb'"));
  t.true(code.includes('@aws-sdk/client-dynamodb-streams'));
  t.true(code.includes('waitUntilTableExists'));
  t.true(code.includes('DescribeTableCommand'));
  t.true(code.includes('DescribeStreamCommand'));
  // the v2-only surfaces named in the issue are gone
  t.false(code.includes('.promise()'));
  t.false(code.includes('waitFor('));
});

test('package.json depends on @aws-sdk v3 clients and dropped aws-sdk v2 (#248)', t => {
  const pkg = JSON.parse(readSource('../package.json'));
  t.truthy(pkg.dependencies['@aws-sdk/client-dynamodb']);
  t.truthy(pkg.dependencies['@aws-sdk/client-dynamodb-streams']);
  t.is(pkg.dependencies['aws-sdk'], undefined);
});

// --- toClientConfig: flat v2 options -> nested v3 config -------------------

test('toClientConfig nests flat credentials and passes through region/endpoint', t => {
  t.deepEqual(
    toClientConfig({
      region: 'eu-west-1',
      endpoint: 'http://localhost:8000',
      accessKeyId: 'local',
      secretAccessKey: 'secret'
    }),
    {
      region: 'eu-west-1',
      endpoint: 'http://localhost:8000',
      credentials: {accessKeyId: 'local', secretAccessKey: 'secret'}
    }
  );
});

test('toClientConfig defaults a missing secretAccessKey to the accessKeyId (local-emulator parity)', t => {
  t.deepEqual(toClientConfig({region: 'eu-west-1', accessKeyId: '000000000000'}), {
    region: 'eu-west-1',
    credentials: {accessKeyId: '000000000000', secretAccessKey: '000000000000'}
  });
});

test('toClientConfig forwards a sessionToken when present', t => {
  t.deepEqual(
    toClientConfig({
      region: 'eu-west-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      sessionToken: 't'
    }),
    {region: 'eu-west-1', credentials: {accessKeyId: 'a', secretAccessKey: 'b', sessionToken: 't'}}
  );
});

test('toClientConfig omits credentials entirely when no accessKeyId is configured', t => {
  t.deepEqual(toClientConfig({region: 'eu-west-1', endpoint: 'http://localhost:8000'}), {
    region: 'eu-west-1',
    endpoint: 'http://localhost:8000'
  });
  t.is(toCredentials({region: 'eu-west-1'}), undefined);
});

test('toClientConfig drops unknown v2 keys (only region/endpoint/credentials reach v3)', t => {
  const config = toClientConfig({
    region: 'eu-west-1',
    accessKeyId: 'a',
    secretAccessKey: 'b',
    accountId: '000000000000',
    stage: 'dev',
    location: '.'
  });
  t.deepEqual(Object.keys(config).sort(), ['credentials', 'region']);
});

test('toClientConfig does not mutate its input', t => {
  const options = {region: 'eu-west-1', accessKeyId: 'a', secretAccessKey: 'b'};
  const before = JSON.parse(JSON.stringify(options));
  toClientConfig(options);
  t.deepEqual(options, before);
});

test('toClientConfig() with no argument is safe', t => {
  t.deepEqual(toClientConfig(), {});
});

// --- toCallbackMethod / toCallbackStreamsClient: v3 send() -> v2 callback ---

test('toCallbackMethod turns a resolved send() into callback(null, data)', async t => {
  const data = {ShardIterator: 'it-1'};
  const fakeClient = {send: () => Promise.resolve(data)};
  const method = toCallbackMethod(fakeClient, function Cmd(params) {
    this.input = params;
  });

  const result = await new Promise((resolve, reject) => {
    method({ShardId: 's'}, (err, d) => (err ? reject(err) : resolve(d)));
  });
  t.is(result, data);
});

test('toCallbackMethod wraps params in the v3 Command and routes a rejection to callback(err)', async t => {
  let received;
  const boom = Object.assign(new Error('nope'), {name: 'ExpiredIteratorException'});
  const fakeClient = {
    send: command => {
      received = command;
      return Promise.reject(boom);
    }
  };
  const method = toCallbackMethod(fakeClient, function Cmd(params) {
    this.input = params;
  });

  const err = await new Promise(resolve => {
    method({ShardIterator: 'it'}, e => resolve(e));
  });
  // err.name is exactly what dynamodb-streams-readable's isRecoverableIteratorError inspects
  t.is(err, boom);
  t.is(err.name, 'ExpiredIteratorException');
  t.deepEqual(received.input, {ShardIterator: 'it'});
});

test('toCallbackStreamsClient exposes the v2 callback trio over a v3 send() client', t => {
  const client = toCallbackStreamsClient({send: () => Promise.resolve({})});
  t.is(typeof client.getShardIterator, 'function');
  t.is(typeof client.describeStream, 'function');
  t.is(typeof client.getRecords, 'function');
});

// --- end-to-end shim: DynamoDBStreamReadable drives the v3-backed adapter ---
// Proves the readable's pure helpers keep working against the shim: a fake v3 `send()` returns one
// batch then drains; DynamoDBStreamReadable must emit exactly that batch and then `end`.

test('DynamoDBStreamReadable reads a record set through the v3->callback shim, then ends (#248)', t => {
  const record = {dynamodb: {Keys: {Id: {S: '1'}}, SequenceNumber: '111'}};

  // Minimal fake v3 streams client: describeStream -> one shard; getShardIterator -> a token;
  // getRecords -> the batch once, then an empty drain.
  const responsesFor = name =>
    ({
      DescribeStreamCommand: {StreamDescription: {Shards: [{ShardId: 'shard-1'}]}},
      GetShardIteratorCommand: {ShardIterator: 'iter-1'}
    }[name]);

  let served = false;
  const fakeV3Client = {
    send: command => {
      const name = command.constructor.name;
      if (name === 'GetRecordsCommand') {
        if (served) return Promise.resolve({Records: [], NextShardIterator: null});
        served = true;
        return Promise.resolve({Records: [record], NextShardIterator: 'iter-2'});
      }
      return Promise.resolve(responsesFor(name));
    }
  };

  const readable = DynamodbStreamsReadable(
    toCallbackStreamsClient(fakeV3Client),
    'arn:aws:dynamodb:eu-west-1:000000000000:table/t/stream/2024',
    {shardId: 'shard-1', readInterval: 1}
  );

  return new Promise((resolve, reject) => {
    const seen = [];
    readable
      .on('data', recordSet => {
        recordSet.forEach(r => seen.push(r));
        if (seen.length > 0) readable.close();
      })
      .on('end', () => {
        t.is(seen.length, 1);
        t.is(seen[0].dynamodb.SequenceNumber, '111');
        resolve();
      })
      .on('error', reject);
  });
});
