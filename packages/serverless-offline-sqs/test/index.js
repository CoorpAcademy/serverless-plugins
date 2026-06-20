const fs = require('fs');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {toDeleteEntries, resolveQueueName, toCreateQueueParams} = require('../src/sqs');
const SQSEvent = require('../src/sqs-event');
const SQSEventDefinition = require('../src/sqs-event-definition');
const {defaultOptions, isPluginEnabled} = require('../src');
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
