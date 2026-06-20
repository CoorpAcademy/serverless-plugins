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
