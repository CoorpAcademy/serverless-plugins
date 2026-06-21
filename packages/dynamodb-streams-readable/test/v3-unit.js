// Fast unit tests for the aws-sdk v3 migration (#248) — no DynamoDB Local required.
// The docker-backed integration suite lives in ./index.js; these cover the v3-specific contract
// (the promise->callback shim and the omitted-Records guard) with plain fakes.
const test = require('ava');
const DynamoDBStreamReadable = require('..');
const {toCallbackMethod, buildCallbackClient} = require('../src/callback-adapter');

class FakeCommand {
  constructor(params) {
    this.params = params;
  }
}

// ---------------------------------------------------------------------------
// callback-adapter (#248 promise->callback shim — keeps the readable's pure helpers untouched)
// ---------------------------------------------------------------------------

test('toCallbackMethod forwards a resolved v3 send as (null, data)', async t => {
  const client = {send: command => Promise.resolve({echoed: command.params})};
  const method = toCallbackMethod(client, FakeCommand);
  const data = await new Promise((resolve, reject) => {
    method({StreamArn: 's'}, (err, d) => (err ? reject(err) : resolve(d)));
  });
  t.deepEqual(data, {echoed: {StreamArn: 's'}});
});

test('toCallbackMethod forwards a rejected v3 send as the err arg (no throw)', async t => {
  const boom = new Error('boom');
  const client = {send: () => Promise.reject(boom)};
  const method = toCallbackMethod(client, FakeCommand);
  const err = await new Promise(resolve => {
    method({}, e => resolve(e));
  });
  t.is(err, boom);
});

test('buildCallbackClient maps each command to a v2-style callback method plus a passthrough send', t => {
  const wrapped = buildCallbackClient(
    {send: () => Promise.resolve('ok')},
    {getRecords: FakeCommand, describeStream: FakeCommand, getShardIterator: FakeCommand}
  );
  t.is(typeof wrapped.getRecords, 'function');
  t.is(typeof wrapped.describeStream, 'function');
  t.is(typeof wrapped.getShardIterator, 'function');
  t.is(typeof wrapped.send, 'function');
});

// ---------------------------------------------------------------------------
// EARS3 — omitted Records array guard
// ---------------------------------------------------------------------------

// A v3 GetRecords response OMITS `Records` entirely when empty (aws-sdk v2 always returned []).
// Driving the readable with a fake callback client whose getRecords returns NO Records key must NOT
// crash on `undefined.length`; the stream ends cleanly on close().
test('EARS3: readable tolerates a v3 GetRecords response with an omitted Records array', t => {
  const fakeClient = {
    describeStream: (params, cb) => cb(null, {StreamDescription: {Shards: [{ShardId: 'shard-1'}]}}),
    getShardIterator: (params, cb) => cb(null, {ShardIterator: 'it-0'}),
    // No `Records` key at all — exactly what v3 returns for an empty batch.
    getRecords: (params, cb) => cb(null, {NextShardIterator: 'it-1'})
  };

  const readable = DynamoDBStreamReadable(fakeClient, 'arn:aws:dynamodb:::table/x/stream/y', {
    readInterval: 1
  });

  return new Promise((resolve, reject) => {
    readable
      .on('data', () => {})
      .on('error', err => reject(err))
      .on('end', () => {
        t.pass();
        resolve();
      });
    // Let a few empty polls happen, then close: a crash on undefined.Records would surface as an
    // 'error' event and reject before this fires.
    setTimeout(() => readable.close(), 50);
  });
});
