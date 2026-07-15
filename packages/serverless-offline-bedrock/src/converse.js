const {get, getOr, isNil} = require('lodash/fp');
const {toOpenAiRequest, fromOpenAiResponse} = require('./adapters/openai');
const {toAnthropicRequest, fromAnthropicResponse} = require('./adapters/anthropic');
const {resolveBackend} = require('./backend-config');

// serverless-offline-bedrock — Converse request orchestration.
//
// Pure translation (request in / response out) is delegated to the protocol adapters; the single
// isolated side effect is `callBackend` (the outbound HTTP call to the local LLM). The exported
// helpers are pure/total so they unit-test without a network (G2/G3/G4).

// The MVP adapters translate only text + tool blocks. Genuine multimodal content (image/document/
// video) carries meaning the adapters would otherwise SILENTLY DROP — the backend then answers 200 on
// a materially different prompt, hiding the loss (Codex F8). Reject those blocks up front so the
// caller gets an explicit 400 ValidationException (via handleConverse's guard) instead of a
// false-confidence success. Metadata-only blocks (cachePoint/guardContent) are left to pass through
// untouched — rejecting them would be stricter than real Bedrock. Pure/total (throws on unsupported).
const UNSUPPORTED_CONTENT = ['image', 'document', 'video'];
const assertSupportedContent = converseRequest => {
  getOr([], 'messages', converseRequest).forEach(message =>
    getOr([], 'content', message).forEach(block => {
      const unsupported = UNSUPPORTED_CONTENT.find(kind => !isNil(get(kind, block)));
      if (unsupported)
        throw new Error(
          `serverless-offline-bedrock: Converse content block "${unsupported}" is not supported by ` +
            `the offline emulator (text and tool blocks only).`
        );
    })
  );
};

// Converse → backend body. Protocol selects the adapter (validated already by resolveBackend); an
// unsupported multimodal block is rejected before translation (→ 400 ValidationException, not a
// silent drop).
const toBackendRequest = (converseRequest, backend) => {
  assertSupportedContent(converseRequest);
  return backend.protocol === 'anthropic'
    ? toAnthropicRequest(converseRequest, backend)
    : toOpenAiRequest(converseRequest, backend);
};

// backend body → Converse response. `protocol` selects the adapter; `latencyMs` is the measured
// wall-clock of the backend call (Converse `metrics.latencyMs`, a required member).
const fromBackendResponse = (backendResponse, {protocol, latencyMs}) =>
  protocol === 'anthropic'
    ? fromAnthropicResponse(backendResponse, {latencyMs})
    : fromOpenAiResponse(backendResponse, {latencyMs});

// OpenAI Chat Completions live at `<baseUrl>/chat/completions`; Anthropic Messages at
// `<baseUrl>/messages`. baseUrl already carries the `/v1` suffix by convention.
const resolveBackendUrl = backend => {
  const base = backend.baseUrl.replace(/\/$/, '');
  return backend.protocol === 'anthropic' ? `${base}/messages` : `${base}/chat/completions`;
};

// Auth headers differ by protocol: OpenAI-compatible servers read `Authorization: Bearer`,
// Anthropic-compatible servers read `x-api-key` + the required `anthropic-version`. An empty apiKey
// (the local default) sends no auth header — local engines ignore it.
const backendHeaders = backend => {
  const apiKey = backend.apiKey || '';
  if (backend.protocol === 'anthropic')
    return {
      ...(apiKey ? {'x-api-key': apiKey} : {}),
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01'
    };
  return {
    ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
    'content-type': 'application/json'
  };
};

// AC-A4: a backend failure is surfaced as a Bedrock protocol error, NOT a crash. `x-amzn-errortype`
// drives the SDK's exception class; a >=500 status marks a server `$fault` (a local-dependency
// failure), which is what an unreachable/erroring backend is.
const errorResponse = (err, {modelId, backend}) => ({
  statusCode: 502,
  errorType: 'InternalServerException',
  body: {
    message:
      `serverless-offline-bedrock: backend call failed for modelId "${modelId}" ` +
      `(protocol=${backend.protocol}, baseUrl=${backend.baseUrl}): ${err.message}`
  }
});

// The one side effect: POST the translated body to the local backend, measuring wall-clock latency.
// A non-2xx response or a network/timeout error throws (caught by the caller → errorResponse).
// `fetchImpl` is injectable so the orchestration is testable without a live server.
const callBackend = async (backend, body, fetchImpl = fetch) => {
  const url = resolveBackendUrl(backend);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), backend.timeout);
  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: backendHeaders(backend),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`backend responded HTTP ${res.status} ${text}`.trim());
    }
    return {json: await res.json(), latencyMs};
  } finally {
    clearTimeout(timer);
  }
};

// Full orchestration for one Converse call. Returns a protocol-shaped result the hapi route replies
// with verbatim. Never throws — a failure becomes an AC-A4 error result and is logged by the caller.
const handleConverse = async ({modelId, converseRequest, options, fetchImpl}) => {
  let backend;
  let body;
  try {
    backend = resolveBackend(modelId, options);
    // Translation is inside the guard too: a malformed Converse request (e.g. a toolConfig entry
    // missing toolSpec) makes an adapter throw, and that is a client-side bad request — surface it as
    // a 400 ValidationException, never let it escape handleConverse's "never throws" contract (G5/G12).
    body = toBackendRequest(converseRequest, backend);
  } catch (err) {
    // Bad config (unknown protocol / no model) or an untranslatable request is a client-side
    // ValidationException (400), surfaced not thrown so the offline process never crashes (G5).
    return {
      error: err,
      statusCode: 400,
      errorType: 'ValidationException',
      body: {message: err.message}
    };
  }
  try {
    const {json, latencyMs} = await callBackend(backend, body, fetchImpl);
    return {
      statusCode: 200,
      body: fromBackendResponse(json, {protocol: backend.protocol, latencyMs})
    };
  } catch (err) {
    return {...errorResponse(err, {modelId, backend}), error: err};
  }
};

module.exports = {
  assertSupportedContent,
  toBackendRequest,
  fromBackendResponse,
  resolveBackendUrl,
  backendHeaders,
  errorResponse,
  callBackend,
  handleConverse
};
