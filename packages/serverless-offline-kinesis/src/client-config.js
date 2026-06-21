const {isNil, omit} = require('lodash/fp');
const {NodeHttpHandler} = require('@smithy/node-http-handler');

// #248/#252 (aws-sdk v3): the v2 client silently ignored an empty/partial `credentials` object and
// defaulted the region; the v3 client does not. These pure helpers normalize the Serverless-supplied
// options into a clean v3 client config so the offline plugins keep working against local emulators.

// #248 (aws-sdk v3): unlike the other clients, `@aws-sdk/client-kinesis` defaults its request handler
// to `NodeHttp2Handler` (real AWS Kinesis serves HTTP/2). The local emulator (kinesalite) only speaks
// HTTP/1.1, so the default handler fails the connection with `ERR_HTTP2_ERROR: Protocol error` and the
// plugin hangs forever in `_describeStream`. Force the HTTP/1.1 handler so the offline client reaches
// kinesalite — `@smithy/node-http-handler` is a direct dependency of `@aws-sdk/client-kinesis`, so it
// is always installed alongside it.
const buildRequestHandler = () => new NodeHttpHandler();

// A region the v3 client accepts when none was provided. Local emulators (ElasticMQ, sqslite,
// DynamoDB Local, kinesalite) ignore the value but the v3 SDK still requires SOME region to sign.
const DEFAULT_REGION = 'us-east-1';

// #248 (aws-sdk v3): v3 clients default to maxAttempts:3 with ~150ms total backoff and give up
// (ECONNRESET "socket hang up") before a freshly-started local emulator (kinesalite) finishes
// booting — aws-sdk v2 tolerated this. A generous default lets the offline plugin ride out the
// emulator's cold start. A user-supplied `maxAttempts` still wins (it survives in `base` and is
// spread after this default below).
const DEFAULT_MAX_ATTEMPTS = 20;

// #252 (aws-sdk v3): build a `credentials` object ONLY when BOTH keys are present. A half-empty
// `{accessKeyId, secretAccessKey: undefined}` makes the v3 signer throw
// "Credential is missing" / produces a broken signature, whereas v2 tolerated it. When only one (or
// neither) key is supplied we omit `credentials` entirely and let the v3 default provider chain run.
const buildCredentials = options => {
  const accessKeyId = options ? options.accessKeyId : undefined;
  const secretAccessKey = options ? options.secretAccessKey : undefined;
  if (isNil(accessKeyId) || isNil(secretAccessKey)) return undefined;
  const sessionToken = options ? options.sessionToken : undefined;
  return {...(isNil(sessionToken) ? {} : {sessionToken}), accessKeyId, secretAccessKey};
};

// #248 (aws-sdk v3): a custom `endpoint` without `provider.region` must still work. v2 fell back to a
// default region; v3 throws "Region is missing". When an endpoint is set and no region is supplied,
// inject a default so signing succeeds against the local emulator.
const resolveRegion = options => {
  const region = options ? options.region : undefined;
  if (!isNil(region)) return region;
  return options && options.endpoint ? DEFAULT_REGION : undefined;
};

// buildClientConfig(options) -> a v3-ready client config. Pure + non-mutating: never sends a
// half-empty credentials object, and never leaves the region undefined when an endpoint is set.
// The original `accessKeyId`/`secretAccessKey`/`sessionToken` scalars are dropped (v3 reads them
// from `credentials`); every other option (endpoint, maxAttempts, ...) is passed through untouched.
const buildClientConfig = (options = {}) => {
  const base = omit(['accessKeyId', 'secretAccessKey', 'sessionToken', 'region'], options);
  const credentials = buildCredentials(options);
  const region = resolveRegion(options);
  return {
    ...base,
    ...(isNil(region) ? {} : {region}),
    ...(isNil(credentials) ? {} : {credentials}),
    // Cold-start default; a user-supplied `maxAttempts` (kept in `base`) still wins.
    maxAttempts: isNil(base.maxAttempts) ? DEFAULT_MAX_ATTEMPTS : base.maxAttempts,
    // Force HTTP/1.1 so the client can reach kinesalite (see buildRequestHandler above). A
    // user-supplied `requestHandler` in `options` still wins (it lands in `base` and is spread first).
    requestHandler: base.requestHandler || buildRequestHandler()
  };
};

// #248 (aws-sdk v3): a v3 GetRecords/ReceiveMessage response OMITS the array key entirely when empty
// (v2 always returned `[]`). Guard so `response.Records.length` / `.Messages.length` never throws on
// `undefined`. Pure: returns the array unchanged when present, `[]` when nil.
const ensureArray = value => (isNil(value) ? [] : value);

module.exports = {
  DEFAULT_REGION,
  DEFAULT_MAX_ATTEMPTS,
  buildClientConfig,
  buildCredentials,
  resolveRegion,
  ensureArray
};
