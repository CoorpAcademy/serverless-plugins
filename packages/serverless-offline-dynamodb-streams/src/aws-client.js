const {getOr, isNil, omitBy, pick} = require('lodash/fp');

// #248 (EdgarOrtegaRamirez): the plugin printed the AWS-SDK-v2 maintenance-mode warning because it
// imported `aws-sdk/clients/dynamodb(streams)`. We migrated to `@aws-sdk/client-dynamodb(-streams)`
// v3. The Serverless config still hands us a *flat* v2-style options bag
// ({region, endpoint, accessKeyId, secretAccessKey, ...}); v3 wants `region`/`endpoint` at the top
// level and `accessKeyId`/`secretAccessKey` nested under `credentials`. `toClientConfig` is the pure
// boundary that normalizes the former into the latter.

const omitNil = omitBy(isNil);

// Build the nested v3 `credentials` from the flat v2 keys. Only emitted when an accessKeyId is
// present; the secret defaults to the accessKeyId so a local emulator (dynamodb-local) — which does
// not verify the signature — still receives a non-empty secret, mirroring the v2 behaviour where the
// flat keys were forwarded verbatim. With no accessKeyId we fall through to the default credential
// chain (no `credentials` key), exactly as v2 did when none were configured.
const toCredentials = options => {
  const accessKeyId = getOr(undefined, 'accessKeyId', options);
  if (isNil(accessKeyId)) return undefined;
  const secretAccessKey = getOr(accessKeyId, 'secretAccessKey', options);
  const sessionToken = getOr(undefined, 'sessionToken', options);
  return omitNil({accessKeyId, secretAccessKey, sessionToken});
};

const toClientConfig = (options = {}) => {
  const base = pick(['region', 'endpoint'], options);
  const credentials = toCredentials(options);
  return omitNil({...base, credentials});
};

module.exports = {toClientConfig, toCredentials};
