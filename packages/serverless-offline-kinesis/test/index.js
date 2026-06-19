const fs = require('fs');
const path = require('path');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {shouldRetry} = require('../src/kinesis');
const KinesisEvent = require('../src/kinesis-event');
const KinesisEventDefinition = require('../src/kinesis-event-definition');

// ---------------------------------------------------------------------------
// normalizeLog (v4 logger shim)
// ---------------------------------------------------------------------------

test('normalizeLog returns the console-fallback defaults when given nothing', t => {
  const log = normalizeLog();
  t.is(log.debug, defaultLog.debug);
  t.is(log.notice, defaultLog.notice);
  t.is(log.warning, defaultLog.warning);
  t.is(log.error, defaultLog.error);
  t.is(typeof log.success, 'function');
});

test('normalizeLog tolerates null/undefined', t => {
  t.notThrows(() => normalizeLog(null));
  t.notThrows(() => normalizeLog(undefined));
  t.is(normalizeLog(null).notice, defaultLog.notice);
});

test('normalizeLog overlays the injected logger over the defaults', t => {
  const injected = {notice: () => 'custom-notice', warning: () => 'custom-warning'};
  const log = normalizeLog(injected);
  t.is(log.notice, injected.notice);
  t.is(log.warning, injected.warning);
  // untouched methods keep the defaults
  t.is(log.debug, defaultLog.debug);
  t.is(log.error, defaultLog.error);
});

test('defaultLog.debug is a silent no-op', t => {
  t.is(defaultLog.debug(), undefined);
});

// ---------------------------------------------------------------------------
// KinesisEvent mapper — #166 guard: awsRegion must be the real region
// ---------------------------------------------------------------------------

const chunk = [
  {
    SequenceNumber: '49590338271490256608559692538361571095921575989136588898',
    Data: Buffer.from('hello world'),
    PartitionKey: 'partition-1'
  }
];

test('KinesisEvent maps records into the aws:kinesis Lambda event shape', t => {
  const arn = 'arn:aws:kinesis:eu-west-1:000000000000:stream/polls';
  const {Records} = new KinesisEvent(chunk, 'eu-west-1', arn, 'shardId-000000000000');

  t.is(Records.length, 1);
  const [record] = Records;
  t.is(record.eventSource, 'aws:kinesis');
  t.is(record.eventName, 'aws:kinesis:record');
  t.is(record.eventSourceARN, arn);
  t.is(record.kinesis.partitionKey, 'partition-1');
  t.is(record.kinesis.kinesisSchemaVersion, '1.0');
  t.is(record.kinesis.sequenceNumber, chunk[0].SequenceNumber);
  // data is base64-encoded
  t.is(record.kinesis.data, Buffer.from('hello world').toString('base64'));
  t.is(Buffer.from(record.kinesis.data, 'base64').toString(), 'hello world');
  // eventID = `${shardId}:${sequenceNumber}`
  t.is(record.eventID, `shardId-000000000000:${chunk[0].SequenceNumber}`);
});

test('#166 regression: awsRegion is the passed region, not undefined', t => {
  const {Records} = new KinesisEvent(chunk, 'us-east-2', 'arn:aws:kinesis:...', 'shardId-0');
  t.is(Records[0].awsRegion, 'us-east-2');
  t.not(Records[0].awsRegion, undefined);
});

// ---------------------------------------------------------------------------
// KinesisEventDefinition — omit-fix regression + passthrough merge
// ---------------------------------------------------------------------------

test('KinesisEventDefinition normalizes a string ARN', t => {
  const def = new KinesisEventDefinition(
    'arn:aws:kinesis:eu-west-1:000000000000:stream/polls',
    'eu-west-1',
    '000000000000'
  );
  t.is(def.streamName, 'polls');
  // the arn is rebuilt from the resolved streamName (stream/ prefix dropped)
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
  t.is(def.enabled, true);
  t.is(def.batchSize, 10);
  t.is(def.startingPosition, 'LATEST');
  t.is(def.maximumRetryAttempts, 10);
});

test('KinesisEventDefinition normalizes the {streamName} form', t => {
  const def = new KinesisEventDefinition({streamName: 'polls'}, 'eu-west-1', '000000000000');
  t.is(def.streamName, 'polls');
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
});

test('KinesisEventDefinition normalizes the {arn} form', t => {
  const def = new KinesisEventDefinition(
    {arn: 'arn:aws:kinesis:eu-west-1:000000000000:stream/polls'},
    'eu-west-1',
    '000000000000'
  );
  t.is(def.streamName, 'polls');
});

test('omit-fix regression: extra props merge through, the resolved streamName is preserved', t => {
  // Before the fix the omit list named `tableName` (a dynamodb field), so a
  // `streamName` provided alongside other props could leak through unexpectedly.
  // After the fix `streamName` is omitted from the passthrough merge, so the
  // resolved streamName stands while every other extra prop merges as intended.
  const def = new KinesisEventDefinition(
    {
      streamName: 'polls',
      batchSize: 50,
      startingPosition: 'TRIM_HORIZON',
      maximumRetryAttempts: 3,
      readInterval: 1000
    },
    'eu-west-1',
    '000000000000'
  );
  t.is(def.streamName, 'polls');
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
  // extra/overriding props merged through
  t.is(def.batchSize, 50);
  t.is(def.startingPosition, 'TRIM_HORIZON');
  t.is(def.maximumRetryAttempts, 3);
  t.is(def.readInterval, 1000);
  // arn is never overwritten by a raw `arn` passthrough (omitted)
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
});

test('omit-fix regression: a conflicting raw streamName never overrides the ARN-resolved one', t => {
  // Discriminating guard: under the OLD bug the omit list named `tableName` (a
  // dynamodb field), so a raw `streamName` alongside an `arn` would leak through
  // Object.assign and clobber the ARN-resolved name. With the fix (`omit streamName`)
  // the resolved name stands. This test FAILS under the old code and PASSES under the fix.
  const def = new KinesisEventDefinition(
    {arn: 'arn:aws:kinesis:eu-west-1:000000000000:stream/polls', streamName: 'attacker'},
    'eu-west-1',
    '000000000000'
  );
  t.is(def.streamName, 'polls');
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
});

test('omit-fix regression: a raw `arn` passthrough does not overwrite the computed arn', t => {
  // Given the {arn} form, the streamName is extracted from the arn and the arn
  // is recomputed from the plugin's own region/accountId. The raw `arn` prop is
  // in the omit list, so it never leaks back over the computed value.
  const def = new KinesisEventDefinition(
    {
      arn: 'arn:aws:kinesis:us-east-1:999999999999:stream/polls',
      batchSize: 25
    },
    'eu-west-1',
    '000000000000'
  );
  t.is(def.streamName, 'polls');
  t.is(def.arn, 'arn:aws:kinesis:eu-west-1:000000000000:polls');
  t.not(def.arn, 'arn:aws:kinesis:us-east-1:999999999999:stream/polls');
  t.is(def.batchSize, 25);
});

// ---------------------------------------------------------------------------
// shouldRetry — bounded retry attempt-counter (#100)
// ---------------------------------------------------------------------------

test('shouldRetry allows a retry while attempts remain', t => {
  t.true(shouldRetry(5));
  t.true(shouldRetry(1));
});

test('shouldRetry stops once no attempts remain', t => {
  t.false(shouldRetry(0));
  t.false(shouldRetry(-1));
});

test('shouldRetry caps the loop: a finite attempt budget terminates', t => {
  // Simulate the recursion guard: start at maximumRetryAttempts - 1, decrement
  // each retry. The recursion must stop after a finite number of attempts.
  const maximumRetryAttempts = 10;
  const run = (remaining, invocations) =>
    shouldRetry(remaining) ? run(remaining - 1, invocations + 1) : invocations;
  // first invocation is the initial run, then retries while allowed
  const totalInvocations = run(maximumRetryAttempts - 1, 1);
  t.is(totalInvocations, maximumRetryAttempts);
});

// ---------------------------------------------------------------------------
// Source-level guards: the production handler must use the bounded retry (#100)
// and build the event with this.options.region (#166), not the undefined this.region.
// ---------------------------------------------------------------------------

const kinesisSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'kinesis.js'), 'utf8');

test('src/kinesis.js builds KinesisEvent with this.options.region, not this.region (#166)', t => {
  t.true(kinesisSource.includes('this.options.region'));
  t.false(/new KinesisEvent\(chunk, this\.region\b/.test(kinesisSource));
});

test('src/kinesis.js production handler uses the bounded shouldRetry guard (#100)', t => {
  // The infinite-recursion bug had no attempt budget; the fix gates retries on shouldRetry.
  t.true(kinesisSource.includes('shouldRetry(remainingAttempts)'));
  t.true(kinesisSource.includes('task(remainingAttempts - 1)'));
});
