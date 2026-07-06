const {getOr, isNil, merge} = require('lodash/fp');

// serverless-offline-bedrock — model-id → backend resolution (pure).
//
// A request's AWS `modelId` selects the local backend that answers it: a per-modelId entry under
// `custom.serverless-offline-bedrock.models[<modelId>]` deep-merged OVER the default
// `custom.serverless-offline-bedrock.backend`, so an override only needs to set the fields it
// changes (unset fields inherit the default). Pure, total helper (G1/G2/G3); never mutates options.

const SUPPORTED_PROTOCOLS = ['openai', 'anthropic'];

const DEFAULT_BACKEND = {
  protocol: 'openai',
  baseUrl: 'http://localhost:11434/v1',
  apiKey: '',
  defaultMaxTokens: 4096,
  timeout: 120000
};

// resolveBackend(modelId, options) → the fully-resolved backend for this modelId.
// `models[modelId]` (if any) is deep-merged over `backend` over DEFAULT_BACKEND; an override that
// omits `model` inherits the default backend's `model` (AC-A3). Unknown `protocol` fails fast
// naming the modelId (G12 boundary validation / AC-A4 diagnostics), never returns a bad config.
const resolveBackend = (modelId, options) => {
  const defaultBackend = getOr({}, 'backend', options);
  const override = getOr({}, ['models', modelId], options);

  // merge(DEFAULT_BACKEND, defaultBackend, override) — lodash/fp merge is right-biased and deep, so
  // an override's set fields win while its unset fields fall through to the default backend.
  const resolved = merge(merge(DEFAULT_BACKEND, defaultBackend), override);

  if (!SUPPORTED_PROTOCOLS.includes(resolved.protocol))
    throw new Error(
      `serverless-offline-bedrock: unknown backend protocol "${resolved.protocol}" for modelId ` +
        `"${modelId}" — expected one of ${SUPPORTED_PROTOCOLS.join(', ')}.`
    );

  if (isNil(resolved.model))
    throw new Error(
      `serverless-offline-bedrock: no local model configured for modelId "${modelId}" — set ` +
        '`backend.model` (default) or `models.<modelId>.model` in custom.serverless-offline-bedrock.'
    );

  return resolved;
};

module.exports = {SUPPORTED_PROTOCOLS, DEFAULT_BACKEND, resolveBackend};
