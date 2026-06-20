const {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetShardIteratorCommand,
  GetRecordsCommand
} = require('@aws-sdk/client-dynamodb-streams');

const {toClientConfig} = require('./aws-client');

// #248 (EdgarOrtegaRamirez): `dynamodb-streams-readable` consumes its client through the AWS-SDK-v2
// *callback* contract — `client.getShardIterator(params, cb)`, `client.describeStream(params, cb)`,
// `client.getRecords(params, cb)`. AWS-SDK v3 only exposes the promise-based `client.send(command)`.
// Rather than rewrite the readable (and risk its battle-tested pure helpers), we adapt the v3 client
// to the v2 callback surface with this thin shim. The v3 response (minus `$metadata`) carries the
// same fields the readable reads (`ShardIterator`, `StreamDescription.Shards`, `Records`,
// `NextShardIterator`), so its pure helpers — selectShardId / isRecoverableIteratorError /
// nextRetryState / shouldKeepPolling / canRead — keep passing untouched.

// Turn `client.send(new Command(params))` (a Promise) into a v2-style `(params, cb)` method.
const toCallbackMethod = (client, Command) => (params, callback) => {
  client
    .send(new Command(params))
    .then(data => callback(null, data))
    // v3 surfaces the AWS error type via `err.name` (e.g. ExpiredIteratorException), which is exactly
    // what the readable's isRecoverableIteratorError inspects — so the recovery path is preserved.
    .catch(callback);
};

// Wrap a v3 DynamoDBStreamsClient in the trio of callback methods the readable expects. Exported pure
// so it can be unit-tested against a fake `{send}` without any network or real SDK client.
const toCallbackStreamsClient = client => ({
  getShardIterator: toCallbackMethod(client, GetShardIteratorCommand),
  describeStream: toCallbackMethod(client, DescribeStreamCommand),
  getRecords: toCallbackMethod(client, GetRecordsCommand)
});

// Construct a real v3 streams client from the flat Serverless options, already adapted to the v2
// callback contract — the single value `dynamodb-streams.js` hands to DynamoDBStreamReadable.
const createCallbackStreamsClient = options =>
  toCallbackStreamsClient(new DynamoDBStreamsClient(toClientConfig(options)));

module.exports = {
  toCallbackMethod,
  toCallbackStreamsClient,
  createCallbackStreamsClient
};
