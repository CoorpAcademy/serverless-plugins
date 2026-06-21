const fs = require('fs');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const SQS = require('../src/sqs');
const {
  toDeleteEntries,
  resolveQueueName,
  toCreateQueueParams,
  resolveWaitTimeSeconds,
  coerceWaitTimeSeconds,
  partitionBatchForDeletion,
  collectQueueDefinitions,
  extractDlqTargetName,
  orderQueuesForCreation,
  normalizeQueueNames,
  expandSqsEventDefinitions,
  isNonExistentQueueError,
  enqueueLoop,
  queueNameCandidates,
  pollBackoffMs,
  getQueueUrlExhaustionWarning,
  GET_QUEUE_URL_MAX_ATTEMPTS,
  POLL_ERROR_BACKOFF_MS
} = require('../src/sqs');
const SQSEvent = require('../src/sqs-event');
const SQSEventDefinition = require('../src/sqs-event-definition');
const {defaultOptions, isPluginEnabled} = require('../src');
const {extractQueueNameFromARN, resolveCfnValue} = require('../src/sqs-event-definition');
const {
  buildClientConfig,
  buildCredentials,
  resolveRegion,
  ensureArray,
  DEFAULT_REGION
} = require('../src/client-config');

// ---------------------------------------------------------------------------
// buildClientConfig (#248/#252 aws-sdk v3 migration)
// ---------------------------------------------------------------------------

// EARS5: accessKeyId without secretAccessKey must NOT build a half-empty credentials object.
test('buildCredentials returns undefined when only accessKeyId is provided (EARS5)', t => {
  t.is(buildCredentials({accessKeyId: 'local'}), undefined);
});

test('buildCredentials returns undefined when only secretAccessKey is provided', t => {
  t.is(buildCredentials({secretAccessKey: 'local'}), undefined);
});

test('buildCredentials returns undefined when neither key is provided', t => {
  t.is(buildCredentials({}), undefined);
  t.is(buildCredentials(undefined), undefined);
});

test('buildCredentials returns a credentials object only when BOTH keys are present', t => {
  t.deepEqual(buildCredentials({accessKeyId: 'a', secretAccessKey: 's'}), {
    accessKeyId: 'a',
    secretAccessKey: 's'
  });
});

test('buildCredentials carries sessionToken through only when present', t => {
  t.deepEqual(buildCredentials({accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't'}), {
    accessKeyId: 'a',
    secretAccessKey: 's',
    sessionToken: 't'
  });
});

test('buildClientConfig omits credentials when only accessKeyId is set (EARS5)', t => {
  const config = buildClientConfig({accessKeyId: 'local', endpoint: 'http://localhost:9324'});
  t.false('credentials' in config);
  t.false('accessKeyId' in config);
});

test('buildClientConfig builds credentials when both keys are set', t => {
  const config = buildClientConfig({accessKeyId: 'a', secretAccessKey: 's', region: 'eu-west-1'});
  t.deepEqual(config.credentials, {accessKeyId: 'a', secretAccessKey: 's'});
  t.false('accessKeyId' in config);
  t.false('secretAccessKey' in config);
});

// EARS4: a custom endpoint without provider.region still works (default region supplied).
test('resolveRegion supplies a default region when endpoint is set and region absent (EARS4)', t => {
  t.is(resolveRegion({endpoint: 'http://localhost:9324'}), DEFAULT_REGION);
});

test('resolveRegion keeps the provided region untouched', t => {
  t.is(resolveRegion({endpoint: 'http://localhost:9324', region: 'eu-west-1'}), 'eu-west-1');
});

test('resolveRegion returns undefined with no endpoint and no region (default chain owns it)', t => {
  t.is(resolveRegion({}), undefined);
});

test('buildClientConfig injects a default region for an endpoint with no region (EARS4)', t => {
  const config = buildClientConfig({endpoint: 'http://localhost:9324'});
  t.is(config.region, DEFAULT_REGION);
  t.is(config.endpoint, 'http://localhost:9324');
});

test('buildClientConfig passes through unrelated options untouched', t => {
  const config = buildClientConfig({endpoint: 'http://x', region: 'eu-west-1', maxAttempts: 3});
  t.is(config.maxAttempts, 3);
});

test('buildClientConfig does not mutate its input', t => {
  const options = {accessKeyId: 'a', secretAccessKey: 's', region: 'eu-west-1'};
  const before = {...options};
  buildClientConfig(options);
  t.deepEqual(options, before);
});

// EARS3: an omitted response array must be treated as [] (no undefined.length crash).
test('ensureArray returns [] for undefined/null (EARS3)', t => {
  t.deepEqual(ensureArray(undefined), []);
  t.deepEqual(ensureArray(null), []);
});

test('ensureArray returns the array unchanged when present', t => {
  const records = [{a: 1}];
  t.is(ensureArray(records), records);
});

// The createQueue retry guard must match BOTH the v2 and v3 non-existent-queue error names.
test('isNonExistentQueueError matches the v3 QueueDoesNotExist name', t => {
  t.true(isNonExistentQueueError({name: 'QueueDoesNotExist'}));
});

test('isNonExistentQueueError still matches the legacy v2 name', t => {
  t.true(isNonExistentQueueError({name: 'AWS.SimpleQueueService.NonExistentQueue'}));
});

test('isNonExistentQueueError is false for an unrelated error', t => {
  t.false(isNonExistentQueueError({name: 'AccessDenied'}));
  t.false(isNonExistentQueueError(undefined));
});

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
// #255 (10Bude10, visrut-at-handldigital): an SQS event `arn` given as a bare
// {Ref: <QueueLogicalId>} pointing at an AWS::SQS::Queue resource must resolve to
// that queue's ARN so the lambda actually subscribes. Before the fix _resolveFn
// only handled Fn::GetAtt; a bare Ref fell through unresolved, the queue name
// became undefined, and GetQueueUrl({QueueName:'undefined'}) never matched.
// ---------------------------------------------------------------------------

const ResolvableServerlessOfflineSQS = require('../src');
const {resolveSqsRefArn} = require('../src');

test('#255 resolveSqsRefArn resolves a Ref to an AWS::SQS::Queue to its QueueName ARN', t => {
  const resources = {
    fetchIndustryDataQueue: {
      Type: 'AWS::SQS::Queue',
      Properties: {QueueName: 'fetchIndustryDataQueue'}
    }
  };
  t.is(
    resolveSqsRefArn(resources, 'fetchIndustryDataQueue', 'eu-central-1', '000000000000'),
    'arn:aws:sqs:eu-central-1:000000000000:fetchIndustryDataQueue'
  );
});

test('#255 resolveSqsRefArn falls back to the logical id when QueueName is absent', t => {
  const resources = {OrdersQueue: {Type: 'AWS::SQS::Queue', Properties: {}}};
  t.is(
    resolveSqsRefArn(resources, 'OrdersQueue', 'eu-west-1', '0'),
    'arn:aws:sqs:eu-west-1:0:OrdersQueue'
  );
});

test('#255 resolveSqsRefArn returns undefined for a Ref to a non-SQS / unknown resource', t => {
  const resources = {Bucket: {Type: 'AWS::S3::Bucket', Properties: {BucketName: 'b'}}};
  t.is(resolveSqsRefArn(resources, 'Bucket', 'eu-west-1', '0'), undefined);
  t.is(resolveSqsRefArn(resources, 'Missing', 'eu-west-1', '0'), undefined);
  t.is(resolveSqsRefArn(undefined, 'AWS::Region', 'eu-west-1', '0'), undefined);
});

test('#255 _resolveFn resolves a bare {Ref: QueueLogicalId} event arn to the queue ARN', t => {
  // Exact repro of the issue serverless.yml: event arn given as `Ref: fetchIndustryDataQueue`
  // with the queue declared under resources.Resources and autoCreate:false.
  const serverless = {
    service: {
      resources: {
        Resources: {
          fetchIndustryDataQueue: {
            Type: 'AWS::SQS::Queue',
            Properties: {QueueName: 'fetchIndustryDataQueue'}
          }
        }
      }
    }
  };
  const plugin = new ResolvableServerlessOfflineSQS(serverless, {}, {});
  plugin.options = {region: 'eu-central-1', accountId: '000000000000'};

  const resolved = plugin._resolveFn({arn: {Ref: 'fetchIndustryDataQueue'}});

  t.is(resolved.arn, 'arn:aws:sqs:eu-central-1:000000000000:fetchIndustryDataQueue');

  // and the downstream definition must derive the real queue name (not undefined)
  const sqsEvent = new SQSEventDefinition(resolved, 'eu-central-1', '000000000000');
  t.is(sqsEvent.queueName, 'fetchIndustryDataQueue');
});

test('#255 _resolveFn leaves a Ref to a non-SQS resource unresolved (no false ARN)', t => {
  const serverless = {
    service: {
      resources: {Resources: {SomeParam: {Type: 'AWS::SSM::Parameter', Properties: {}}}}
    }
  };
  const plugin = new ResolvableServerlessOfflineSQS(serverless, {}, {});
  plugin.options = {region: 'eu-west-1', accountId: '0'};

  const resolved = plugin._resolveFn({arn: {Ref: 'SomeParam'}});
  // unchanged pass-through: still the original intrinsic, NOT a fabricated SQS ARN
  t.deepEqual(resolved.arn, {Ref: 'SomeParam'});
});

test('#255 _resolveFn keeps the existing Fn::GetAtt and string-ARN behavior untouched', t => {
  const serverless = {
    service: {
      resources: {
        Resources: {MyQueue: {Type: 'AWS::SQS::Queue', Properties: {QueueName: 'MyQueue'}}}
      }
    }
  };
  const plugin = new ResolvableServerlessOfflineSQS(serverless, {}, {});
  plugin.options = {region: 'eu-west-1', accountId: '000000000000'};

  t.is(
    plugin._resolveFn({arn: {'Fn::GetAtt': ['MyQueue', 'Arn']}}).arn,
    'arn:aws:sqs:eu-west-1:000000000000:MyQueue'
  );
  t.is(
    plugin._resolveFn({arn: 'arn:aws:sqs:eu-west-1:000000000000:MyQueue'}).arn,
    'arn:aws:sqs:eu-west-1:000000000000:MyQueue'
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
// coerceWaitTimeSeconds + configurable options default (#123 sqs-waittime-config)
// ---------------------------------------------------------------------------

test('#123 coerceWaitTimeSeconds passes a numeric value through', t => {
  t.is(coerceWaitTimeSeconds(10), 10);
  t.is(coerceWaitTimeSeconds(0), 0);
});

test('#123 coerceWaitTimeSeconds coerces a numeric string via Number()', t => {
  // YAML/CLI may deliver the value as a string; mirror isPluginEnabled's string handling — do NOT
  // silently ignore a bare string.
  t.is(coerceWaitTimeSeconds('10'), 10);
  t.is(coerceWaitTimeSeconds('0'), 0);
});

test('#123 coerceWaitTimeSeconds clamps to the SQS long-poll range [0, 20]', t => {
  t.is(coerceWaitTimeSeconds(300), 20);
  t.is(coerceWaitTimeSeconds('300'), 20);
  t.is(coerceWaitTimeSeconds(-3), 0);
  t.is(coerceWaitTimeSeconds('-3'), 0);
});

test('#123 coerceWaitTimeSeconds falls back to 5 for non-numeric / nil input', t => {
  // a non-numeric string is NaN under Number() and must NOT be honored: fall back to the default 5.
  t.is(coerceWaitTimeSeconds('oops'), 5);
  t.is(coerceWaitTimeSeconds(undefined), 5);
  t.is(coerceWaitTimeSeconds(null), 5);
  t.is(coerceWaitTimeSeconds(''), 5);
});

test('#123 coerceWaitTimeSeconds honors an explicit override fallback', t => {
  t.is(coerceWaitTimeSeconds('oops', 7), 7);
  t.is(coerceWaitTimeSeconds(undefined, 7), 7);
});

test('#123 resolveWaitTimeSeconds uses the options default (numeric or string) when no per-event window', t => {
  t.is(resolveWaitTimeSeconds({}, 15), 15);
  t.is(resolveWaitTimeSeconds({}, '15'), 15);
  // clamps the options default too
  t.is(resolveWaitTimeSeconds({}, 300), 20);
  t.is(resolveWaitTimeSeconds({}, '300'), 20);
  // bad options default falls back to 5, never NaN
  t.is(resolveWaitTimeSeconds({}, 'oops'), 5);
});

test('#123 resolveWaitTimeSeconds: per-event maximumBatchingWindow still wins over the options default', t => {
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 8}, 15), 8);
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 8}, '15'), 8);
  // and is itself clamped
  t.is(resolveWaitTimeSeconds({maximumBatchingWindow: 300}, '15'), 20);
});

test('#123 defaultOptions.waitTimeSeconds defaults to 5 (NOT raised)', t => {
  t.is(defaultOptions.waitTimeSeconds, 5);
});

// ---------------------------------------------------------------------------
// #123 merge test: the configured waitTimeSeconds reaches the receiveMessage params.
// Instantiate the real SQS class with a mocked client + lambda and capture the long-poll
// WaitTimeSeconds passed to receiveMessage.
// ---------------------------------------------------------------------------

const captureReceiveMessage = async (options, rawDefinition) => {
  const captured = [];
  const sqs = new SQS(null, {}, {...options, region: 'eu-west-1', accountId: '0'}, undefined);

  // replace the real AWS client with a capturing mock; pause the poll queue after the first poll so
  // the recursive job does not loop forever. #248 (aws-sdk v3): the production client is driven via
  // `send(new XCommand(params))`, so dispatch on the command name and read params from `command.input`.
  sqs.client = {
    send: command => {
      const commandName = command.constructor.name;
      if (commandName === 'GetQueueUrlCommand')
        return Promise.resolve({QueueUrl: 'http://local/q'});
      if (commandName === 'ReceiveMessageCommand') {
        captured.push(command.input);
        sqs.queue.pause();
        return Promise.resolve({Messages: []});
      }
      return Promise.resolve({});
    }
  };

  const sqsEvent = new SQSEventDefinition(rawDefinition || {queueName: 'q'}, 'eu-west-1', '0');
  await sqs._sqsEvent('fn', sqsEvent);
  sqs.queue.start();
  // let the queued job drain
  await new Promise(resolve => {
    setTimeout(resolve, 50);
  });

  return captured;
};

test('#123 configured waitTimeSeconds reaches the receiveMessage WaitTimeSeconds param', async t => {
  const captured = await captureReceiveMessage({waitTimeSeconds: 15});
  t.true(captured.length > 0);
  t.is(captured[0].WaitTimeSeconds, 15);
});

test('#123 a string waitTimeSeconds option is coerced before reaching receiveMessage', async t => {
  const captured = await captureReceiveMessage({waitTimeSeconds: '12'});
  t.is(captured[0].WaitTimeSeconds, 12);
});

test('#123 receiveMessage WaitTimeSeconds defaults to 5 when no option is set', async t => {
  const captured = await captureReceiveMessage({});
  t.is(captured[0].WaitTimeSeconds, 5);
});

test('#123 per-event maximumBatchingWindow overrides the configured waitTimeSeconds at the receiveMessage call', async t => {
  const captured = await captureReceiveMessage(
    {waitTimeSeconds: 15},
    {queueName: 'q', maximumBatchingWindow: 8}
  );
  t.is(captured[0].WaitTimeSeconds, 8);
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
// #226 (newtechfellas): a transient SQS-client / ReceiveMessage failure in the poll loop must be
// caught + logged and the loop must re-schedule — it must NEVER surface as an unhandled promise
// rejection that terminates the `serverless offline` process. The receive call sat OUTSIDE the
// job()'s try/catch and `this.queue.add(job)` was a floating, never-`.catch()`ed promise, so a
// p-queue task rejection became an uncaught error.
// ---------------------------------------------------------------------------

// settle the microtask/timer queue a few times so the recursive poll loop runs several iterations
const drain = (ms = 60) =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

// drive the REAL SQS poll loop with a mock client whose ReceiveMessage behaves per `receive`.
// Captures every warning the loop logs and how many times ReceiveMessage was attempted, and
// installs a one-shot process-level `unhandledRejection` guard so the test can assert the loop
// never produces one.
const runPollLoopWithReceive = async (receive, {stopAfter = 3} = {}) => {
  const warnings = [];
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);

  const sqs = new SQS(
    null,
    {},
    {region: 'eu-west-1', accountId: '0'},
    {warning: msg => warnings.push(msg)}
  );

  let receiveCalls = 0;
  sqs.client = {
    send: command => {
      const commandName = command.constructor.name;
      if (commandName === 'GetQueueUrlCommand')
        return Promise.resolve({QueueUrl: 'http://local/q'});
      if (commandName === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        // stop the loop after a few iterations so the recursion does not spin forever
        if (receiveCalls >= stopAfter) sqs.queue.pause();
        return receive(receiveCalls);
      }
      return Promise.resolve({});
    }
  };
  // B1: neutralize the inter-poll error back-off seam so the transient-recovery assertions below run
  // without real ~1s sleeps. The back-off DURATION is asserted separately via the pure pollBackoffMs.
  sqs._pollErrorBackoff = () => Promise.resolve();

  const sqsEvent = new SQSEventDefinition({queueName: 'q'}, 'eu-west-1', '0');
  await sqs._sqsEvent('fn', sqsEvent);
  sqs.queue.start();
  await drain();
  sqs.queue.pause();
  // let any stray rejection settle before we read the guard
  await drain(10);
  process.removeListener('unhandledRejection', onUnhandled);

  return {warnings, unhandled, receiveCalls};
};

// EARS-A: while polling, when ReceiveMessage rejects with a transient error, the loop shall NOT
// produce an unhandled promise rejection (the process-killing failure mode from #226).
test('#226 a rejecting ReceiveMessage in the poll loop does not produce an unhandled rejection', async t => {
  const {unhandled} = await runPollLoopWithReceive(() =>
    Promise.reject(Object.assign(new Error('socket hang up'), {name: 'TimeoutError'}))
  );
  t.deepEqual(unhandled, []);
});

// EARS-B: while polling, when ReceiveMessage rejects, the loop shall log the error via log.warning
// and re-schedule (re-poll) rather than stopping.
test('#226 a rejecting ReceiveMessage is logged via log.warning and the loop re-polls', async t => {
  const {warnings, receiveCalls} = await runPollLoopWithReceive(() =>
    Promise.reject(Object.assign(new Error('socket hang up'), {name: 'TimeoutError'}))
  );
  t.true(warnings.length > 0, 'the transient receive failure is logged via log.warning');
  t.true(receiveCalls > 1, 'the loop re-schedules and polls again after the failure');
});

// EARS-C: a one-off transient failure must not be terminal — once ReceiveMessage recovers the loop
// resumes normal delivery. The happy path is unchanged.
test('#226 the poll loop recovers after a transient ReceiveMessage failure', async t => {
  const {unhandled, receiveCalls} = await runPollLoopWithReceive(call =>
    call === 1
      ? Promise.reject(Object.assign(new Error('socket hang up'), {name: 'TimeoutError'}))
      : Promise.resolve({Messages: []})
  );
  t.deepEqual(unhandled, [], 'no unhandled rejection');
  t.true(receiveCalls >= 2, 'the loop keeps polling after the one-off failure');
});

// ---------------------------------------------------------------------------
// enqueueLoop pure helper (#226) — unit-level: it must add the task to the queue and guard the
// returned promise so a rejecting task is routed to log.warning instead of going unhandled.
// ---------------------------------------------------------------------------

test('#226 enqueueLoop adds the task to the queue', t => {
  const added = [];
  const queue = {
    add: task => {
      added.push(task);
      return Promise.resolve();
    }
  };
  const task = () => {};
  enqueueLoop(queue, task, normalizeLog({warning: () => {}}));
  t.deepEqual(added, [task]);
});

test('#226 enqueueLoop swallows a rejecting task and logs it via log.warning', async t => {
  const warnings = [];
  const queue = {
    add: () => Promise.reject(Object.assign(new Error('boom'), {stack: 'STACK-boom'}))
  };
  await enqueueLoop(queue, () => {}, normalizeLog({warning: msg => warnings.push(msg)}));
  t.deepEqual(warnings, ['STACK-boom']);
});

test('#226 enqueueLoop tolerates a non-Error rejection without throwing', async t => {
  const warnings = [];
  // eslint-disable-next-line prefer-promise-reject-errors -- deliberately a non-Error rejection
  const queue = {add: () => Promise.reject('plain-string-error')};
  await t.notThrowsAsync(
    enqueueLoop(queue, () => {}, normalizeLog({warning: msg => warnings.push(msg)}))
  );
  t.deepEqual(warnings, ['plain-string-error']);
});

test('#226 enqueueLoop leaves a resolving task untouched (no warning)', async t => {
  const warnings = [];
  const queue = {add: () => Promise.resolve('ok')};
  await enqueueLoop(queue, () => {}, normalizeLog({warning: msg => warnings.push(msg)}));
  t.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------
// queueNameCandidates / GetQueueUrl .fifo-suffix fallback (#189 nicolaspfernandes)
// ---------------------------------------------------------------------------

test('#189 queueNameCandidates drops the .fifo suffix as the second candidate', t => {
  t.deepEqual(queueNameCandidates('QueueName.fifo'), ['QueueName.fifo', 'QueueName']);
});

test('#189 queueNameCandidates adds a .fifo suffix as the second candidate', t => {
  t.deepEqual(queueNameCandidates('QueueName'), ['QueueName', 'QueueName.fifo']);
});

test('#189 queueNameCandidates keeps the original name first (it always wins when present)', t => {
  t.is(queueNameCandidates('QueueName.fifo')[0], 'QueueName.fifo');
  t.is(queueNameCandidates('Orders')[0], 'Orders');
});

test('#189 queueNameCandidates de-duplicates and tolerates empty/nil input', t => {
  t.deepEqual(queueNameCandidates(''), []);
  t.deepEqual(queueNameCandidates(undefined), []);
  t.deepEqual(queueNameCandidates(null), []);
  // a bare '.fifo' toggles to '' which is dropped -> single candidate
  t.deepEqual(queueNameCandidates('.fifo'), ['.fifo']);
});

// A minimal ElasticMQ-like client mock: it only knows the queue names in `known`, and rejects any
// other QueueName with the v3 `QueueDoesNotExist` error — exactly the missing-param/no-such-queue
// failure #189 hits when the event ARN carries a `.fifo` suffix the emulator's id does not.
const mkSqsWithKnownQueues = known => {
  const sqs = new SQS(null, {}, {region: 'eu-west-1', accountId: '0'}, undefined);
  const seen = [];
  sqs.client = {
    send: command => {
      const commandName = command.constructor.name;
      if (commandName === 'GetQueueUrlCommand') {
        const {QueueName} = command.input;
        seen.push(QueueName);
        if (known.includes(QueueName))
          return Promise.resolve({QueueUrl: `http://local/${QueueName}`});
        const err = new Error(`The specified queue does not exist: ${QueueName}`);
        err.name = 'QueueDoesNotExist';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    }
  };
  return {sqs, seen};
};

test('#189 _getQueueUrl resolves a .fifo event name against a bare ElasticMQ queue id', async t => {
  // The event ARN resolves to `QueueName.fifo`, but ElasticMQ's configured id is literally
  // `QueueName` (it does NOT append `.fifo`). Without the fallback, GetQueueUrl({QueueName:
  // 'QueueName.fifo'}) is rejected forever; with it, the bare-name candidate resolves the URL.
  const {sqs, seen} = mkSqsWithKnownQueues(['QueueName']);
  const {QueueUrl} = await sqs._getQueueUrl('QueueName.fifo');
  t.is(QueueUrl, 'http://local/QueueName');
  t.deepEqual(seen, ['QueueName.fifo', 'QueueName']);
});

test('#189 _getQueueUrl resolves a bare event name against a .fifo ElasticMQ queue id', async t => {
  // The mirror case: the event omits `.fifo` but the emulator id carries it.
  const {sqs, seen} = mkSqsWithKnownQueues(['QueueName.fifo']);
  const {QueueUrl} = await sqs._getQueueUrl('QueueName');
  t.is(QueueUrl, 'http://local/QueueName.fifo');
  t.deepEqual(seen, ['QueueName', 'QueueName.fifo']);
});

test('#189 _getQueueUrl returns the URL on the first candidate without trying the variant', async t => {
  const {sqs, seen} = mkSqsWithKnownQueues(['QueueName.fifo']);
  const {QueueUrl} = await sqs._getQueueUrl('QueueName.fifo');
  t.is(QueueUrl, 'http://local/QueueName.fifo');
  t.deepEqual(seen, ['QueueName.fifo']);
});

// ---------------------------------------------------------------------------
// B1 resilience-polish: _getQueueUrl bounded retry + surfaced warning.
// After #292's candidate probing, a genuinely-absent queue still hit
// `await delay(10000); return this._getQueueUrl(queueName)` — an INFINITE, SILENT 10s loop:
// a permanent misconfiguration was indistinguishable from a transient one and never logged.
// Bound the retries and emit a throttled warning naming the queue + the probed candidate forms.
// ---------------------------------------------------------------------------

test('B1 GET_QUEUE_URL_MAX_ATTEMPTS is a finite positive bound', t => {
  t.true(Number.isInteger(GET_QUEUE_URL_MAX_ATTEMPTS));
  t.true(GET_QUEUE_URL_MAX_ATTEMPTS >= 1);
  t.true(Number.isFinite(GET_QUEUE_URL_MAX_ATTEMPTS));
});

test('B1 getQueueUrlExhaustionWarning names the queue, both probed candidates, and the attempt', t => {
  const message = getQueueUrlExhaustionWarning('Orders.fifo', ['Orders.fifo', 'Orders'], 6);
  t.regex(message, /Orders\.fifo/);
  t.regex(message, /Orders\b/);
  t.regex(message, /6/);
});

test('B1 getQueueUrlExhaustionWarning tolerates an empty/nil candidate list', t => {
  t.notThrows(() => getQueueUrlExhaustionWarning('Orders', [], 1));
  t.regex(getQueueUrlExhaustionWarning('Orders', undefined, 1), /Orders/);
});

// tiny local helper: run `fn` and return its rejection (or undefined if it resolves), so the
// harness below stays a plain async function and we can assert on the thrown error.
const captureRejection = async fn => {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
};

// Drive the REAL _getQueueUrl against an always-missing queue with the wait stubbed out (no real
// 10s sleeps) and assert it (a) gives up after a BOUNDED number of attempts with a clear error
// naming the queue, and (b) emits at least one warning instead of looping silently forever.
const runMissingQueueUrl = async (queueName, options = {}) => {
  const warnings = [];
  const sqs = new SQS(
    null,
    {},
    {...options, region: 'eu-west-1', accountId: '0'},
    {warning: msg => warnings.push(msg)}
  );

  let getCalls = 0;
  sqs.client = {
    send: command => {
      if (command.constructor.name === 'GetQueueUrlCommand') {
        getCalls += 1;
        const err = new Error(`The specified queue does not exist: ${command.input.QueueName}`);
        err.name = 'QueueDoesNotExist';
        return Promise.reject(err);
      }
      return Promise.resolve({});
    }
  };
  // neutralize the inter-round back-off so the bounded loop runs without real timers
  sqs._getQueueUrlDelay = () => Promise.resolve();

  const error = await captureRejection(() => sqs._getQueueUrl(queueName));
  return {error, warnings, getCalls};
};

test('B1 _getQueueUrl gives up after a bounded number of attempts with a clear error naming the queue', async t => {
  const {error, getCalls} = await runMissingQueueUrl('GhostQueue', {getQueueUrlMaxAttempts: 4});
  t.truthy(error, 'a missing queue must eventually throw, not loop forever');
  t.regex(error.message, /GhostQueue/, 'the error names the queue');
  // 4 attempts x 2 candidates (GhostQueue, GhostQueue.fifo) = 8 GetQueueUrl probes, bounded.
  t.true(getCalls <= 4 * 2 + 2, 'the retry budget is bounded, not infinite');
});

test('B1 _getQueueUrl emits a warning naming the queue instead of a silent wait-loop', async t => {
  const {warnings} = await runMissingQueueUrl('GhostQueue', {getQueueUrlMaxAttempts: 6});
  t.true(warnings.length > 0, 'the persistent miss is surfaced via log.warning');
  t.true(
    warnings.some(w => /GhostQueue/.test(w)),
    'at least one warning names the missing queue'
  );
});

// ---------------------------------------------------------------------------
// B1 resilience-polish: poll-job inter-poll back-off. On a thrown receive/handler the job was
// caught + logged then re-enqueued IMMEDIATELY -> a tight busy-loop against a down emulator.
// pollBackoffMs is a pure decision: a small constant delay on failure, ZERO on success (so the
// happy-path cadence is unchanged).
// ---------------------------------------------------------------------------

test('B1 POLL_ERROR_BACKOFF_MS is a small positive constant', t => {
  t.true(Number.isInteger(POLL_ERROR_BACKOFF_MS));
  t.true(POLL_ERROR_BACKOFF_MS > 0);
  t.true(POLL_ERROR_BACKOFF_MS <= 5000);
});

test('B1 pollBackoffMs returns the back-off only on failure, zero on success', t => {
  t.is(pollBackoffMs(true), POLL_ERROR_BACKOFF_MS);
  t.is(pollBackoffMs(false), 0);
});

test('B1 pollBackoffMs never delays the success path (cadence unchanged)', t => {
  // a successful poll must re-enqueue immediately — the spec forbids touching the happy-path cadence
  t.is(pollBackoffMs(false), 0);
});

// Behavioral: the poll loop must invoke the back-off seam BEFORE re-enqueueing when a poll throws,
// and must NOT invoke it on a clean (empty) poll. Drives the REAL job loop with a stubbed client +
// a spy on the _pollErrorBackoff seam so no real ~1s sleep is incurred.
const runPollLoopBackoffSpy = async receive => {
  let backoffCalls = 0;
  const sqs = new SQS(null, {}, {region: 'eu-west-1', accountId: '0'}, {warning: () => {}});

  let receiveCalls = 0;
  sqs.client = {
    send: command => {
      const commandName = command.constructor.name;
      if (commandName === 'GetQueueUrlCommand')
        return Promise.resolve({QueueUrl: 'http://local/q'});
      if (commandName === 'ReceiveMessageCommand') {
        receiveCalls += 1;
        if (receiveCalls >= 2) sqs.queue.pause();
        return receive(receiveCalls);
      }
      return Promise.resolve({});
    }
  };
  sqs._pollErrorBackoff = () => {
    backoffCalls += 1;
    return Promise.resolve();
  };

  await sqs._sqsEvent('fn', new SQSEventDefinition({queueName: 'q'}, 'eu-west-1', '0'));
  sqs.queue.start();
  await drain();
  sqs.queue.pause();
  await drain(10);
  return {backoffCalls};
};

test('B1 the poll loop applies the back-off seam before re-enqueue when a poll throws', async t => {
  const {backoffCalls} = await runPollLoopBackoffSpy(() =>
    Promise.reject(Object.assign(new Error('emulator down'), {name: 'TimeoutError'}))
  );
  t.true(backoffCalls > 0, 'a failed poll backs off before re-enqueueing');
});

test('B1 the poll loop does NOT back off on a clean (empty) poll — happy-path cadence unchanged', async t => {
  const {backoffCalls} = await runPollLoopBackoffSpy(() => Promise.resolve({Messages: []}));
  t.is(backoffCalls, 0, 'a successful poll re-enqueues immediately, no back-off');
});

// ---------------------------------------------------------------------------
// B1 #289 regression guards — pin the CloudFormation-intrinsic redrive behavior that the #289
// adversarial review left uncovered. These assert EXISTING behavior (no source change); they are
// named guards so a future refactor that re-breaks #289 fails loudly.
// ---------------------------------------------------------------------------

test('B1 #289 toCreateQueueParams for a Ref/GetAtt-named .fifo queue emits QueueName top-level only, never in Attributes', t => {
  // The #289 caseFn::GetAtt redrive yields a queue created with no explicit QueueName property; the
  // params must still carry QueueName at the TOP level (so createQueue names the queue) and NEVER
  // inside Attributes (sqslite/AWS reject `InvalidAttributeName: Unknown Attribute QueueName`).
  const params = toCreateQueueParams('Orders.fifo', {
    FifoQueue: true,
    RedrivePolicy: {
      deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:Orders-dlq.fifo',
      maxReceiveCount: 5
    }
  });
  t.is(params.QueueName, 'Orders.fifo', 'QueueName is set at the top level');
  t.false('QueueName' in params.Attributes, 'QueueName must NOT leak into Attributes');
  // .fifo is inferred even without an explicit QueueName property in the resource
  t.is(params.Attributes.FifoQueue, 'true');
});

test('B1 #289 orderQueuesForCreation emits the DLQ before its referencing queue for a resolved-ARN RedrivePolicy', t => {
  // Post index._resolveFn, a Ref/GetAtt deadLetterTargetArn is a resolved ARN string. The DLQ must
  // be created first or createQueue rejects with NonExistentQueue (the #289 ordering caveat).
  const defs = [
    {
      queueName: 'Orders',
      properties: {
        QueueName: 'Orders',
        RedrivePolicy: {
          deadLetterTargetArn: 'arn:aws:sqs:eu-west-1:000000000000:OrdersDlq',
          maxReceiveCount: 5
        }
      }
    },
    {queueName: 'OrdersDlq', properties: {QueueName: 'OrdersDlq'}}
  ];
  const ordered = orderQueuesForCreation(defs, 'eu-west-1', '000000000000').map(d => d.queueName);
  t.true(ordered.indexOf('OrdersDlq') < ordered.indexOf('Orders'), 'DLQ is created first');
  t.deepEqual([...ordered].sort(), ['Orders', 'OrdersDlq'], 'no queue is dropped or duplicated');
});
