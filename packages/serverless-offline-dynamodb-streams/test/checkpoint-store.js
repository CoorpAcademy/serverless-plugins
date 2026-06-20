const test = require('ava');

const {
  mergeCheckpoint,
  resolveStartAfter,
  serializeCheckpointState,
  parseCheckpointState
} = require('../src/checkpoint-store');

// ---------------------------------------------------------------------------
// mergeCheckpoint (#178 jjohnson1994) — state + new (streamArn, shardId, seq) -> next state
// ---------------------------------------------------------------------------

const STREAM_A = 'arn:aws:dynamodb:eu-west-1:000000000000:table/myTable/stream/2024';
const STREAM_B = 'arn:aws:dynamodb:eu-west-1:000000000000:table/orders/stream/2024';

test('mergeCheckpoint writes the sequence number under (streamArn, shardId) into an empty state', t => {
  const next = mergeCheckpoint(
    {},
    {streamArn: STREAM_A, shardId: 'shard-0', sequenceNumber: '111'}
  );

  t.deepEqual(next, {[STREAM_A]: {'shard-0': '111'}});
});

test('mergeCheckpoint overwrites the previous sequence number for the same (streamArn, shardId)', t => {
  const state = {[STREAM_A]: {'shard-0': '111'}};
  const next = mergeCheckpoint(state, {
    streamArn: STREAM_A,
    shardId: 'shard-0',
    sequenceNumber: '222'
  });

  t.deepEqual(next, {[STREAM_A]: {'shard-0': '222'}});
});

test('mergeCheckpoint keeps sibling shards and sibling streams untouched', t => {
  const state = {
    [STREAM_A]: {'shard-0': '111', 'shard-1': '999'},
    [STREAM_B]: {'shard-0': '500'}
  };
  const next = mergeCheckpoint(state, {
    streamArn: STREAM_A,
    shardId: 'shard-0',
    sequenceNumber: '222'
  });

  t.deepEqual(next, {
    [STREAM_A]: {'shard-0': '222', 'shard-1': '999'},
    [STREAM_B]: {'shard-0': '500'}
  });
});

test('mergeCheckpoint does not mutate the input state', t => {
  const state = {[STREAM_A]: {'shard-0': '111'}};
  const before = JSON.parse(JSON.stringify(state));

  mergeCheckpoint(state, {streamArn: STREAM_A, shardId: 'shard-0', sequenceNumber: '222'});

  t.deepEqual(state, before);
});

test('mergeCheckpoint ignores a nil/empty sequence number (no spurious checkpoint)', t => {
  const state = {[STREAM_A]: {'shard-0': '111'}};

  t.deepEqual(
    mergeCheckpoint(state, {streamArn: STREAM_A, shardId: 'shard-0', sequenceNumber: undefined}),
    state
  );
  t.deepEqual(
    mergeCheckpoint(state, {streamArn: STREAM_A, shardId: 'shard-0', sequenceNumber: null}),
    state
  );
  t.deepEqual(
    mergeCheckpoint(state, {streamArn: STREAM_A, shardId: 'shard-0', sequenceNumber: ''}),
    state
  );
});

// ---------------------------------------------------------------------------
// resolveStartAfter (#178 jjohnson1994) — state -> the saved sequence to resume past
// ---------------------------------------------------------------------------

test('resolveStartAfter returns the saved sequence number for a known (streamArn, shardId)', t => {
  const state = {[STREAM_A]: {'shard-0': '111'}};
  t.is(resolveStartAfter(state, {streamArn: STREAM_A, shardId: 'shard-0'}), '111');
});

test('resolveStartAfter returns undefined for an unknown stream or shard (cold start)', t => {
  const state = {[STREAM_A]: {'shard-0': '111'}};
  t.is(resolveStartAfter(state, {streamArn: STREAM_A, shardId: 'shard-1'}), undefined);
  t.is(resolveStartAfter(state, {streamArn: STREAM_B, shardId: 'shard-0'}), undefined);
  t.is(resolveStartAfter({}, {streamArn: STREAM_A, shardId: 'shard-0'}), undefined);
});

// ---------------------------------------------------------------------------
// serialize / parse round-trip (#178 jjohnson1994)
// ---------------------------------------------------------------------------

test('serializeCheckpointState + parseCheckpointState round-trips a state map', t => {
  const state = {[STREAM_A]: {'shard-0': '222'}, [STREAM_B]: {'shard-0': '500'}};
  t.deepEqual(parseCheckpointState(serializeCheckpointState(state)), state);
});

test('parseCheckpointState tolerates malformed/empty content by returning an empty state', t => {
  t.deepEqual(parseCheckpointState(''), {});
  t.deepEqual(parseCheckpointState('   '), {});
  t.deepEqual(parseCheckpointState('not json'), {});
  t.deepEqual(parseCheckpointState(undefined), {});
  t.deepEqual(parseCheckpointState(null), {});
});

test('parseCheckpointState coerces a non-object JSON payload to an empty state', t => {
  t.deepEqual(parseCheckpointState('123'), {});
  t.deepEqual(parseCheckpointState('"a string"'), {});
  t.deepEqual(parseCheckpointState('[1,2,3]'), {});
  t.deepEqual(parseCheckpointState('null'), {});
});

test('serializeCheckpointState produces stable, human-diffable JSON', t => {
  const state = {[STREAM_A]: {'shard-0': '222'}};
  t.is(serializeCheckpointState(state), JSON.stringify(state, null, 2));
});
