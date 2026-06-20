const test = require('ava');
const DynamoDBStreamReadable = require('..');
const {
  selectShardId,
  isRecoverableIteratorError,
  shouldDrain,
  shouldKeepPolling,
  canRead,
  nextRetryState
} = require('../src/stream-helpers');

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

const SHARDS = [{ShardId: 'shard-A'}, {ShardId: 'shard-B'}];

// ---- selectShardId (#164 mdrijwan / rynvelt: no silent Shards[0] fallback) ----
test('selectShardId returns first shard id when no shardId requested', t => {
  t.is(selectShardId(SHARDS, undefined), 'shard-A');
});
test('selectShardId returns the matching shard id when present', t => {
  t.is(selectShardId(SHARDS, 'shard-B'), 'shard-B');
});
test('#164 selectShardId returns undefined for a missing shardId instead of falling back to Shards[0]', t => {
  t.is(selectShardId(SHARDS, 'shard-missing'), undefined);
});
test('selectShardId does not mutate its inputs', t => {
  const shards = [{ShardId: 'shard-A'}];
  const before = JSON.stringify(shards);
  selectShardId(shards, 'shard-A');
  t.is(JSON.stringify(shards), before);
});

// ---- isRecoverableIteratorError (#154 mshick, #164 mdrijwan) ----
test('#154 isRecoverableIteratorError recovers a ResourceNotFoundException (Invalid ShardId in ShardIterator)', t => {
  t.true(isRecoverableIteratorError({name: 'ResourceNotFoundException'}));
});
test('isRecoverableIteratorError recovers an ExpiredIteratorException', t => {
  t.true(isRecoverableIteratorError({name: 'ExpiredIteratorException'}));
});
test('isRecoverableIteratorError still recovers TrimmedDataAccessException (regression)', t => {
  t.true(isRecoverableIteratorError({name: 'TrimmedDataAccessException'}));
});
test('isRecoverableIteratorError does not recover unrelated errors', t => {
  t.false(isRecoverableIteratorError({name: 'ValidationException'}));
  t.false(isRecoverableIteratorError(undefined));
  t.false(isRecoverableIteratorError({}));
});

// ---- bounded recovery (#154/#164) ----
test('nextRetryState retries while budget remains and stops when exhausted', t => {
  t.deepEqual(nextRetryState({attempt: 0, max: 3}), {retry: true, attempt: 1, max: 3});
  t.deepEqual(nextRetryState({attempt: 3, max: 3}), {retry: false, attempt: 3, max: 3});
});

// ---- shouldDrain / shouldKeepPolling (#54 asprouse, #82 kalitamih, #163 mcopik) ----
test('#54 shouldDrain is true only when the consumer closed the stream', t => {
  t.true(shouldDrain({closed: true, sealed: false}));
});
test('#82 shouldDrain is false on an absent NextShardIterator for an open, non-closed stream', t => {
  // origin/master wrongly sets drain=true here -> premature end
  t.false(shouldDrain({closed: false, sealed: false}));
});
test('shouldDrain is true when the shard is genuinely sealed', t => {
  t.true(shouldDrain({closed: false, sealed: true}));
});
test('#163 shouldKeepPolling keeps polling on an empty batch with no NextShardIterator (open shard)', t => {
  t.true(
    shouldKeepPolling({records: [], nextShardIterator: undefined, closed: false, sealed: false})
  );
});
test('shouldKeepPolling keeps polling on an empty batch with a NextShardIterator', t => {
  t.true(shouldKeepPolling({records: [], nextShardIterator: 'it', closed: false, sealed: false}));
});
test('shouldKeepPolling stops polling once the consumer closed the stream', t => {
  t.false(shouldKeepPolling({records: [], nextShardIterator: 'it', closed: true, sealed: false}));
});

// ---- canRead (#197 cnuss: no read after close/SIGINT) ----
test('#197 canRead is false once the stream is closed, regardless of iterator/pending', t => {
  t.false(canRead({closed: true, iterator: 'it', drain: false, pending: 0}));
});
test('canRead is false when there is no iterator yet', t => {
  t.false(canRead({closed: false, iterator: undefined, drain: false, pending: 0}));
});
test('canRead is true for an open stream with an iterator and no drain', t => {
  t.true(canRead({closed: false, iterator: 'it', drain: false, pending: 0}));
});
test('canRead does not mutate its input', t => {
  const state = {closed: false, iterator: 'it', drain: false, pending: 0};
  const before = JSON.stringify(state);
  canRead(state);
  t.is(JSON.stringify(state), before);
});

// ---- Behavioral guard with a fake client (no AWS): close() issues no further getRecords (#197) ----
// This mirrors the integration tests' streaming style but uses an in-memory fake client so it runs
// without docker. It exercises the assembled stream, asserting close() does not fire a new read.
test('#197 close() does not trigger a new getRecords against the (shutting-down) endpoint', async t => {
  let getRecordsCalls = 0;
  const fakeClient = {
    describeStream: (params, cb) =>
      setImmediate(cb, null, {StreamDescription: {Shards: [{ShardId: 'shard-A'}]}}),
    getShardIterator: (params, cb) => setImmediate(cb, null, {ShardIterator: 'it-0'}),
    getRecords: (params, cb) => {
      getRecordsCalls += 1;
      setImmediate(cb, null, {Records: [], NextShardIterator: 'it-next'});
    }
  };
  const readable = DynamoDBStreamReadable(fakeClient, 'arn:aws:dynamodb:eu-west-1:0:t/stream/x', {
    readInterval: 5
  });

  await new Promise((resolve, reject) => {
    readable.on('data', () => {});
    readable.on('error', reject);
    setTimeout(() => {
      const callsAtClose = getRecordsCalls;
      readable.close();
      setTimeout(() => {
        t.is(getRecordsCalls, callsAtClose, 'no getRecords issued after close()');
        resolve();
      }, 30);
    }, 30);
  });
});

test('#54/#82/#163 a delayed second batch still arrives after the first read interval (no premature end)', async t => {
  // origin/master latches drain=true on the first empty batch with an absent NextShardIterator and
  // emits `end` -> the second batch (written after the first interval) is never delivered.
  let getRecordsCalls = 0;
  const lateRecord = {dynamodb: {Keys: {Id: {S: 'late'}}, SequenceNumber: '2'}};
  const fakeClient = {
    describeStream: (params, cb) =>
      setImmediate(cb, null, {StreamDescription: {Shards: [{ShardId: 'shard-A'}]}}),
    getShardIterator: (params, cb) => setImmediate(cb, null, {ShardIterator: 'it-0'}),
    getRecords: (params, cb) => {
      getRecordsCalls += 1;
      // First poll: empty batch with NO NextShardIterator (the exact emulator case from #82/#163).
      if (getRecordsCalls === 1)
        return setImmediate(cb, null, {Records: [], NextShardIterator: undefined});
      // A later poll (after the read interval) delivers the second batch on the still-open shard.
      if (getRecordsCalls >= 3)
        return setImmediate(cb, null, {Records: [lateRecord], NextShardIterator: 'it-next'});
      return setImmediate(cb, null, {Records: [], NextShardIterator: 'it-next'});
    }
  };
  const readable = DynamoDBStreamReadable(fakeClient, 'arn:aws:dynamodb:eu-west-1:0:t/stream/x', {
    readInterval: 5
  });

  const received = [];
  const delivered = await Promise.race([
    new Promise((resolve, reject) => {
      readable.on('data', recordSet => {
        received.push(...recordSet);
        readable.close();
        resolve(received);
      });
      readable.on('error', reject);
    }),
    delay(200).then(() => received)
  ]);

  t.is(
    delivered.length,
    1,
    'the delayed second batch is delivered (stream did not end prematurely)'
  );
  t.is(delivered[0].dynamodb.Keys.Id.S, 'late');
});
