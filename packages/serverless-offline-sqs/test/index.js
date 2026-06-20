const fs = require('fs');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {
  toDeleteEntries,
  resolveQueueName,
  toCreateQueueParams,
  resolveWaitTimeSeconds,
  partitionBatchForDeletion,
  collectQueueDefinitions,
  extractDlqTargetName,
  orderQueuesForCreation,
  normalizeQueueNames,
  expandSqsEventDefinitions
} = require('../src/sqs');
const SQSEvent = require('../src/sqs-event');
const SQSEventDefinition = require('../src/sqs-event-definition');
const {
  defaultOptions,
  isPluginEnabled,
  buildHookMap,
  shouldListenForTermination
} = require('../src');
const {extractQueueNameFromARN, resolveCfnValue} = require('../src/sqs-event-definition');

// ---------------------------------------------------------------------------
// normalizeLog
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
  // untouched methods fall back to defaults
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

// ---------------------------------------------------------------------------
// toDeleteEntries (#253 flipscholtz)
// ---------------------------------------------------------------------------

test('toDeleteEntries derives a unique short Id per message from the index', t => {
  const messages = [
    {MessageId: 'dup', ReceiptHandle: 'rh-0'},
    {MessageId: 'dup', ReceiptHandle: 'rh-1'},
    {MessageId: 'dup', ReceiptHandle: 'rh-2'}
  ];

  const entries = toDeleteEntries(messages);

  t.deepEqual(entries, [
    {Id: '0', ReceiptHandle: 'rh-0'},
    {Id: '1', ReceiptHandle: 'rh-1'},
    {Id: '2', ReceiptHandle: 'rh-2'}
  ]);
});

test('toDeleteEntries Ids are unique within a batch even when MessageIds collide', t => {
  const messages = Array.from({length: 25}, () => ({MessageId: 'same', ReceiptHandle: 'rh'}));
  const ids = toDeleteEntries(messages).map(({Id}) => Id);
  t.is(new Set(ids).size, ids.length);
});

test('toDeleteEntries Ids respect the 80-char SQS batch-entry limit', t => {
  const longId = 'x'.repeat(200);
  const messages = [{MessageId: longId, ReceiptHandle: 'rh'}];
  const [{Id}] = toDeleteEntries(messages);
  t.true(Id.length <= 80);
});

test('toDeleteEntries preserves the ReceiptHandle', t => {
  const messages = [{MessageId: 'a', ReceiptHandle: 'keep-me'}];
  t.is(toDeleteEntries(messages)[0].ReceiptHandle, 'keep-me');
});

test('toDeleteEntries handles undefined and empty input', t => {
  t.deepEqual(toDeleteEntries(), []);
  t.deepEqual(toDeleteEntries(undefined), []);
  t.deepEqual(toDeleteEntries([]), []);
});

// ---------------------------------------------------------------------------
// resolveQueueName (#211 mfamilia)
// ---------------------------------------------------------------------------

test('resolveQueueName override wins when options.queueName is set', t => {
  const def = {queueName: 'fromEvent', batchSize: 5};
  const resolved = resolveQueueName({queueName: 'override'}, def);
  t.is(resolved.queueName, 'override');
});

test('resolveQueueName preserves the rest of the definition when overriding', t => {
  const def = {queueName: 'fromEvent', batchSize: 5, enabled: true};
  const resolved = resolveQueueName({queueName: 'override'}, def);
  t.is(resolved.batchSize, 5);
  t.is(resolved.enabled, true);
});

test('resolveQueueName falls back to the event definition when no override', t => {
  const def = {queueName: 'fromEvent'};
  t.is(resolveQueueName({}, def), def);
  t.is(resolveQueueName({queueName: undefined}, def), def);
  t.is(resolveQueueName(undefined, def), def);
});

test('resolveQueueName does not mutate its input definition', t => {
  const def = {queueName: 'fromEvent', batchSize: 5};
  const before = {...def};
  resolveQueueName({queueName: 'override'}, def);
  t.deepEqual(def, before);
});

test('resolveQueueName supports a string ARN definition (override path)', t => {
  const def = 'arn:aws:sqs:eu-west-1:000000000000:fromEvent';
  const resolved = resolveQueueName({queueName: 'override'}, def);
  t.is(resolved.queueName, 'override');
  // the string must NOT be spread into a char-indexed object, and arn is stripped
  t.deepEqual(Object.keys(resolved), ['queueName']);
});

test('resolveQueueName override wins for an {arn} definition and rebuilds the ARN downstream', t => {
  // Regression guard: SQSEventDefinition's switch prefers `arn` over `queueName`,
  // so the override must strip `arn` to actually take effect (#211).
  const def = {arn: 'arn:aws:sqs:eu-west-1:000000000000:fromEvent', batchSize: 7};
  const resolved = resolveQueueName({queueName: 'override'}, def);
  t.is(resolved.arn, undefined);
  t.is(resolved.queueName, 'override');
  t.is(resolved.batchSize, 7); // other props preserved

  const sqsEvent = new SQSEventDefinition(resolved, 'eu-west-1', '000000000000');
  t.is(sqsEvent.queueName, 'override');
  t.is(sqsEvent.arn, 'arn:aws:sqs:eu-west-1:000000000000:override');
});

// ---------------------------------------------------------------------------
// SQSEvent mapper — awsRegion regression guard (#166 zlalvani)
// ---------------------------------------------------------------------------

const sampleMessage = {
  MessageId: 'mid-1',
  ReceiptHandle: 'rh-1',
  Body: '{"hello":"world"}',
  Attributes: {SentTimestamp: '1700000000000'},
  MessageAttributes: {MyAttr: {StringValue: 'v', DataType: 'String'}},
  MD5OfBody: 'abc123'
};

test('SQSEvent maps an SQS message to the aws:sqs Lambda event shape', t => {
  const arn = 'arn:aws:sqs:eu-west-1:000000000000:MyQueue';
  const event = new SQSEvent([sampleMessage], 'eu-west-1', arn);

  t.is(event.Records.length, 1);
  const [record] = event.Records;
  t.is(record.messageId, 'mid-1');
  t.is(record.receiptHandle, 'rh-1');
  t.is(record.body, '{"hello":"world"}');
  t.is(record.md5OfBody, 'abc123');
  t.is(record.eventSource, 'aws:sqs');
  t.is(record.eventSourceARN, arn);
});

test('SQSEvent sets the correct awsRegion (regression guard for #166)', t => {
  const event = new SQSEvent([sampleMessage], 'eu-west-1', 'arn:aws:sqs:eu-west-1:0:Q');
  t.is(event.Records[0].awsRegion, 'eu-west-1');
  t.not(event.Records[0].awsRegion, undefined);
});

test('SQSEvent lower-firsts message attribute keys', t => {
  const event = new SQSEvent([sampleMessage], 'eu-west-1', 'arn:aws:sqs:eu-west-1:0:Q');
  const {messageAttributes} = event.Records[0];
  t.deepEqual(messageAttributes, {MyAttr: {stringValue: 'v', dataType: 'String'}});
});

// ---------------------------------------------------------------------------
// SQSEventDefinition — used downstream of resolveQueueName
// ---------------------------------------------------------------------------

test('SQSEventDefinition builds the ARN from the resolved queueName', t => {
  const def = resolveQueueName({queueName: 'override'}, {queueName: 'fromEvent'});
  const sqsEvent = new SQSEventDefinition(def, 'eu-west-1', '000000000000');
  t.is(sqsEvent.queueName, 'override');
  t.is(sqsEvent.arn, 'arn:aws:sqs:eu-west-1:000000000000:override');
});

// ---------------------------------------------------------------------------
// ARN -> queueName resolution: intrinsics (#200) & pseudo-parameters (#74)
// ---------------------------------------------------------------------------

test('extractQueueNameFromARN extracts the last segment of a plain string ARN', t => {
  t.is(
    extractQueueNameFromARN('arn:aws:sqs:eu-west-1:000000000000:MyQueue', 'eu-west-1', '0'),
    'MyQueue'
  );
});

test('#74 extractQueueNameFromARN resolves the #{AWS::AccountId} pseudo-parameter', t => {
  // serverless-pseudo-parameters leaves `#{AWS::AccountId}` in the ARN; the extra `::` it
  // injects used to push split(':')[5] onto an empty segment => empty QueueName.
  t.is(
    extractQueueNameFromARN(
      'arn:aws:sqs:eu-west-1:#{AWS::AccountId}:MyQueue',
      'eu-west-1',
      '000000000000'
    ),
    'MyQueue'
  );
});

test('#74 extractQueueNameFromARN resolves #{AWS::Region} and #{AWS::AccountId} together', t => {
  t.is(
    extractQueueNameFromARN(
      'arn:aws:sqs:#{AWS::Region}:#{AWS::AccountId}:OrdersQueue',
      'eu-west-1',
      '123456789012'
    ),
    'OrdersQueue'
  );
});

test('#200 extractQueueNameFromARN resolves a Fn::Join ARN with a nested Ref AWS::AccountId', t => {
  const arn = {
    'Fn::Join': [
      ':',
      ['arn:aws:sqs:eu-west-1', {Ref: 'AWS::AccountId'}, 'local-salesforce-customers-update']
    ]
  };
  t.is(
    extractQueueNameFromARN(arn, 'eu-west-1', '000000000000'),
    'local-salesforce-customers-update'
  );
});

test('#200 SQSEventDefinition resolves a Fn::Join {arn} object to a clean queueName + ARN', t => {
  // Exact repro from the issue: an `arn` given as Fn::Join used to yield `:undefined`.
  const def = {
    arn: {
      'Fn::Join': [
        ':',
        ['arn:aws:sqs:eu-west-1', {Ref: 'AWS::AccountId'}, 'local-salesforce-customers-update']
      ]
    },
    batchSize: 1
  };
  const sqsEvent = new SQSEventDefinition(def, 'eu-west-1', '000000000000');
  t.is(sqsEvent.queueName, 'local-salesforce-customers-update');
  t.is(sqsEvent.arn, 'arn:aws:sqs:eu-west-1:000000000000:local-salesforce-customers-update');
  t.is(sqsEvent.batchSize, 1); // other props preserved
});

test('#74 SQSEventDefinition resolves a pseudo-parameter string ARN to a clean queueName', t => {
  const sqsEvent = new SQSEventDefinition(
    'arn:aws:sqs:eu-west-1:#{AWS::AccountId}:MyQueue',
    'eu-west-1',
    '000000000000'
  );
  t.is(sqsEvent.queueName, 'MyQueue');
  t.is(sqsEvent.arn, 'arn:aws:sqs:eu-west-1:000000000000:MyQueue');
});

test('resolveCfnValue resolves Ref / Fn::Sub / Fn::Join / pseudo-param strings', t => {
  const ctx = {'AWS::Region': 'eu-west-1', 'AWS::AccountId': '000000000000'};
  // Assemble the Fn::Sub token so the literal `${...}` never appears in source (keeps the
  // no-template-curly-in-string lint clean); the value passed in still reads `q-${AWS::Region}`.
  const subTemplate = `q-$${'{AWS::Region}'}`;
  t.is(resolveCfnValue({Ref: 'AWS::AccountId'}, ctx), '000000000000');
  t.is(resolveCfnValue({'Fn::Sub': subTemplate}, ctx), 'q-eu-west-1');
  t.is(resolveCfnValue('plain-string', ctx), 'plain-string');
  t.is(resolveCfnValue('p-#{AWS::AccountId}', ctx), 'p-000000000000');
  t.is(
    resolveCfnValue({'Fn::Join': ['-', ['a', {Ref: 'AWS::Region'}, 'b']]}, ctx),
    'a-eu-west-1-b'
  );
});

test('extractQueueNameFromARN returns undefined for an unresolvable ARN (no throw)', t => {
  t.is(extractQueueNameFromARN(undefined, 'eu-west-1', '0'), undefined);
  t.is(extractQueueNameFromARN({'Fn::ImportValue': 'x'}, 'eu-west-1', '0'), undefined);
  t.notThrows(() => extractQueueNameFromARN({Ref: 'SomeQueue'}, 'eu-west-1', '0'));
});

test('extractQueueNameFromARN keeps a .fifo suffix intact (#189 belongs to the FIFO theme)', t => {
  t.is(
    extractQueueNameFromARN('arn:aws:sqs:eu-west-1:000000000000:Orders.fifo', 'eu-west-1', '0'),
    'Orders.fifo'
  );
});

// ---------------------------------------------------------------------------
// #166 call-site guard (source-level): the live SQS poll handler must build the
// event with this.options.region, not the undefined this.region.
// ---------------------------------------------------------------------------

test('src/sqs.js builds SQSEvent with this.options.region, not this.region (#166)', t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'sqs.js'), 'utf8');
  t.true(source.includes('this.options.region'));
  t.false(/new SQSEvent\(messages, this\.region\b/.test(source));
});

// ---------------------------------------------------------------------------
// defaultOptions — idle-CPU guard (#158 raymond-w-ko)
// ---------------------------------------------------------------------------

test('#158 defaultOptions sets a finite idle-cleanup time so the pool timer is not NaN', t => {
  // serverless-offline's LambdaFunctionPool schedules its idle-cleanup timer as
  // setTimeout(fn, options.<idleOption> * 1000). When the option is absent the product is NaN,
  // which busy-loops the timer at ~50% CPU on idle. The option was renamed across versions:
  //   <= v12: functionCleanupIdleTimeSeconds   >= v13: terminateIdleLambdaTime
  // so both must be a finite number for setTimeout(fn, x * 1000) to be valid.
  t.true(Number.isFinite(defaultOptions.terminateIdleLambdaTime));
  t.true(Number.isFinite(defaultOptions.functionCleanupIdleTimeSeconds));
  t.false(Number.isNaN(defaultOptions.terminateIdleLambdaTime * 1000));
  t.false(Number.isNaN(defaultOptions.functionCleanupIdleTimeSeconds * 1000));
});

test('#158 the idle-cleanup defaults match serverless-offline default of 60 seconds', t => {
  t.is(defaultOptions.terminateIdleLambdaTime, 60);
  t.is(defaultOptions.functionCleanupIdleTimeSeconds, 60);
});

// ---------------------------------------------------------------------------
// isPluginEnabled — local disable toggle (#222 gndelia)
// ---------------------------------------------------------------------------

test('#222 isPluginEnabled defaults to true when the flag is absent', t => {
  t.true(isPluginEnabled({}));
  t.true(isPluginEnabled(undefined));
  t.true(isPluginEnabled({region: 'eu-west-1', autoCreate: true}));
});

test('#222 isPluginEnabled honors an explicit enabled:false (boolean or string)', t => {
  t.false(isPluginEnabled({enabled: false}));
  t.false(isPluginEnabled({enabled: 'false'}));
});

test('#222 isPluginEnabled stays enabled for truthy/explicit-true values', t => {
  t.true(isPluginEnabled({enabled: true}));
  t.true(isPluginEnabled({enabled: 'true'}));
});

test('#222 isPluginEnabled is a pure read with no side effects on its input', t => {
  const opts = {enabled: false, region: 'eu-west-1'};
  const before = {...opts};
  isPluginEnabled(opts);
  t.deepEqual(opts, before);
});

test('#222 defaultOptions carries no plugin-level enabled (absence means enabled)', t => {
  // the plugin-wide toggle is opt-out only and must not collide with the per-event enabled property
  t.false('enabled' in defaultOptions);
});

// ---------------------------------------------------------------------------
// toCreateQueueParams — explicit-queue creation hardening (#225 tomusiaka)
// + FIFO inference (#159 / #189)
// ---------------------------------------------------------------------------

test('#225 toCreateQueueParams never puts QueueName into Attributes', t => {
  const params = toCreateQueueParams('MyQueue', {QueueName: 'MyQueue', VisibilityTimeout: 30});
  t.is(params.QueueName, 'MyQueue');
  t.false('QueueName' in params.Attributes);
  t.is(params.Attributes.VisibilityTimeout, '30');
});

test('#225 toCreateQueueParams keeps only valid SQS attribute keys, stringified', t => {
  const params = toCreateQueueParams('MyQueue', {
    QueueName: 'MyQueue',
    VisibilityTimeout: 30,
    RedrivePolicy: {deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:0:dlq', maxReceiveCount: 5},
    BogusKey: 'nope'
  });
  t.deepEqual(params.Attributes, {
    VisibilityTimeout: '30',
    RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:0:dlq","maxReceiveCount":5}'
  });
  t.is(params.Attributes.BogusKey, undefined); // unknown keys dropped, not forwarded
});

test('#225 toCreateQueueParams routes CloudFormation Tags to the tags param, not Attributes', t => {
  const params = toCreateQueueParams('MyQueue', {QueueName: 'MyQueue', Tags: {team: 'core'}});
  t.is(params.Attributes.Tags, undefined);
  t.deepEqual(params.tags, {team: 'core'});
});

test('#225 toCreateQueueParams normalizes CloudFormation list-form Tags to a map', t => {
  // CloudFormation AWS::SQS::Queue Tags is a list of {Key, Value}; the SQS `tags` param is a map.
  const params = toCreateQueueParams('MyQueue', {
    QueueName: 'MyQueue',
    Tags: [
      {Key: 'team', Value: 'core'},
      {Key: 'env', Value: 'dev'}
    ]
  });
  t.deepEqual(params.tags, {team: 'core', env: 'dev'});
  t.is(params.Attributes.Tags, undefined);
});

test('#225 toCreateQueueParams omits the tags param when no Tags are present', t => {
  const params = toCreateQueueParams('MyQueue', {QueueName: 'MyQueue'});
  t.false('tags' in params);
  t.deepEqual(params.Attributes, {});
});

test('#225 toCreateQueueParams tolerates missing/empty properties (implicit autoCreate queue)', t => {
  t.deepEqual(toCreateQueueParams('Implicit', undefined), {QueueName: 'Implicit', Attributes: {}});
  t.deepEqual(toCreateQueueParams('Implicit', {}), {QueueName: 'Implicit', Attributes: {}});
});

test('#225 toCreateQueueParams does not mutate the input properties', t => {
  const properties = {QueueName: 'MyQueue', VisibilityTimeout: 30, Tags: {a: 'b'}};
  const before = JSON.parse(JSON.stringify(properties));
  toCreateQueueParams('MyQueue', properties);
  t.deepEqual(properties, before);
});

test('#159 toCreateQueueParams keeps FifoQueue for a FIFO resource (FifoQueue: true)', t => {
  const {Attributes} = toCreateQueueParams('p-queue.fifo', {
    QueueName: 'p-queue.fifo',
    FifoQueue: true,
    ContentBasedDeduplication: true
  });
  t.is(Attributes.FifoQueue, 'true');
  t.is(Attributes.ContentBasedDeduplication, 'true');
});

test('#189 toCreateQueueParams infers FIFO from a .fifo name even without the FifoQueue flag', t => {
  t.is(toCreateQueueParams('orders.fifo', {}).Attributes.FifoQueue, 'true');
});

test('toCreateQueueParams leaves a standard queue without a FifoQueue attribute', t => {
  t.false('FifoQueue' in toCreateQueueParams('plain-queue', {QueueName: 'plain-queue'}).Attributes);
});

// ---------------------------------------------------------------------------
// resolveWaitTimeSeconds — maximumBatchingWindow support (#227 tomusiaka)
// ---------------------------------------------------------------------------

test('#227 resolveWaitTimeSeconds falls back to the default when unset', t => {
  t.is(resolveWaitTimeSeconds({}, 5), 5);
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: undefined}, 5), 5);
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 'oops'}, 5), 5);
});

test('#227 resolveWaitTimeSeconds honors 0 (instant short-poll), not treated as falsy', t => {
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 0}, 5), 0);
});

test('#227 resolveWaitTimeSeconds passes through a valid in-range value', t => {
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 20}, 5), 20);
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 12}, 5), 12);
});

test('#227 resolveWaitTimeSeconds clamps to the SQS long-poll max of 20s', t => {
  // serverless allows maximumBatchingWindow up to 300, but ReceiveMessage WaitTimeSeconds maxes at 20
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 300}, 5), 20);
});

test('#227 resolveWaitTimeSeconds clamps negatives to 0', t => {
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: -3}, 5), 0);
});

// ---------------------------------------------------------------------------
// partitionBatchForDeletion — partial batch failure reporting (#221 successkrisz)
// ---------------------------------------------------------------------------

const mkMessages = ids => ids.map(id => ({MessageId: id, ReceiptHandle: `rh-${id}`}));

test('#221 partitionBatchForDeletion deletes the whole batch when report mode is OFF', t => {
  const messages = mkMessages(['a', 'b', 'c']);
  const toDelete = partitionBatchForDeletion(messages, {
    reportBatchItemFailures: false,
    result: {batchItemFailures: [{itemIdentifier: 'b'}]} // ignored in legacy mode
  });
  t.deepEqual(
    toDelete.map(({MessageId}) => MessageId),
    ['a', 'b', 'c']
  );
});

test('#221 partitionBatchForDeletion deletes only the successes in report mode', t => {
  const messages = mkMessages(['a', 'b', 'c']);
  const toDelete = partitionBatchForDeletion(messages, {
    reportBatchItemFailures: true,
    result: {batchItemFailures: [{itemIdentifier: 'b'}]}
  });
  t.deepEqual(
    toDelete.map(({MessageId}) => MessageId),
    ['a', 'c']
  );
  // the failed message is NOT deleted -> SQS redrives it
  t.false(toDelete.some(({ReceiptHandle}) => ReceiptHandle === 'rh-b'));
});

test('#221 partitionBatchForDeletion treats empty/absent batchItemFailures as full success', t => {
  const messages = mkMessages(['a', 'b']);
  t.is(partitionBatchForDeletion(messages, {reportBatchItemFailures: true, result: {}}).length, 2);
  t.is(
    partitionBatchForDeletion(messages, {
      reportBatchItemFailures: true,
      result: {batchItemFailures: []}
    }).length,
    2
  );
  t.is(
    partitionBatchForDeletion(messages, {reportBatchItemFailures: true, result: null}).length,
    2
  );
});

test('#221 partitionBatchForDeletion deletes nothing on total failure (thrown handler)', t => {
  const messages = mkMessages(['a', 'b']);
  t.deepEqual(
    partitionBatchForDeletion(messages, {reportBatchItemFailures: true, failed: true}),
    []
  );
});

test('#221 partitionBatchForDeletion tolerates unknown and duplicate itemIdentifiers', t => {
  const messages = mkMessages(['a', 'b']);
  const toDelete = partitionBatchForDeletion(messages, {
    reportBatchItemFailures: true,
    result: {
      batchItemFailures: [{itemIdentifier: 'b'}, {itemIdentifier: 'zzz'}, {itemIdentifier: 'b'}]
    }
  });
  t.deepEqual(
    toDelete.map(({MessageId}) => MessageId),
    ['a']
  );
});

test('#221 partitionBatchForDeletion survivors feed toDeleteEntries with fresh unique Ids', t => {
  const messages = mkMessages(['a', 'b', 'c']);
  const kept = partitionBatchForDeletion(messages, {
    reportBatchItemFailures: true,
    result: {batchItemFailures: [{itemIdentifier: 'b'}]}
  });
  t.deepEqual(toDeleteEntries(kept), [
    {Id: '0', ReceiptHandle: 'rh-a'},
    {Id: '1', ReceiptHandle: 'rh-c'}
  ]);
});

// ---------------------------------------------------------------------------
// collectQueueDefinitions — scan ALL AWS::SQS::Queue resources (#65 tclindner, #133 esetnik)
// ---------------------------------------------------------------------------

test('#65 collectQueueDefinitions returns every AWS::SQS::Queue, incl. a non-event DLQ', t => {
  // NOTE: resources here are POST index._resolveFn, so deadLetterTargetArn is a resolved ARN string.
  const resources = {
    MainQueue: {
      Type: 'AWS::SQS::Queue',
      Properties: {
        QueueName: 'MainQueue',
        RedrivePolicy: {
          deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:MainDlq',
          maxReceiveCount: 5
        }
      }
    },
    MainDlq: {Type: 'AWS::SQS::Queue', Properties: {QueueName: 'MainDlq'}},
    NotAQueue: {Type: 'AWS::S3::Bucket', Properties: {BucketName: 'nope'}}
  };
  const defs = collectQueueDefinitions(resources);
  const names = defs.map(({queueName}) => queueName).sort();
  t.deepEqual(names, ['MainDlq', 'MainQueue']);
  // S3 bucket excluded
  t.false(names.includes('nope'));
  // properties are carried through for downstream toCreateQueueParams
  const main = defs.find(({queueName}) => queueName === 'MainQueue');
  t.is(main.properties.RedrivePolicy.maxReceiveCount, 5);
});

test('#65 collectQueueDefinitions tolerates missing/empty resources without throwing', t => {
  t.deepEqual(collectQueueDefinitions(undefined), []);
  t.deepEqual(collectQueueDefinitions({}), []);
  t.deepEqual(collectQueueDefinitions(null), []);
});

test('#65 collectQueueDefinitions does not mutate its input', t => {
  const resources = {Q: {Type: 'AWS::SQS::Queue', Properties: {QueueName: 'Q'}}};
  const before = JSON.parse(JSON.stringify(resources));
  collectQueueDefinitions(resources);
  t.deepEqual(resources, before);
});

// ---------------------------------------------------------------------------
// extractDlqTargetName — derive the DLQ name from a RedrivePolicy (#167 jlippitt)
// ---------------------------------------------------------------------------

test('#167 extractDlqTargetName reads the DLQ name from a resolved deadLetterTargetArn', t => {
  const properties = {
    QueueName: 'MainQueue',
    RedrivePolicy: {
      deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:MainDlq',
      maxReceiveCount: 5
    }
  };
  t.is(extractDlqTargetName(properties, 'eu-west-1', '000000000000'), 'MainDlq');
});

test('#167 extractDlqTargetName returns undefined when there is no RedrivePolicy', t => {
  t.is(extractDlqTargetName({QueueName: 'Plain'}, 'eu-west-1', '0'), undefined);
  t.is(extractDlqTargetName({}, 'eu-west-1', '0'), undefined);
  t.is(extractDlqTargetName(undefined, 'eu-west-1', '0'), undefined);
});

test('#167 extractDlqTargetName degrades to undefined for an unresolvable intrinsic (no throw)', t => {
  const properties = {
    QueueName: 'MainQueue',
    RedrivePolicy: {deadLetterTargetArn: {'Fn::ImportValue': 'SomeExportedDlqArn'}}
  };
  t.notThrows(() => extractDlqTargetName(properties, 'eu-west-1', '0'));
  t.is(extractDlqTargetName(properties, 'eu-west-1', '0'), undefined);
});

test('#167 extractDlqTargetName keeps a .fifo DLQ suffix intact', t => {
  const properties = {
    RedrivePolicy: {deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:Orders-dlq.fifo'}
  };
  t.is(extractDlqTargetName(properties, 'eu-west-1', '0'), 'Orders-dlq.fifo');
});

// ---------------------------------------------------------------------------
// orderQueuesForCreation — DLQ-first dependency ordering (#133 will-holley, #167 Zer0x00)
// ---------------------------------------------------------------------------

const mkDef = (queueName, dlqArn) => ({
  queueName,
  properties: {
    ...(dlqArn ? {RedrivePolicy: {deadLetterTargetArn: dlqArn, maxReceiveCount: 5}} : {}),
    QueueName: queueName
  }
});
const arnOf = name => `arn:aws:sqs:eu-west-1:000000000000:${name}`;

test('#167 orderQueuesForCreation puts a referenced DLQ before its referencing queue', t => {
  const defs = [mkDef('MainQueue', arnOf('MainDlq')), mkDef('MainDlq')];
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '000000000000').map(d => d.queueName);
  t.true(ordered.indexOf('MainDlq') < ordered.indexOf('MainQueue'));
  // same set, no drops/dups
  t.deepEqual([...ordered].sort(), ['MainDlq', 'MainQueue']);
});

test('#133 orderQueuesForCreation is stable for queues with no redrive relationship', t => {
  const defs = [mkDef('A'), mkDef('B'), mkDef('C')];
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '0').map(d => d.queueName);
  t.deepEqual(ordered, ['A', 'B', 'C']);
});

test('#133 orderQueuesForCreation orders a chained DLQ (A->B->C => C,B,A)', t => {
  // A redrives to B, B redrives to C
  const defs = [mkDef('A', arnOf('B')), mkDef('B', arnOf('C')), mkDef('C')];
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '000000000000').map(d => d.queueName);
  t.true(ordered.indexOf('C') < ordered.indexOf('B'));
  t.true(ordered.indexOf('B') < ordered.indexOf('A'));
  t.deepEqual([...ordered].sort(), ['A', 'B', 'C']);
});

test('#167 orderQueuesForCreation keeps a queue whose DLQ target is absent from the set', t => {
  const defs = [mkDef('MainQueue', arnOf('ExternalDlq'))]; // ExternalDlq not in the set
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '000000000000').map(d => d.queueName);
  t.deepEqual(ordered, ['MainQueue']);
});

test('#167 orderQueuesForCreation does not loop forever on a cyclic reference', t => {
  // pathological: A redrives to B and B redrives to A
  const defs = [mkDef('A', arnOf('B')), mkDef('B', arnOf('A'))];
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '000000000000').map(d => d.queueName);
  t.is(ordered.length, 2);
  t.deepEqual([...ordered].sort(), ['A', 'B']);
});

test('#167 orderQueuesForCreation does not mutate its input', t => {
  const defs = [mkDef('MainQueue', arnOf('MainDlq')), mkDef('MainDlq')];
  const before = JSON.parse(JSON.stringify(defs));
  orderQueuesForCreation(defs, 'eu-west-1', '000000000000');
  t.deepEqual(defs, before);
});

// ---------------------------------------------------------------------------
// #87 confirm-only regression guards (PhouvanhKCSV): RedrivePolicy + maxReceiveCount +
// MessageRetentionPeriod are forwarded to createQueue as stringified Attributes.
// (toCreateQueueParams is already exported & imported in this file.)
// ---------------------------------------------------------------------------

test('#87 toCreateQueueParams forwards MessageRetentionPeriod as a stringified Attribute', t => {
  const params = toCreateQueueParams('MainQueue', {
    QueueName: 'MainQueue',
    MessageRetentionPeriod: 1209600
  });
  t.is(params.Attributes.MessageRetentionPeriod, '1209600');
});

test('#87 toCreateQueueParams forwards RedrivePolicy incl. maxReceiveCount for the main queue', t => {
  const params = toCreateQueueParams('MainQueue', {
    QueueName: 'MainQueue',
    RedrivePolicy: {
      deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:MainDlq',
      maxReceiveCount: 5
    }
  });
  t.is(
    params.Attributes.RedrivePolicy,
    '{"deadLetterTargetArn":"arn:aws:sqs:eu-west-1:000000000000:MainDlq","maxReceiveCount":5}'
  );
});

// ---------------------------------------------------------------------------
// normalizeQueueNames / expandSqsEventDefinitions — multi-queue fan-out (#262 renanlido)
// ---------------------------------------------------------------------------

test('#262 normalizeQueueNames passes a single scalar name through as a one-element array', t => {
  t.deepEqual(normalizeQueueNames('only'), ['only']);
});

test('#262 normalizeQueueNames splits a comma-separated string and trims each name', t => {
  t.deepEqual(normalizeQueueNames('a, b ,c'), ['a', 'b', 'c']);
});

test('#262 normalizeQueueNames flattens an array (including comma-bearing members)', t => {
  t.deepEqual(normalizeQueueNames(['a', 'b']), ['a', 'b']);
  t.deepEqual(normalizeQueueNames(['a', 'b,c']), ['a', 'b', 'c']);
});

test('#262 normalizeQueueNames de-duplicates repeated names (array and string forms)', t => {
  t.deepEqual(normalizeQueueNames(['a', 'a', 'b']), ['a', 'b']);
  t.deepEqual(normalizeQueueNames('a,a,b'), ['a', 'b']);
});

test('#262 normalizeQueueNames returns [] for empty/nullish input without throwing', t => {
  t.deepEqual(normalizeQueueNames(undefined), []);
  t.deepEqual(normalizeQueueNames(null), []);
  t.deepEqual(normalizeQueueNames(''), []);
  t.deepEqual(normalizeQueueNames([]), []);
  t.deepEqual(normalizeQueueNames('  ,  '), []);
});

test('#262 expandSqsEventDefinitions fans out an array queueName into one def per queue', t => {
  const defs = expandSqsEventDefinitions({}, {queueName: ['a', 'b'], batchSize: 5});
  t.deepEqual(defs, [
    {queueName: 'a', batchSize: 5},
    {queueName: 'b', batchSize: 5}
  ]);
});

test('#262 expandSqsEventDefinitions fans out a comma-separated event queueName', t => {
  const defs = expandSqsEventDefinitions({}, {queueName: 'a,b,c'});
  t.deepEqual(defs, [{queueName: 'a'}, {queueName: 'b'}, {queueName: 'c'}]);
});

test('#262 expandSqsEventDefinitions yields a single def for a scalar queueName (no behavior change)', t => {
  t.deepEqual(expandSqsEventDefinitions({}, {queueName: 'only'}), [{queueName: 'only'}]);
});

test('#262 expandSqsEventDefinitions: override (array) wins and fans out, stripping arn (#211 guard)', t => {
  const event = {arn: 'arn:aws:sqs:eu-west-1:0:fromEvent', batchSize: 3};
  const defs = expandSqsEventDefinitions({queueName: ['x', 'y']}, event);
  t.deepEqual(defs, [
    {queueName: 'x', batchSize: 3},
    {queueName: 'y', batchSize: 3}
  ]);
  // each rebuilds its ARN downstream from the override (the #211 arn-strip contract)
  const built = defs.map(d => new SQSEventDefinition(d, 'eu-west-1', '000000000000'));
  t.deepEqual(
    built.map(b => b.queueName),
    ['x', 'y']
  );
  t.is(built[0].arn, 'arn:aws:sqs:eu-west-1:000000000000:x');
});

test('#262 expandSqsEventDefinitions: comma-separated override wins over event-level array', t => {
  const defs = expandSqsEventDefinitions(
    {queueName: 'x, y'},
    {queueName: ['a', 'b'], batchSize: 1}
  );
  t.deepEqual(defs, [
    {queueName: 'x', batchSize: 1},
    {queueName: 'y', batchSize: 1}
  ]);
});

test('#262 expandSqsEventDefinitions preserves all other props on every fanned-out def', t => {
  const event = {
    queueName: ['a', 'b'],
    batchSize: 7,
    enabled: false,
    maximumBatchingWindow: 10,
    functionResponseType: 'ReportBatchItemFailures'
  };
  const defs = expandSqsEventDefinitions({}, event);
  defs.forEach(d => {
    t.is(d.batchSize, 7);
    t.is(d.enabled, false);
    t.is(d.maximumBatchingWindow, 10);
    t.is(d.functionResponseType, 'ReportBatchItemFailures');
  });
});

test('#262 expandSqsEventDefinitions does not mutate the input event or options', t => {
  const options = {queueName: ['x', 'y']};
  const event = {queueName: ['a', 'b'], batchSize: 5};
  const optionsBefore = {queueName: ['x', 'y']};
  const eventBefore = {queueName: ['a', 'b'], batchSize: 5};
  expandSqsEventDefinitions(options, event);
  t.deepEqual(options, optionsBefore);
  t.deepEqual(event, eventBefore);
});

test('#262 expandSqsEventDefinitions: string ARN event with no literal queueName stays a single listener (#74/#200 guard)', t => {
  // No literal queueName, no override => one def, name derived by the ARN path downstream.
  const defs = expandSqsEventDefinitions({}, 'arn:aws:sqs:eu-west-1:000000000000:Q');
  t.is(defs.length, 1);
  const built = new SQSEventDefinition(defs[0], 'eu-west-1', '000000000000');
  t.is(built.queueName, 'Q');
  t.is(built.arn, 'arn:aws:sqs:eu-west-1:000000000000:Q');
});

test('#262 expandSqsEventDefinitions: {arn} object event with no literal queueName stays a single listener', t => {
  const defs = expandSqsEventDefinitions(
    {},
    {arn: 'arn:aws:sqs:eu-west-1:000000000000:Q', batchSize: 2}
  );
  t.is(defs.length, 1);
  const built = new SQSEventDefinition(defs[0], 'eu-west-1', '000000000000');
  t.is(built.queueName, 'Q');
  t.is(built.batchSize, 2);
});

// ---------------------------------------------------------------------------
// buildHookMap / shouldListenForTermination — SQS+HTTP co-registration (#132)
// ---------------------------------------------------------------------------
//
// serverless-offline v13 owns the whole `offline:start` lifecycle: its hook map is
//   offline:start        -> #startWithExplicitEnd (start + ready + end, ready BLOCKS on a signal)
//   offline:start:init   -> start
//   offline:start:ready  -> ready
//   offline:start:end    -> end
// The documented contract (README "Usage with other plugins") is that augmenting plugins listen to
// `offline:start:init`/`offline:start:end` and the user runs `serverless offline start`.
//
// This plugin used to ALSO register the bare `offline:start` hook (`_startWithReady`). Both bare
// hooks then run on the same lifecycle event: if serverless-offline's runs first it blocks in
// `#ready()` and the SQS start never runs (HTTP up, SQS dead); if the SQS one runs first its
// `ready()` installs `process.exit(0)` SIGINT/SIGTERM handlers that tear the shared process down
// from under serverless-offline's HTTP server. Either way only one side wires up — exactly the
// #132 symptom ("only the SQS lambda works unless NODE_ENV=test or `offline start` is used").
//
// Fix: drop the bare `offline:start` hook so the plugin only AUGMENTS serverless-offline's
// lifecycle and never pre-empts it, and route `offline:start:end` through `stop` (cleanup without
// `process.exit`) so serverless-offline keeps ownership of the shared process/HTTP server.
// buildHookMap encodes that decision as pure data.

test('#132 buildHookMap never registers the bare `offline:start` hook (no pre-emption of serverless-offline)', t => {
  const map = buildHookMap();
  t.false('offline:start' in map);
});

test('#132 buildHookMap augments serverless-offline via init/ready/end only', t => {
  t.deepEqual(Object.keys(buildHookMap()).sort(), [
    'offline:start:end',
    'offline:start:init',
    'offline:start:ready'
  ]);
});

test('#132 buildHookMap maps each lifecycle event to the matching method name', t => {
  // `offline:start:end` maps to `stop` (cleanup without process.exit), not `end`, so the plugin
  // never owns the shutdown of serverless-offline's shared HTTP server / process.
  t.deepEqual(buildHookMap(), {
    'offline:start:init': 'start',
    'offline:start:ready': 'ready',
    'offline:start:end': 'stop'
  });
});

test('#132 buildHookMap is a stable, non-mutating pure value', t => {
  const a = buildHookMap();
  const b = buildHookMap();
  t.deepEqual(a, b);
  t.not(a, b); // a fresh object each call, safe to bind methods into
});

test('#132 every method named by buildHookMap exists on the plugin (declarative wiring is sound)', t => {
  // the constructor wires hooks as `this[methodName].bind(this)`; an unknown name would throw at
  // construction, so assert each mapped method is a real function on the prototype.
  const ServerlessOfflineSQS = require('../src');
  Object.values(buildHookMap()).forEach(methodName => {
    t.is(typeof ServerlessOfflineSQS.prototype[methodName], 'function', methodName);
  });
});

test('#132 shouldListenForTermination is false under NODE_ENV=test (keeps AVA/CI from trapping signals)', t => {
  t.false(shouldListenForTermination('test'));
});

test('#132 shouldListenForTermination is true for a normal offline run', t => {
  t.true(shouldListenForTermination('development'));
  t.true(shouldListenForTermination('production'));
  t.true(shouldListenForTermination(undefined));
  t.true(shouldListenForTermination(''));
});

// ---------------------------------------------------------------------------
// #132 source-level guards: the plugin must not own a competing bare-start path,
// and its signal handler must not force `process.exit` on the SHARED process
// (serverless-offline owns process exit; tearing it down kills the HTTP server).
// ---------------------------------------------------------------------------

test('#132 src/index.js no longer wires a bare `offline:start` hook', t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  // no hooks-object entry keyed on the bare lifecycle event (init/ready/end keys are `…start:xxx`)
  t.false(/['"]offline:start['"]\s*:/.test(source));
  // and the competing combined-start method definition is gone (prose mentions are fine)
  t.false(/\b_startWithReady\s*\(/.test(source));
});

test('#132 buildHookMap (the actual registered hooks) carries no bare `offline:start` key', t => {
  // belt-and-braces beyond the source scan: the live map must not contain the bare event.
  t.false(Object.prototype.hasOwnProperty.call(buildHookMap(), 'offline:start'));
});

test('#132 src/index.js signal handler calls end() with skipExit so the shared HTTP server survives', t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  // _listenForTermination must hand a truthy skipExit to end() — the SQS plugin cleans up its own
  // lambda/sqs but leaves process termination to serverless-offline, which owns the http server.
  t.regex(source, /this\.end\(\s*true\s*\)/);
});
