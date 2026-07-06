const http2 = require('http2');
const {normalizeLog} = require('./log');
const {handleConverse} = require('./converse');

// serverless-offline-bedrock — local Bedrock Runtime HTTP server (thin orchestrator).
//
// Speaks the Bedrock Runtime restJson protocol the unmodified AWS SDK v3 emits and delegates all
// translation to the pure `converse` / adapter helpers. Mirrors the sibling emulator classes
// (`SQS`, `S3`): a thin class wiring the server to pure logic + one side effect (the backend call).
//
// IMPORTANT (verified by SPIKE 1): the `@aws-sdk/client-bedrock-runtime` client's default
// requestHandler is `NodeHttp2Handler` — it dials the endpoint over cleartext HTTP/2 (h2c), NOT
// HTTP/1.1. @hapi/hapi cannot serve h2c, so this emulator uses Node's built-in `http2` server with
// `allowHTTP1:true` (so a stray HTTP/1.1 probe still gets an answer). This is the one deviation from
// the sibling plugins' @hapi/hapi choice, forced by the SDK's wire protocol.

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 4019;

// Bedrock Runtime restJson Converse path. {modelId} arrives percent-encoded (`:`→`%3A`, `/`→`%2F`
// via the SDK's extendedEncodeURIComponent). Capture the raw segment; decode it before backend
// lookup. NOTE (verified): restJson uses a REST path — there is deliberately no `X-Amz-Target`
// header (contrast serverless-offline-transcribe's awsJson protocol).
const CONVERSE_PATH = /^\/model\/([^/]+)\/converse\/?$/;

// {modelId} decode: total/guarded — a malformed percent-sequence returns the raw value rather than
// throwing (G12).
const decodeModelId = raw => {
  try {
    return decodeURIComponent(raw);
  } catch (err) {
    return raw;
  }
};

// Match the Converse route on a request path, returning the decoded modelId or null. Pure.
const matchConverse = path => {
  const match = CONVERSE_PATH.exec((path || '').split('?')[0]);
  return match ? decodeModelId(match[1]) : null;
};

// Total JSON parse of the request body — a malformed body must not crash offline (G5/G12).
const parseBody = raw => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
};

// Write a protocol-shaped reply. x-amzn-errortype drives the SDK's exception class on the error path.
const writeReply = (res, {statusCode, errorType, body}) => {
  const headers = {'content-type': 'application/json'};
  if (errorType) headers['x-amzn-errortype'] = errorType;
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
};

class Bedrock {
  constructor(options, log) {
    this.options = options;
    this.log = normalizeLog(log);

    this.host = options.host || DEFAULT_HOST;
    this.port = Number(options.port) || DEFAULT_PORT;

    // Track live h2 sessions: the SDK's NodeHttp2Handler pools and keeps sessions open, so a bare
    // server.close() would hang forever — we destroy them on stop() to release the port (AC-X2).
    this.sessions = new Set();

    this.server = http2.createServer({allowHTTP1: true});
    this.server.on('session', session => {
      this.sessions.add(session);
      session.on('close', () => this.sessions.delete(session));
    });
    this.server.on('request', this._onRequest.bind(this));
  }

  _onRequest(req, res) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      this._route(req, res, Buffer.concat(chunks).toString()).catch(err => {
        // Belt-and-suspenders: any unexpected error is logged and answered as a 500, never crashes
        // the offline process (G5). log.warning, never log.warn (G13).
        this.log.warning(`serverless-offline-bedrock: unhandled request error: ${err.stack}`);
        writeReply(res, {
          statusCode: 500,
          errorType: 'InternalServerException',
          body: {message: err.message}
        });
      });
    });
  }

  async _route(req, res, rawBody) {
    const modelId = matchConverse(req.url);

    if (req.method !== 'POST' || modelId === null) {
      writeReply(res, {
        statusCode: 404,
        errorType: 'ResourceNotFoundException',
        body: {message: `serverless-offline-bedrock: no route for ${req.method} ${req.url}`}
      });
      return;
    }

    const result = await handleConverse({
      modelId,
      converseRequest: parseBody(rawBody),
      options: this.options,
      fetchImpl: this.options.fetchImpl
    });

    // AC-A4: a backend/config failure is logged and returned as a protocol error, so one bad
    // request never crashes the offline session (G5).
    if (result.error) this.log.warning(result.body.message);

    writeReply(res, result);
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.log.notice(`Bedrock Runtime emulator listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    // AC-X2: destroy the pooled h2 sessions first (else close() never fires), then release the port.
    this.sessions.forEach(session => session.destroy());
    this.sessions.clear();
    await new Promise(resolve => {
      this.server.close(() => resolve());
    });
  }
}

module.exports = Bedrock;
module.exports.decodeModelId = decodeModelId;
module.exports.matchConverse = matchConverse;
module.exports.parseBody = parseBody;
module.exports.DEFAULT_HOST = DEFAULT_HOST;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
