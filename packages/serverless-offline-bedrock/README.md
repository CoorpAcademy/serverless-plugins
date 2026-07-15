# serverless-offline-bedrock

This [Serverless-offline](https://github.com/dherault/serverless-offline) plugin emulates **Amazon
Bedrock Runtime** (`Converse`, non-streaming) on your local machine, so code that calls
`BedrockRuntimeClient` runs fully offline — no AWS account, no network, no cloud cost. Each incoming
Bedrock call is translated to a **developer-provided local LLM** (OpenAI- _or_ Anthropic-compatible),
exactly as `serverless-offline-sqs` translates SQS calls to ElasticMQ.

_Scope (MVP):_ non-streaming `Converse`. Streaming (`ConverseStream`) and `InvokeModel` are out of
scope for now.

> **Requirements:** Node.js **≥ 20** (the bundled AWS SDK v3 requires it).

## How it works

The plugin stands up a local HTTP server speaking the Bedrock Runtime wire protocol and, in
`offline:start:init`, injects the AWS SDK v3 endpoint environment variable
`AWS_ENDPOINT_URL_BEDROCK_RUNTIME` **before** the offline Lambda runtime snapshots each function's
environment. Your **unmodified** `BedrockRuntimeClient` therefore resolves to `localhost` with **no
application code change**.

> **HTTP/2 note:** the `@aws-sdk/client-bedrock-runtime` client dials its endpoint over cleartext
> HTTP/2 (h2c). This emulator uses Node's built-in `http2` server accordingly and is **h2c-only** by
> design: the SDK's default `NodeHttp2Handler` is the supported client. A plain HTTP/1.1 client is
> not supported (on cleartext there is no ALPN, so the server always replies with HTTP/2 framing). No
> configuration is needed.

Each `Converse` request is:

1. routed by model id (`POST /model/{modelId}/converse`),
2. translated to the configured backend's request shape (OpenAI `/v1/chat/completions` or Anthropic
   `/v1/messages`), including `system`, tools, tool-use / tool-result, and inference parameters,
3. forwarded to your local LLM,
4. translated back into a valid Bedrock `Converse` response (`output`, `stopReason`, `usage`,
   `metrics`).

## Prerequisites

A local LLM server exposing an **OpenAI-compatible** (`/v1/chat/completions`) _or_
**Anthropic-compatible** (`/v1/messages`) HTTP API. Any of these work:

- [Ollama](https://ollama.com) (`http://localhost:11434/v1`) — OpenAI-compatible
- [LM Studio](https://lmstudio.ai), [LocalAI](https://localai.io), llama.cpp `server`, vLLM —
  OpenAI-compatible
- [LiteLLM](https://github.com/BerriAI/litellm) / an Anthropic proxy — Anthropic-compatible

The LLM itself is **not** bundled (a developer prerequisite, like ElasticMQ for SQS).

## Installation

```sh
npm install --save-dev serverless-offline-bedrock
```

Add it to your `serverless.yml` plugins **before** `serverless-offline`:

```yml
plugins:
  - serverless-offline-bedrock
  - serverless-offline
```

## Configuration

```yml
custom:
  serverless-offline-bedrock:
    enabled: true                          # set false (or "false") to skip the emulator entirely
    host: 0.0.0.0
    port: 4019
    backend:                               # the DEFAULT backend, used when a modelId has no override
      protocol: openai                     # 'openai' | 'anthropic'
      baseUrl: http://localhost:11434/v1   # your local LLM
      model: llama3.1                      # the local model that answers
      apiKey: ''                           # optional; sent as Bearer / x-api-key when set
      defaultMaxTokens: 4096               # injected for Anthropic when a request omits maxTokens
      timeout: 120000                      # backend call timeout (ms)
    models:                                # optional per-modelId overrides (key = the exact AWS modelId)
      anthropic.claude-3-5-sonnet-20240620-v1:0:
        protocol: anthropic
        baseUrl: http://localhost:4000/v1
        model: claude-3-5-sonnet-local
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | `false` / `"false"` skips standing up the server (other offline behavior untouched). |
| `host` / `port` | `0.0.0.0` / `4019` | Bind address of the local Bedrock endpoint. |
| `backend.protocol` | `openai` | `openai` or `anthropic` — selects the request/response translation. |
| `backend.baseUrl` | `http://localhost:11434/v1` | Base URL of the local LLM (the `/chat/completions` or `/messages` suffix is added). |
| `backend.model` | — | The local model name sent to the backend. Required (default or per-model). |
| `backend.apiKey` | `''` | Optional auth; empty sends no auth header (local engines ignore it). |
| `backend.defaultMaxTokens` | `4096` | Anthropic requires `max_tokens`; injected when a Converse request omits it. |
| `backend.timeout` | `120000` | Backend request timeout in ms. |
| `models.<modelId>` | — | Per-model override, **deep-merged over** `backend` (unset fields inherit). |

**Precedence:** a per-`modelId` entry under `models` is deep-merged over `backend`; an override only
needs the fields it changes. An explicit YAML `AWS_ENDPOINT_URL_BEDROCK_RUNTIME` in your
`provider.environment` still wins over the injected default (standard AWS endpoint resolution).

## Behavior notes

- **Model mapping (AC-A3):** unknown model ids fall back to `backend`. Unknown `protocol` fails fast
  naming the model id.
- **Errors (AC-A4):** an unreachable/erroring backend returns a Bedrock error naming the backend and
  model id (`x-amzn-errortype`), logged via the injected logger — it **never crashes** offline.
- **Inference params (AC-A5):** `maxTokens`, `temperature`, `topP`, `stopSequences` are forwarded to
  the backend equivalents.
- These are **local-development / CI** tools: the goal is a protocol-faithful substitute, not
  Bedrock output parity.

## Copy-paste example

```yml
service: my-service

plugins:
  - serverless-offline-bedrock
  - serverless-offline

provider:
  name: aws
  runtime: nodejs18.x

custom:
  serverless-offline-bedrock:
    backend:
      protocol: openai
      baseUrl: http://localhost:11434/v1
      model: llama3.1

functions:
  translate:
    handler: handler.translate
    events:
      - httpApi: 'POST /translate'
```

```js
// handler.js — unchanged production code
const {BedrockRuntimeClient, ConverseCommand} = require('@aws-sdk/client-bedrock-runtime');
const client = new BedrockRuntimeClient({}); // resolves to localhost:4019 offline

exports.translate = async event => {
  const {text} = JSON.parse(event.body);
  const out = await client.send(
    new ConverseCommand({
      modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
      messages: [{role: 'user', content: [{text: `Translate to French: ${text}`}]}]
    })
  );
  return {statusCode: 200, body: out.output.message.content[0].text};
};
```

```sh
ollama serve && ollama pull llama3.1     # start the local LLM
serverless offline                        # everything runs on localhost
```

## License

MIT
