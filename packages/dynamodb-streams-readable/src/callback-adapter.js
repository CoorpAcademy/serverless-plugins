// #248 (aws-sdk v3): `kinesis-readable` drives the AWS client through the aws-sdk v2 CALLBACK
// contract — `client.describeStream(params, cb)`, `client.getShardIterator(params, cb)`,
// `client.getRecords(params, cb)`. The @aws-sdk v3 client only exposes the promise-based
// `client.send(new Command(params))`. Rather than fork the readable, wrap the v3 client in a thin
// promise->callback shim that re-exposes exactly the v2 callback-style methods the readable expects,
// leaving the readable's pure logic untouched.

// toCallbackMethod(client, Command) -> (params, callback) => Promise
// Pure factory: returns a node-style callback function that sends the v3 command and forwards
// (err, data) to the callback. Never throws synchronously; a rejected send surfaces as the `err` arg.
// The send promise is returned (rejection handled in-chain) so it is never floated, and the callback
// runs exactly once on settlement — mirroring the aws-sdk v2 callback contract kinesis-readable uses.
const toCallbackMethod = (client, Command) => (params, callback) =>
  client.send(new Command(params)).then(
    data => callback(null, data),
    err => callback(err)
  );

// buildCallbackClient(client, commandsByMethod) -> {<method>: (params, cb) => void, send}
// Pure: maps every {methodName: Command} entry to a v2-style callback method bound to `client`, and
// keeps `send` available for direct v3 use. Does not mutate `client`.
const buildCallbackClient = (client, commandsByMethod) => {
  const methods = Object.fromEntries(
    Object.entries(commandsByMethod).map(([method, Command]) => [
      method,
      toCallbackMethod(client, Command)
    ])
  );
  return {...methods, send: (...args) => client.send(...args)};
};

module.exports = {toCallbackMethod, buildCallbackClient};
