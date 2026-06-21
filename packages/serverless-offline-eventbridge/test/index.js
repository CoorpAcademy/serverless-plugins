const fs = require('fs');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {
  matchesPattern,
  matchesFilter,
  subscriptionsFromResources,
  resolveEventBusName,
  entryToEvent,
  putEventsResponse
} = require('../src/eventbridge');
const EventBridgeEvent = require('../src/eventbridge-event');
const EventBridgeEventDefinition = require('../src/eventbridge-event-definition');
const {
  pseudoParams,
  resolveDestinationArn,
  queueNameFromArn,
  buildFailurePayload,
  buildSuccessPayload,
  dispatchDestination,
  runDestinations
} = require('../src/destinations');
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
  t.is(buildClientConfig({endpoint: 'http://localhost:9324'}).region, DEFAULT_REGION);
});

test('resolveRegion keeps the provided region untouched', t => {
  t.is(resolveRegion({endpoint: 'http://x', region: 'eu-west-1'}), 'eu-west-1');
});

// EARS3: an omitted response array must be treated as [] (no undefined.length crash).
test('ensureArray returns [] for undefined/null (EARS3)', t => {
  t.deepEqual(ensureArray(undefined), []);
  t.deepEqual(ensureArray(null), []);
});

// ---------------------------------------------------------------------------
// Group A — normalizeLog (SQS-identical)
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

// ---------------------------------------------------------------------------
// Group B — EventBridgeEventDefinition
// ---------------------------------------------------------------------------

test('EventBridgeEventDefinition defaults enabled to true', t => {
  const def = new EventBridgeEventDefinition({eventBus: 'my-bus'}, 'eu-west-1', '000000000000');
  t.is(def.enabled, true);
});

test('EventBridgeEventDefinition builds the event-bus ARN', t => {
  const def = new EventBridgeEventDefinition({eventBus: 'my-bus'}, 'eu-west-1', '000000000000');
  t.is(def.arn, 'arn:aws:events:eu-west-1:000000000000:event-bus/my-bus');
});

test('EventBridgeEventDefinition defaults eventBus to "default"', t => {
  const def = new EventBridgeEventDefinition({pattern: {source: ['x']}}, 'eu-west-1', '0');
  t.is(def.eventBus, 'default');
  t.is(def.arn, 'arn:aws:events:eu-west-1:0:event-bus/default');
});

test('EventBridgeEventDefinition prefers `pattern`, then `eventPattern`', t => {
  const withPattern = new EventBridgeEventDefinition(
    {pattern: {source: ['a']}, eventPattern: {source: ['b']}},
    'eu-west-1',
    '0'
  );
  t.deepEqual(withPattern.eventPattern, {source: ['a']});

  const withEventPattern = new EventBridgeEventDefinition(
    {eventPattern: {source: ['b']}},
    'eu-west-1',
    '0'
  );
  t.deepEqual(withEventPattern.eventPattern, {source: ['b']});
});

test('EventBridgeEventDefinition merges raw keys without clobbering computed fields', t => {
  const def = new EventBridgeEventDefinition(
    {eventBus: 'my-bus', pattern: {source: ['a']}, custom: 'kept'},
    'eu-west-1',
    '0'
  );
  t.is(def.custom, 'kept');
  t.is(def.eventBus, 'my-bus');
  t.deepEqual(def.eventPattern, {source: ['a']});
});

test('EventBridgeEventDefinition accepts a bare bus-name string without char-indexing it', t => {
  const def = new EventBridgeEventDefinition('my-bus', 'eu-west-1', '0');
  t.is(def.eventBus, 'my-bus');
  t.is(def.eventPattern, undefined);
  t.is(def['0'], undefined);
});

// ---------------------------------------------------------------------------
// Group C — EventBridgeEvent mapper
// ---------------------------------------------------------------------------

test('EventBridgeEvent JSON-parses a stringified Detail', t => {
  const event = new EventBridgeEvent(
    {Source: 'aws.transcribe', DetailType: 'X', Detail: '{"a":1}'},
    'eu-west-1'
  );
  t.deepEqual(event.detail, {a: 1});
});

test('EventBridgeEvent sets region from the argument (awsRegion-style regression guard)', t => {
  const event = new EventBridgeEvent({Source: 's', DetailType: 'X', Detail: '{}'}, 'eu-west-1');
  t.is(event.region, 'eu-west-1');
  t.not(event.region, undefined);
});

test('EventBridgeEvent maps source/detail-type from PascalCase input', t => {
  const event = new EventBridgeEvent(
    {Source: 'aws.transcribe', DetailType: 'Transcribe Job State Change', Detail: '{}'},
    'eu-west-1'
  );
  t.is(event.source, 'aws.transcribe');
  t.is(event['detail-type'], 'Transcribe Job State Change');
});

test('EventBridgeEvent maps source/detail-type from lowercase input', t => {
  const event = new EventBridgeEvent(
    {source: 'aws.transcribe', 'detail-type': 'Transcribe Job State Change', detail: {}},
    'eu-west-1'
  );
  t.is(event.source, 'aws.transcribe');
  t.is(event['detail-type'], 'Transcribe Job State Change');
});

test('EventBridgeEvent auto-generates an id when absent', t => {
  const event = new EventBridgeEvent({Source: 's', DetailType: 'X', Detail: '{}'}, 'eu-west-1');
  t.is(typeof event.id, 'string');
  t.true(event.id.length > 0);
});

test('EventBridgeEvent defaults resources to [busArn]', t => {
  const event = new EventBridgeEvent(
    {Source: 's', DetailType: 'X', Detail: '{}'},
    'eu-west-1',
    'arn:aws:events:eu-west-1:0:event-bus/default'
  );
  t.deepEqual(event.resources, ['arn:aws:events:eu-west-1:0:event-bus/default']);
});

test('EventBridgeEvent defaults detail to {} when absent', t => {
  const event = new EventBridgeEvent({Source: 's', DetailType: 'X'}, 'eu-west-1');
  t.deepEqual(event.detail, {});
});

// ---------------------------------------------------------------------------
// Group D — matchesPattern (core IP)
// ---------------------------------------------------------------------------

test('matchesPattern matches on source array', t => {
  t.true(matchesPattern({source: ['aws.transcribe']}, {source: 'aws.transcribe'}));
});

test('matchesPattern rejects a non-matching source', t => {
  t.false(matchesPattern({source: ['aws.transcribe']}, {source: 'aws.s3'}));
});

test('matchesPattern matches on detail-type', t => {
  t.true(
    matchesPattern(
      {'detail-type': ['Transcribe Job State Change']},
      {'detail-type': 'Transcribe Job State Change'}
    )
  );
});

test('matchesPattern matches nested detail exact value and prefix', t => {
  t.true(
    matchesPattern(
      {detail: {Status: ['COMPLETED'], Name: [{prefix: 'tls_'}]}},
      {detail: {Status: 'COMPLETED', Name: 'tls_abc'}}
    )
  );
});

// --- The exact TLS rule ----------------------------------------------------

const TLS_RULE = {
  source: ['aws.transcribe'],
  'detail-type': ['Transcribe Job State Change'],
  detail: {
    TranscriptionJobStatus: ['COMPLETED', 'FAILED'],
    TranscriptionJobName: [{prefix: 'tls_'}]
  }
};

const tlsEvent = (status, name = 'tls_job_task_123') => ({
  source: 'aws.transcribe',
  'detail-type': 'Transcribe Job State Change',
  detail: {TranscriptionJobStatus: status, TranscriptionJobName: name}
});

test('TLS rule matches a COMPLETED event', t => {
  t.true(matchesPattern(TLS_RULE, tlsEvent('COMPLETED')));
});

test('TLS rule matches a FAILED event', t => {
  t.true(matchesPattern(TLS_RULE, tlsEvent('FAILED')));
});

test('TLS rule rejects a wrong source', t => {
  t.false(matchesPattern(TLS_RULE, {...tlsEvent('COMPLETED'), source: 'aws.s3'}));
});

test('TLS rule rejects a wrong detail-type', t => {
  t.false(matchesPattern(TLS_RULE, {...tlsEvent('COMPLETED'), 'detail-type': 'Other'}));
});

test('TLS rule rejects an unknown status', t => {
  t.false(matchesPattern(TLS_RULE, tlsEvent('IN_PROGRESS')));
});

test('TLS rule rejects a job name without the tls_ prefix', t => {
  t.false(matchesPattern(TLS_RULE, tlsEvent('COMPLETED', 'job_without_prefix')));
});

// --- Filter coverage -------------------------------------------------------

test('matchesFilter: prefix', t => {
  t.true(matchesFilter({prefix: 'tls_'}, 'tls_abc'));
  t.false(matchesFilter({prefix: 'tls_'}, 'abc'));
});

test('matchesFilter: suffix', t => {
  t.true(matchesFilter({suffix: '.srt'}, 'caption.srt'));
  t.false(matchesFilter({suffix: '.srt'}, 'caption.vtt'));
});

test('matchesFilter: anything-but scalar and set', t => {
  t.true(matchesFilter({'anything-but': 'COMPLETED'}, 'FAILED'));
  t.false(matchesFilter({'anything-but': 'COMPLETED'}, 'COMPLETED'));
  t.false(matchesFilter({'anything-but': ['A', 'B']}, 'A'));
  t.true(matchesFilter({'anything-but': ['A', 'B']}, 'C'));
});

test('matchesPattern: exists true/false', t => {
  t.true(matchesPattern({detail: {x: [{exists: true}]}}, {detail: {x: 1}}));
  t.false(matchesPattern({detail: {x: [{exists: true}]}}, {detail: {}}));
  t.true(matchesPattern({detail: {x: [{exists: false}]}}, {detail: {}}));
  t.false(matchesPattern({detail: {x: [{exists: false}]}}, {detail: {x: 1}}));
});

test('matchesFilter: equals-ignore-case', t => {
  t.true(matchesFilter({'equals-ignore-case': 'completed'}, 'COMPLETED'));
  t.false(matchesFilter({'equals-ignore-case': 'completed'}, 'failed'));
});

test('matchesFilter: numeric multi-clause', t => {
  t.true(matchesFilter({numeric: ['>', 0, '<=', 100]}, 50));
  t.false(matchesFilter({numeric: ['>', 0, '<=', 100]}, 0));
  t.false(matchesFilter({numeric: ['>', 0, '<=', 100]}, 101));
  t.true(matchesFilter({numeric: ['=', 42]}, 42));
});

test('matchesFilter: wildcard', t => {
  t.true(matchesFilter({wildcard: 'tls_*_123'}, 'tls_job_123'));
  t.false(matchesFilter({wildcard: 'tls_*_123'}, 'tls_job_999'));
});

test('matchesFilter: cidr', t => {
  t.true(matchesFilter({cidr: '10.0.0.0/24'}, '10.0.0.42'));
  t.false(matchesFilter({cidr: '10.0.0.0/24'}, '10.0.1.42'));
  // /32 host route (exact match) and /0 (match anything) — guards the masked-compare precedence.
  t.true(matchesFilter({cidr: '192.168.1.5/32'}, '192.168.1.5'));
  t.false(matchesFilter({cidr: '192.168.1.5/32'}, '192.168.1.6'));
  t.true(matchesFilter({cidr: '0.0.0.0/0'}, '8.8.8.8'));
  t.false(matchesFilter({cidr: '10.0.0.0/24'}, 'not-an-ip'));
});

test('matchesFilter: nested prefix with equals-ignore-case', t => {
  t.true(matchesFilter({prefix: {'equals-ignore-case': 'TLS_'}}, 'tls_job'));
  t.false(matchesFilter({prefix: {'equals-ignore-case': 'TLS_'}}, 'job'));
});

test('matchesPattern: $or at the top level', t => {
  const pattern = {$or: [{source: ['a']}, {source: ['b']}]};
  t.true(matchesPattern(pattern, {source: 'a'}));
  t.true(matchesPattern(pattern, {source: 'b'}));
  t.false(matchesPattern(pattern, {source: 'c'}));
});

test('matchesPattern: $or within detail', t => {
  const pattern = {detail: {$or: [{a: ['1']}, {b: ['2']}]}};
  t.true(matchesPattern(pattern, {detail: {a: '1'}}));
  t.true(matchesPattern(pattern, {detail: {b: '2'}}));
  t.false(matchesPattern(pattern, {detail: {c: '3'}}));
});

test('matchesPattern: resources field is array-aware', t => {
  t.true(
    matchesPattern(
      {resources: [{prefix: 'arn:aws:ec2'}]},
      {resources: ['arn:aws:s3:::b', 'arn:aws:ec2:eu-west-1:0:instance/i-1']}
    )
  );
  t.false(matchesPattern({resources: [{prefix: 'arn:aws:ec2'}]}, {resources: ['arn:aws:s3:::b']}));
});

test('matchesPattern: unknown filter returns false and does not throw', t => {
  t.notThrows(() => matchesPattern({detail: {x: [{bananas: 1}]}}, {detail: {x: 'y'}}));
  t.false(matchesPattern({detail: {x: [{bananas: 1}]}}, {detail: {x: 'y'}}));
});

test('matchesPattern does not mutate pattern or event', t => {
  const pattern = JSON.parse(JSON.stringify(TLS_RULE));
  const event = tlsEvent('COMPLETED');
  const patternBefore = JSON.parse(JSON.stringify(pattern));
  const eventBefore = JSON.parse(JSON.stringify(event));
  matchesPattern(pattern, event);
  t.deepEqual(pattern, patternBefore);
  t.deepEqual(event, eventBefore);
});

// ---------------------------------------------------------------------------
// Group E — PutEvents shaping
// ---------------------------------------------------------------------------

test('entryToEvent maps a PutEvents Entry (stringified Detail) to the envelope', t => {
  const event = entryToEvent(
    {
      Source: 'aws.transcribe',
      DetailType: 'Transcribe Job State Change',
      Detail: '{"TranscriptionJobStatus":"COMPLETED"}'
    },
    'eu-west-1'
  );
  t.is(event.source, 'aws.transcribe');
  t.is(event['detail-type'], 'Transcribe Job State Change');
  t.deepEqual(event.detail, {TranscriptionJobStatus: 'COMPLETED'});
  t.is(event.region, 'eu-west-1');
});

test('putEventsResponse returns one EventId per entry and FailedEntryCount 0', t => {
  const response = putEventsResponse([{}, {}, {}]);
  t.is(response.Entries.length, 3);
  t.true(response.Entries.every(({EventId}) => typeof EventId === 'string'));
  t.is(response.FailedEntryCount, 0);
});

test('putEventsResponse tolerates undefined input', t => {
  t.deepEqual(putEventsResponse(), {Entries: [], FailedEntryCount: 0});
});

// ---------------------------------------------------------------------------
// Group F — CFN rule discovery
// ---------------------------------------------------------------------------

const TLS_RESOURCES = {
  Resources: {
    TranscribeJobStateChangeRule: {
      Type: 'AWS::Events::Rule',
      Properties: {
        EventBusName: 'default',
        EventPattern: TLS_RULE,
        Targets: [{Arn: {'Fn::GetAtt': ['TranscribeCompleteLambdaFunction', 'Arn']}, Id: 't'}]
      }
    },
    SomeBucket: {Type: 'AWS::S3::Bucket', Properties: {}}
  }
};

test('subscriptionsFromResources finds a Rule and maps the logical id to the function key', t => {
  const subs = subscriptionsFromResources(TLS_RESOURCES, {
    TranscribeCompleteLambdaFunction: 'transcribeComplete'
  });
  t.is(subs.length, 1);
  t.is(subs[0].functionKey, 'transcribeComplete');
  t.deepEqual(subs[0].eventPattern, TLS_RULE);
  t.is(subs[0].eventBus, 'default');
});

test('subscriptionsFromResources falls back to the logical id when unmapped', t => {
  const subs = subscriptionsFromResources(TLS_RESOURCES);
  t.is(subs[0].functionKey, 'TranscribeCompleteLambdaFunction');
});

test('subscriptionsFromResources ignores non-Rule resources', t => {
  const subs = subscriptionsFromResources({
    Resources: {SomeBucket: {Type: 'AWS::S3::Bucket', Properties: {}}}
  });
  t.deepEqual(subs, []);
});

test('subscriptionsFromResources ignores rules with no lambda Fn::GetAtt target', t => {
  const subs = subscriptionsFromResources({
    Resources: {
      R: {
        Type: 'AWS::Events::Rule',
        Properties: {Targets: [{Arn: 'arn:aws:sqs:eu-west-1:0:Q', Id: 't'}]}
      }
    }
  });
  t.deepEqual(subs, []);
});

test('subscriptionsFromResources handles empty/undefined input', t => {
  t.deepEqual(subscriptionsFromResources(), []);
  t.deepEqual(subscriptionsFromResources({}), []);
});

test('resolveEventBusName resolves string, Ref, Fn::GetAtt, Fn::ImportValue and defaults', t => {
  t.is(resolveEventBusName('my-bus'), 'my-bus');
  t.is(resolveEventBusName({Ref: 'MyBus'}), 'MyBus');
  t.is(resolveEventBusName({'Fn::GetAtt': ['MyBus', 'Name']}), 'MyBus');
  t.is(resolveEventBusName({'Fn::ImportValue': 'ExportedBus'}), 'ExportedBus');
  t.is(resolveEventBusName(undefined), 'default');
});

// ---------------------------------------------------------------------------
// Group G — source-level region call-site guard (SQS #166 style)
// ---------------------------------------------------------------------------

test('src/eventbridge.js builds the event with this.options.region, not a bare this.region', t => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'eventbridge.js'), 'utf8');
  t.true(source.includes('this.options.region'));
  t.false(/new EventBridgeEvent\(event, this\.region\b/.test(source));
});

// ---------------------------------------------------------------------------
// Group H — Lambda async destinations (onFailure / onSuccess) — spec B2
// ---------------------------------------------------------------------------

// A fake SQS client recording every command it is `.send()` a — no SDK transport, no docker.
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
      if (name === 'SendMessageCommand') {
        if (impl.sendMessageError) throw impl.sendMessageError;
        return Promise.resolve({MessageId: 'm-1'});
      }
      return Promise.resolve({});
    }
  };
};

const collectLog = () => {
  const warnings = [];
  return {log: {...normalizeLog(), warning: msg => warnings.push(msg)}, warnings};
};

const CTX = {'AWS::Region': 'eu-west-1', 'AWS::AccountId': '000000000000'};

// EARS8: the failure payload shape is preserved byte-for-byte.
test('buildFailurePayload returns the eventbridge {requestPayload, responsePayload} shape (EARS8)', t => {
  const err = Object.assign(new Error('boom'), {name: 'BoomError'});
  t.deepEqual(buildFailurePayload({a: 1}, err), {
    requestPayload: {a: 1},
    responsePayload: {errorMessage: 'boom', errorType: 'BoomError'}
  });
});

// EARS5: onSuccess payload carries the handler result.
test('buildSuccessPayload returns {requestPayload, responsePayload: result} (EARS5)', t => {
  t.deepEqual(buildSuccessPayload({a: 1}, {ok: true}), {
    requestPayload: {a: 1},
    responsePayload: {ok: true}
  });
});

// EARS6 / edge 2: resolve literal, {arn}, intrinsic, pseudo-param; undefined when unresolvable.
test('resolveDestinationArn resolves every supported target shape (EARS6)', t => {
  t.is(resolveDestinationArn('arn:aws:sqs:eu-west-1:0:dlq', CTX), 'arn:aws:sqs:eu-west-1:0:dlq');
  t.is(
    resolveDestinationArn({arn: 'arn:aws:sqs:eu-west-1:0:dlq'}, CTX),
    'arn:aws:sqs:eu-west-1:0:dlq'
  );
  t.is(resolveDestinationArn({Ref: 'AWS::AccountId'}, CTX), '000000000000');
  t.is(
    // eslint-disable-next-line no-template-curly-in-string -- deliberate CloudFormation Fn::Sub token
    resolveDestinationArn({arn: {'Fn::Sub': 'arn:aws:sqs:${AWS::Region}:0:dlq'}}, CTX),
    'arn:aws:sqs:eu-west-1:0:dlq'
  );
  t.is(
    resolveDestinationArn({'Fn::Join': [':', ['arn', 'aws', 'sqs', 'eu-west-1', '0', 'dlq']]}, CTX),
    'arn:aws:sqs:eu-west-1:0:dlq'
  );
  t.is(
    resolveDestinationArn('arn:aws:sqs:#{AWS::Region}:#{AWS::AccountId}:dlq', CTX),
    'arn:aws:sqs:eu-west-1:000000000000:dlq'
  );
});

test('resolveDestinationArn returns undefined for an unresolvable intrinsic (edge 2)', t => {
  t.is(resolveDestinationArn({arn: {'Fn::ImportValue': 'Exported'}}, CTX), undefined);
  t.is(resolveDestinationArn({Ref: 'SomeStackResource'}, CTX), undefined);
  t.is(resolveDestinationArn(undefined, CTX), undefined);
});

// EARS6: a Ref / Fn::GetAtt destination pointing at an AWS::SQS::Queue declared in the stack resolves
// to that queue's real ARN — through the SAME CFN resolution the event-source ARNs use.
const CTX_WITH_QUEUE = pseudoParams('eu-west-1', '000000000000', {
  MyDlq: {Type: 'AWS::SQS::Queue', Properties: {QueueName: 'my-dlq'}},
  AutoNamedDlq: {Type: 'AWS::SQS::Queue'},
  NotAQueue: {Type: 'AWS::S3::Bucket'}
});

test('resolveDestinationArn resolves a {Ref: <Queue>} destination to the queue ARN (EARS6)', t => {
  t.is(
    resolveDestinationArn({Ref: 'MyDlq'}, CTX_WITH_QUEUE),
    'arn:aws:sqs:eu-west-1:000000000000:my-dlq'
  );
  t.is(
    resolveDestinationArn({arn: {Ref: 'MyDlq'}}, CTX_WITH_QUEUE),
    'arn:aws:sqs:eu-west-1:000000000000:my-dlq'
  );
  // A queue with no explicit QueueName falls back to its logical id (serverless' local auto-name).
  t.is(
    resolveDestinationArn({Ref: 'AutoNamedDlq'}, CTX_WITH_QUEUE),
    'arn:aws:sqs:eu-west-1:000000000000:AutoNamedDlq'
  );
});

test('resolveDestinationArn resolves a {Fn::GetAtt: [<Queue>, Arn]} destination to the queue ARN (EARS6)', t => {
  t.is(
    resolveDestinationArn({'Fn::GetAtt': ['MyDlq', 'Arn']}, CTX_WITH_QUEUE),
    'arn:aws:sqs:eu-west-1:000000000000:my-dlq'
  );
  t.is(
    resolveDestinationArn({arn: {'Fn::GetAtt': ['AutoNamedDlq', 'Arn']}}, CTX_WITH_QUEUE),
    'arn:aws:sqs:eu-west-1:000000000000:AutoNamedDlq'
  );
});

test('resolveDestinationArn returns undefined for a Ref/Fn::GetAtt to a non-queue or absent resource (EARS6, edge 2)', t => {
  t.is(resolveDestinationArn({Ref: 'NotAQueue'}, CTX_WITH_QUEUE), undefined);
  t.is(resolveDestinationArn({Ref: 'Missing'}, CTX_WITH_QUEUE), undefined);
  t.is(resolveDestinationArn({'Fn::GetAtt': ['NotAQueue', 'Arn']}, CTX_WITH_QUEUE), undefined);
  // Only the Arn attribute is resolvable offline; QueueName/QueueUrl etc. are not.
  t.is(resolveDestinationArn({'Fn::GetAtt': ['MyDlq', 'QueueName']}, CTX_WITH_QUEUE), undefined);
});

// EARS6 end-to-end: a {Fn::GetAtt} onFailure destination dispatches to the resolved queue.
test('runDestinations dispatches onFailure to a Fn::GetAtt-resolved queue (EARS6)', async t => {
  const client = fakeSqsClient();
  const {log} = collectLog();
  await runDestinations({
    simulateDestinations: true,
    destinations: {onFailure: {'Fn::GetAtt': ['MyDlq', 'Arn']}},
    ctx: CTX_WITH_QUEUE,
    makeClient: () => client,
    log,
    requestPayload: {detail: 'x'},
    error: Object.assign(new Error('boom'), {name: 'BoomError'})
  });
  t.is(client.calls[0].input.QueueName, 'my-dlq');
});

// EARS1: queue name = final ':'-segment.
test('queueNameFromArn returns the final segment, undefined for garbage (EARS1)', t => {
  t.is(queueNameFromArn('arn:aws:sqs:eu-west-1:0:my-dlq'), 'my-dlq');
  t.is(queueNameFromArn(''), undefined);
  t.is(queueNameFromArn(undefined), undefined);
});

// Edge 1: nil target is a no-op — no client call at all.
test('dispatchDestination is a no-op for a nil target (edge 1)', async t => {
  const client = fakeSqsClient();
  const {log} = collectLog();
  await dispatchDestination({client, target: undefined, ctx: CTX, payload: {}, log});
  t.deepEqual(client.calls, []);
});

// Edge 2: unresolvable ARN warns and skips, never calls GetQueueUrl.
test('dispatchDestination warns and skips an unresolvable ARN (edge 2)', async t => {
  const client = fakeSqsClient();
  const {log, warnings} = collectLog();
  await dispatchDestination({
    client,
    target: {arn: {'Fn::ImportValue': 'X'}},
    ctx: CTX,
    payload: {},
    log
  });
  t.deepEqual(client.calls, []);
  t.is(warnings.length, 1);
});

// EARS1: a resolvable target -> GetQueueUrl(queueName) then SendMessage(payload).
test('dispatchDestination sends the payload to the resolved queue (EARS1)', async t => {
  const client = fakeSqsClient({queueUrl: 'http://localhost:9324/000/my-dlq'});
  const {log} = collectLog();
  await dispatchDestination({
    client,
    target: 'arn:aws:sqs:eu-west-1:0:my-dlq',
    ctx: CTX,
    payload: {requestPayload: {a: 1}, responsePayload: {errorMessage: 'x', errorType: 'E'}},
    log
  });
  t.deepEqual(client.calls[0], {name: 'GetQueueUrlCommand', input: {QueueName: 'my-dlq'}});
  t.is(client.calls[1].name, 'SendMessageCommand');
  t.is(client.calls[1].input.QueueUrl, 'http://localhost:9324/000/my-dlq');
  t.deepEqual(JSON.parse(client.calls[1].input.MessageBody), {
    requestPayload: {a: 1},
    responsePayload: {errorMessage: 'x', errorType: 'E'}
  });
});

// EARS7 / edge 3: any client error is warning-logged and swallowed.
test('dispatchDestination swallows a GetQueueUrl failure and warns (EARS7, edge 3)', async t => {
  const client = fakeSqsClient({getQueueUrlError: new Error('queue gone')});
  const {log, warnings} = collectLog();
  await t.notThrowsAsync(
    dispatchDestination({client, target: 'arn:aws:sqs:eu-west-1:0:dlq', ctx: CTX, payload: {}, log})
  );
  t.is(warnings.length, 1);
});

test('dispatchDestination swallows a SendMessage failure and warns (EARS7)', async t => {
  const client = fakeSqsClient({sendMessageError: new Error('send failed')});
  const {log, warnings} = collectLog();
  await t.notThrowsAsync(
    dispatchDestination({client, target: 'arn:aws:sqs:eu-west-1:0:dlq', ctx: CTX, payload: {}, log})
  );
  t.is(warnings.length, 1);
});

// EARS2: simulateDestinations === false is a no-op AND never builds a client (lazy).
test('runDestinations is a no-op and never builds a client when simulateDestinations is false (EARS2)', async t => {
  let built = false;
  const {log} = collectLog();
  await runDestinations({
    simulateDestinations: false,
    destinations: {onFailure: 'arn:aws:sqs:eu-west-1:0:dlq'},
    ctx: CTX,
    makeClient: () => {
      built = true;
      return fakeSqsClient();
    },
    log,
    requestPayload: {a: 1},
    error: new Error('boom')
  });
  t.false(built);
});

// Edge 1: no matching destination -> never builds a client.
test('runDestinations never builds a client when there is no matching destination (edge 1)', async t => {
  let built = false;
  const {log} = collectLog();
  await runDestinations({
    simulateDestinations: true,
    destinations: {onSuccess: 'arn:aws:sqs:eu-west-1:0:ok'},
    ctx: CTX,
    makeClient: () => {
      built = true;
      return fakeSqsClient();
    },
    log,
    requestPayload: {a: 1},
    error: new Error('boom') // error path -> looks for onFailure, which is absent
  });
  t.false(built);
});

// EARS1/8: end-to-end onFailure through runDestinations dispatches the failure payload.
test('runDestinations dispatches onFailure with the failure payload (EARS1, EARS8)', async t => {
  const client = fakeSqsClient();
  const {log} = collectLog();
  await runDestinations({
    simulateDestinations: true,
    destinations: {onFailure: 'arn:aws:sqs:eu-west-1:0:my-dlq'},
    ctx: CTX,
    makeClient: () => client,
    log,
    requestPayload: {detail: 'x'},
    error: Object.assign(new Error('boom'), {name: 'BoomError'})
  });
  t.is(client.calls[0].input.QueueName, 'my-dlq');
  t.deepEqual(JSON.parse(client.calls[1].input.MessageBody), {
    requestPayload: {detail: 'x'},
    responsePayload: {errorMessage: 'boom', errorType: 'BoomError'}
  });
});

// EARS5: end-to-end onSuccess through runDestinations dispatches the success payload.
test('runDestinations dispatches onSuccess with the result payload (EARS5)', async t => {
  const client = fakeSqsClient();
  const {log} = collectLog();
  await runDestinations({
    simulateDestinations: true,
    destinations: {onSuccess: 'arn:aws:sqs:eu-west-1:0:ok-queue'},
    ctx: CTX,
    makeClient: () => client,
    log,
    requestPayload: {detail: 'x'},
    result: {statusCode: 200}
  });
  t.is(client.calls[0].input.QueueName, 'ok-queue');
  t.deepEqual(JSON.parse(client.calls[1].input.MessageBody), {
    requestPayload: {detail: 'x'},
    responsePayload: {statusCode: 200}
  });
});
