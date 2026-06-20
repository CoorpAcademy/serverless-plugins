const {identity, getOr, isNil} = require('lodash/fp');

// #248 (aws-sdk v3): `kinesis-readable` drives the AWS client through the aws-sdk v2 CALLBACK
// contract — `client.describeStream(params, cb)`, `client.getShardIterator(params, cb)`,
// `client.getRecords(params, cb)`. The @aws-sdk v3 client only exposes the promise-based
// `client.send(new Command(params))`. Rather than fork the readable, wrap the v3 client in a thin
// promise->callback shim that re-exposes exactly the v2 callback-style methods the readable expects,
// leaving the readable's pure logic untouched.

// #248 (aws-sdk v3) — EARS3 parity: a v3 GetRecords response OMITS `Records` entirely when the batch
// is empty (aws-sdk v2 always returned `[]`). `kinesis-readable`'s `read()` reads `data.Records.length`
// UNGUARDED, so an omitted `Records` would throw `Cannot read properties of undefined (reading
// 'length')`. Mirror the dynamodb-streams-readable guard at this same I/O seam: normalize the
// getRecords response so `Records` defaults to `[]` before it ever reaches kinesis-readable.
// Pure + non-mutating: returns a new object, never the input. Coalesces both an OMITTED key (the real
// v3 empty-batch shape) and an explicit `null` to `[]` — the same `isNil` parity as `ensureArray`.
const ensureRecordsResponse = response => {
  const records = getOr(undefined, 'Records', response);
  return {...response, Records: isNil(records) ? [] : records};
};

// toCallbackMethod(client, Command, [normalize]) -> (params, callback) => Promise
// Pure factory: returns a node-style callback function that sends the v3 command, runs the resolved
// data through `normalize` (identity by default), and forwards (err, data) to the callback. Never
// throws synchronously; a rejected send surfaces as the `err` arg. The send promise is returned
// (rejection handled in-chain) so it is never floated, and the callback runs exactly once on
// settlement — mirroring the aws-sdk v2 callback contract kinesis-readable uses.
const toCallbackMethod =
  (client, Command, normalize = identity) =>
  (params, callback) =>
    client.send(new Command(params)).then(
      data => callback(null, normalize(data)),
      err => callback(err)
    );

// #248 (aws-sdk v3): per-method response normalizers. Only getRecords needs the `Records -> []` guard;
// every other method passes through unchanged (identity).
const RESPONSE_NORMALIZERS = {
  getRecords: ensureRecordsResponse
};

// buildCallbackClient(client, commandsByMethod) -> {<method>: (params, cb) => void, send}
// Pure: maps every {methodName: Command} entry to a v2-style callback method bound to `client`,
// applying the method's response normalizer (default identity), and keeps `send` available for direct
// v3 use. Does not mutate `client`.
const buildCallbackClient = (client, commandsByMethod) => {
  const methods = Object.fromEntries(
    Object.entries(commandsByMethod).map(([method, Command]) => [
      method,
      toCallbackMethod(client, Command, getOr(identity, method, RESPONSE_NORMALIZERS))
    ])
  );
  return {...methods, send: (...args) => client.send(...args)};
};

module.exports = {toCallbackMethod, buildCallbackClient, ensureRecordsResponse};
