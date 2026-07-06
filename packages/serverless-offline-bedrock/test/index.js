const http = require('http');
const test = require('ava');

const {defaultLog, normalizeLog} = require('../src/log');
const {
  toOpenAiRequest,
  fromOpenAiResponse,
  safeJsonParse,
  toolResultToString,
  OPENAI_STOP_REASON
} = require('../src/adapters/openai');
const {toAnthropicRequest, fromAnthropicResponse} = require('../src/adapters/anthropic');
const {resolveBackend, DEFAULT_BACKEND} = require('../src/backend-config');
const {
  toBackendRequest,
  fromBackendResponse,
  resolveBackendUrl,
  backendHeaders,
  errorResponse,
  handleConverse
} = require('../src/converse');
const Bedrock = require('../src/bedrock');
const {decodeModelId, matchConverse, parseBody} = require('../src/bedrock');
const ServerlessOfflineBedrock = require('../src');
const {defaultOptions, isPluginEnabled, resolveEndpointUrl} = require('../src');

// ---------------------------------------------------------------------------
// log.js (copied byte-for-byte from sibling plugins — regression guard)
// ---------------------------------------------------------------------------

test('normalizeLog exposes warning (not warn) and does not mutate the injected logger (G13)', t => {
  const injected = {notice: () => {}};
  const log = normalizeLog(injected);
  t.is(typeof log.warning, 'function');
  t.is(log.warn, undefined);
  // normalizeLog must not mutate the injected logger (G13): it stays a bare {notice}.
  t.deepEqual(Object.keys(injected), ['notice']);
});

test('defaultLog has the expected surface', t => {
  t.deepEqual(Object.keys(defaultLog).sort(), [
    'debug',
    'error',
    'info',
    'notice',
    'success',
    'warning'
  ]);
});

// ---------------------------------------------------------------------------
// OpenAI adapter — request translation (AC-A2/A5)
// ---------------------------------------------------------------------------

const OPENAI_BACKEND = {
  protocol: 'openai',
  model: 'llama3.1',
  baseUrl: 'http://localhost:11434/v1'
};

test('toOpenAiRequest joins system blocks and collapses a single text block to a string', t => {
  const req = toOpenAiRequest(
    {
      system: [{text: 'You are helpful.'}, {text: 'Be concise.'}],
      messages: [{role: 'user', content: [{text: 'Hi'}]}]
    },
    OPENAI_BACKEND
  );
  t.deepEqual(req.messages[0], {role: 'system', content: 'You are helpful.\nBe concise.'});
  t.deepEqual(req.messages[1], {role: 'user', content: 'Hi'});
  t.is(req.model, 'llama3.1');
  t.false(req.stream);
});

test('toOpenAiRequest maps inferenceConfig to max_tokens/temperature/top_p/stop (AC-A5)', t => {
  const req = toOpenAiRequest(
    {
      messages: [{role: 'user', content: [{text: 'Hi'}]}],
      inferenceConfig: {maxTokens: 256, temperature: 0.3, topP: 0.9, stopSequences: ['END']}
    },
    OPENAI_BACKEND
  );
  t.is(req.max_tokens, 256);
  t.is(req.temperature, 0.3);
  t.is(req.top_p, 0.9);
  t.deepEqual(req.stop, ['END']);
});

test('toOpenAiRequest maps tools + toolChoice (any→required, tool→function)', t => {
  const converse = {
    messages: [{role: 'user', content: [{text: 'Hi'}]}],
    toolConfig: {
      tools: [
        {toolSpec: {name: 'get_weather', description: 'w', inputSchema: {json: {type: 'object'}}}}
      ],
      toolChoice: {any: {}}
    }
  };
  const req = toOpenAiRequest(converse, OPENAI_BACKEND);
  t.deepEqual(req.tools[0], {
    type: 'function',
    function: {name: 'get_weather', description: 'w', parameters: {type: 'object'}}
  });
  t.is(req.tool_choice, 'required');

  const withTool = toOpenAiRequest(
    {...converse, toolConfig: {...converse.toolConfig, toolChoice: {tool: {name: 'get_weather'}}}},
    OPENAI_BACKEND
  );
  t.deepEqual(withTool.tool_choice, {type: 'function', function: {name: 'get_weather'}});
});

test('toOpenAiRequest serializes assistant toolUse to a tool_calls JSON string', t => {
  const req = toOpenAiRequest(
    {
      messages: [
        {
          role: 'assistant',
          content: [{toolUse: {toolUseId: 'tu1', name: 'get_weather', input: {city: 'Paris'}}}]
        }
      ]
    },
    OPENAI_BACKEND
  );
  t.deepEqual(req.messages[0], {
    role: 'assistant',
    content: null,
    tool_calls: [
      {id: 'tu1', type: 'function', function: {name: 'get_weather', arguments: '{"city":"Paris"}'}}
    ]
  });
});

test('toOpenAiRequest splits a user toolResult into a standalone {role:tool} message', t => {
  const req = toOpenAiRequest(
    {
      messages: [
        {
          role: 'user',
          content: [{toolResult: {toolUseId: 'tu1', content: [{text: 'sunny'}], status: 'success'}}]
        }
      ]
    },
    OPENAI_BACKEND
  );
  t.deepEqual(req.messages, [{role: 'tool', tool_call_id: 'tu1', content: 'sunny'}]);
});

test('toolResultToString joins text blocks and stringifies json blocks', t => {
  t.is(toolResultToString({content: [{text: 'a'}, {json: {b: 1}}]}), 'a\n{"b":1}');
});

// ---------------------------------------------------------------------------
// OpenAI adapter — response translation (AC-A2)
// ---------------------------------------------------------------------------

test('fromOpenAiResponse maps content, stopReason and usage', t => {
  const converse = fromOpenAiResponse(
    {
      choices: [{message: {role: 'assistant', content: 'Bonjour'}, finish_reason: 'stop'}],
      usage: {prompt_tokens: 10, completion_tokens: 3, total_tokens: 13}
    },
    {latencyMs: 42}
  );
  t.deepEqual(converse.output.message.content, [{text: 'Bonjour'}]);
  t.is(converse.stopReason, 'end_turn');
  t.deepEqual(converse.usage, {inputTokens: 10, outputTokens: 3, totalTokens: 13});
  t.is(converse.metrics.latencyMs, 42);
});

test('fromOpenAiResponse maps finish_reason table and defaults to end_turn', t => {
  t.is(OPENAI_STOP_REASON.length, 'max_tokens');
  const toolCalls = fromOpenAiResponse(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{id: 't1', function: {name: 'f', arguments: '{"x":1}'}}]
          },
          finish_reason: 'tool_calls'
        }
      ]
    },
    {latencyMs: 1}
  );
  t.is(toolCalls.stopReason, 'tool_use');
  t.deepEqual(toolCalls.output.message.content, [
    {toolUse: {toolUseId: 't1', name: 'f', input: {x: 1}}}
  ]);
  // Unknown finish_reason → end_turn fallback; missing usage → 0.
  const unknown = fromOpenAiResponse(
    {choices: [{message: {content: 'x'}, finish_reason: 'weird'}]},
    {latencyMs: 1}
  );
  t.is(unknown.stopReason, 'end_turn');
  t.deepEqual(unknown.usage, {inputTokens: 0, outputTokens: 0, totalTokens: 0});
});

test('safeJsonParse is total — bad JSON yields {} not a throw (G12)', t => {
  t.deepEqual(safeJsonParse('{"a":1}'), {a: 1});
  t.deepEqual(safeJsonParse('not json'), {});
  t.deepEqual(safeJsonParse(undefined), {});
});

// ---------------------------------------------------------------------------
// Anthropic adapter (AC-A2/A5)
// ---------------------------------------------------------------------------

const ANTHROPIC_BACKEND = {
  protocol: 'anthropic',
  model: 'claude-local',
  baseUrl: 'http://localhost:4000/v1',
  defaultMaxTokens: 4096
};

test('toAnthropicRequest joins system, keeps toolUse input as an object, defaults max_tokens', t => {
  const req = toAnthropicRequest(
    {
      system: [{text: 'sys'}],
      messages: [
        {role: 'user', content: [{text: 'Hi'}]},
        {
          role: 'assistant',
          content: [{toolUse: {toolUseId: 'tu1', name: 'f', input: {a: 1}}}]
        }
      ]
    },
    ANTHROPIC_BACKEND
  );
  t.is(req.system, 'sys');
  // Anthropic requires max_tokens; Converse omitted it → backend.defaultMaxTokens injected.
  t.is(req.max_tokens, 4096);
  t.deepEqual(req.messages[1].content[0], {type: 'tool_use', id: 'tu1', name: 'f', input: {a: 1}});
});

test('toAnthropicRequest maps toolResult with is_error and stop_sequences', t => {
  const req = toAnthropicRequest(
    {
      messages: [
        {
          role: 'user',
          content: [{toolResult: {toolUseId: 'tu1', content: [{text: 'boom'}], status: 'error'}}]
        }
      ],
      inferenceConfig: {maxTokens: 10, stopSequences: ['X']}
    },
    ANTHROPIC_BACKEND
  );
  t.deepEqual(req.messages[0].content[0], {
    type: 'tool_result',
    tool_use_id: 'tu1',
    content: [{type: 'text', text: 'boom'}],
    is_error: true
  });
  t.deepEqual(req.stop_sequences, ['X']);
  t.is(req.max_tokens, 10);
});

test('fromAnthropicResponse computes totalTokens = input + output and passes stop_reason through', t => {
  const converse = fromAnthropicResponse(
    {
      content: [{type: 'text', text: 'Salut'}],
      stop_reason: 'max_tokens',
      usage: {input_tokens: 7, output_tokens: 4}
    },
    {latencyMs: 9}
  );
  t.deepEqual(converse.output.message.content, [{text: 'Salut'}]);
  t.is(converse.stopReason, 'max_tokens');
  t.deepEqual(converse.usage, {inputTokens: 7, outputTokens: 4, totalTokens: 11});
  // pause_turn has no Converse equivalent → end_turn.
  t.is(
    fromAnthropicResponse({content: [], stop_reason: 'pause_turn'}, {latencyMs: 1}).stopReason,
    'end_turn'
  );
});

// ---------------------------------------------------------------------------
// backend-config: resolveBackend (AC-A3)
// ---------------------------------------------------------------------------

test('resolveBackend deep-merges a per-modelId override over the default backend (AC-A3)', t => {
  const options = {
    backend: {protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1'},
    models: {
      'anthropic.claude-3-5-sonnet-20240620-v1:0': {
        protocol: 'anthropic',
        baseUrl: 'http://localhost:4000/v1',
        model: 'claude-local'
      }
    }
  };
  const overridden = resolveBackend('anthropic.claude-3-5-sonnet-20240620-v1:0', options);
  t.is(overridden.protocol, 'anthropic');
  t.is(overridden.model, 'claude-local');
  // A modelId with no override falls back to the default backend (AC-A3).
  const fallback = resolveBackend('meta.llama3-70b-instruct-v1:0', options);
  t.is(fallback.protocol, 'openai');
  t.is(fallback.model, 'llama3.1');
});

test('resolveBackend inherits unset override fields from the default backend', t => {
  const options = {
    backend: {protocol: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1'},
    models: {'m:0': {model: 'mistral'}} // only model overridden
  };
  const resolved = resolveBackend('m:0', options);
  t.is(resolved.model, 'mistral');
  t.is(resolved.protocol, 'openai'); // inherited
  t.is(resolved.baseUrl, 'http://localhost:11434/v1'); // inherited
});

test('resolveBackend fails fast on an unknown protocol, naming the modelId (G12/AC-A4)', t => {
  const err = t.throws(() => resolveBackend('m:0', {backend: {protocol: 'grpc', model: 'x'}}));
  t.true(err.message.includes('grpc'));
  t.true(err.message.includes('m:0'));
});

test('resolveBackend fails fast when no model is configured', t => {
  const err = t.throws(() => resolveBackend('m:0', {backend: {protocol: 'openai'}}));
  t.true(err.message.includes('m:0'));
  t.is(DEFAULT_BACKEND.protocol, 'openai');
});

// ---------------------------------------------------------------------------
// converse orchestration (AC-A2/A4)
// ---------------------------------------------------------------------------

test('resolveBackendUrl targets the protocol-specific path', t => {
  t.is(
    resolveBackendUrl({protocol: 'openai', baseUrl: 'http://h/v1'}),
    'http://h/v1/chat/completions'
  );
  t.is(resolveBackendUrl({protocol: 'anthropic', baseUrl: 'http://h/v1/'}), 'http://h/v1/messages');
});

test('backendHeaders sets the protocol-appropriate auth headers', t => {
  t.deepEqual(backendHeaders({protocol: 'openai', apiKey: 'k'}), {
    'content-type': 'application/json',
    authorization: 'Bearer k'
  });
  t.deepEqual(backendHeaders({protocol: 'anthropic', apiKey: 'k'}), {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'x-api-key': 'k'
  });
  // Empty apiKey → no auth header (local engines ignore it).
  t.deepEqual(backendHeaders({protocol: 'openai', apiKey: ''}), {
    'content-type': 'application/json'
  });
});

test('toBackendRequest / fromBackendResponse dispatch on protocol', t => {
  const openai = toBackendRequest({messages: []}, OPENAI_BACKEND);
  t.false(openai.stream);
  const anthropic = toBackendRequest({messages: []}, ANTHROPIC_BACKEND);
  t.is(anthropic.max_tokens, 4096);
  t.is(
    fromBackendResponse(
      {content: [{type: 'text', text: 'x'}]},
      {protocol: 'anthropic', latencyMs: 1}
    ).output.message.content[0].text,
    'x'
  );
});

test('errorResponse names the backend and modelId, marks a server fault (AC-A4)', t => {
  const res = errorResponse(new Error('ECONNREFUSED'), {
    modelId: 'm:0',
    backend: {protocol: 'openai', baseUrl: 'http://localhost:11434/v1'}
  });
  t.is(res.statusCode, 502);
  t.is(res.errorType, 'InternalServerException');
  t.true(res.body.message.includes('m:0'));
  t.true(res.body.message.includes('http://localhost:11434/v1'));
});

test('handleConverse returns an AC-A4 error result (not a throw) on backend failure', async t => {
  const fetchImpl = () => Promise.reject(new Error('connect ECONNREFUSED'));
  const result = await handleConverse({
    modelId: 'm:0',
    converseRequest: {messages: [{role: 'user', content: [{text: 'hi'}]}]},
    options: {
      backend: {
        protocol: 'openai',
        model: 'llama3.1',
        baseUrl: 'http://localhost:11434/v1',
        timeout: 100
      }
    },
    fetchImpl
  });
  t.is(result.statusCode, 502);
  t.truthy(result.error);
  t.true(result.body.message.includes('ECONNREFUSED'));
});

test('handleConverse surfaces a config error as a 400 ValidationException (never crashes, G5)', async t => {
  const result = await handleConverse({
    modelId: 'm:0',
    converseRequest: {messages: []},
    options: {backend: {protocol: 'grpc', model: 'x'}}
  });
  t.is(result.statusCode, 400);
  t.is(result.errorType, 'ValidationException');
});

test('handleConverse translates a successful OpenAI backend round-trip (AC-A2)', async t => {
  const fetchImpl = (url, init) => {
    t.true(url.endsWith('/chat/completions'));
    t.deepEqual(JSON.parse(init.body).messages, [{role: 'user', content: 'hi'}]);
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{message: {content: 'yo'}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}
        })
    });
  };
  const result = await handleConverse({
    modelId: 'm:0',
    converseRequest: {messages: [{role: 'user', content: [{text: 'hi'}]}]},
    options: {
      backend: {
        protocol: 'openai',
        model: 'llama3.1',
        baseUrl: 'http://localhost:11434/v1',
        timeout: 1000
      }
    },
    fetchImpl
  });
  t.is(result.statusCode, 200);
  t.deepEqual(result.body.output.message.content, [{text: 'yo'}]);
  t.is(result.body.stopReason, 'end_turn');
});

// ---------------------------------------------------------------------------
// bedrock.js pure helpers
// ---------------------------------------------------------------------------

test('decodeModelId url-decodes and is total on bad input', t => {
  t.is(
    decodeModelId('anthropic.claude-3-5-sonnet-20240620-v1%3A0'),
    'anthropic.claude-3-5-sonnet-20240620-v1:0'
  );
  t.is(decodeModelId('%ZZ'), '%ZZ'); // malformed → raw, no throw
});

test('matchConverse extracts the decoded modelId or null', t => {
  t.is(matchConverse('/model/anthropic.claude-v1%3A0/converse'), 'anthropic.claude-v1:0');
  t.is(matchConverse('/model/m%3A0/converse?x=1'), 'm:0');
  t.is(matchConverse('/model/m/invoke'), null);
  t.is(matchConverse('/health'), null);
});

test('parseBody is total', t => {
  t.deepEqual(parseBody('{"a":1}'), {a: 1});
  t.deepEqual(parseBody('bad'), {});
  t.deepEqual(parseBody(''), {});
});

// ---------------------------------------------------------------------------
// index.js plugin (AC-A1/X1)
// ---------------------------------------------------------------------------

test('isPluginEnabled honors enabled:false and the string "false" (AC-X1)', t => {
  t.true(isPluginEnabled({}));
  t.true(isPluginEnabled({enabled: true}));
  t.false(isPluginEnabled({enabled: false}));
  t.false(isPluginEnabled({enabled: 'false'}));
  t.is(defaultOptions.port, 4019);
});

test('resolveEndpointUrl maps a 0.0.0.0 bind host to a connectable localhost URL (AC-A1)', t => {
  t.is(resolveEndpointUrl({host: '0.0.0.0', port: 4019}), 'http://localhost:4019');
  t.is(resolveEndpointUrl({host: '127.0.0.1', port: 5000}), 'http://127.0.0.1:5000');
  t.is(resolveEndpointUrl({}), 'http://localhost:4019');
});

test('the plugin exposes the four offline hooks', t => {
  const plugin = new ServerlessOfflineBedrock({}, {}, {log: defaultLog});
  t.deepEqual(Object.keys(plugin.hooks).sort(), [
    'offline:start',
    'offline:start:end',
    'offline:start:init',
    'offline:start:ready'
  ]);
});

// ---------------------------------------------------------------------------
// SPIKE 1 (AC-A1) — end-to-end: the UNMODIFIED Bedrock SDK, with only the endpoint env var our
// plugin injects, dials our local h2 server and parses our Converse body. This is the load-bearing
// integration proof; it also verifies the Bedrock Runtime client speaks HTTP/2 (h2c).
// ---------------------------------------------------------------------------

test.serial(
  'SPIKE 1: unmodified BedrockRuntimeClient reaches the Bedrock emulator via injected endpoint (AC-A1/A2)',
  async t => {
    // Local OpenAI-compatible backend stub the emulator will call.
    const backend = http.createServer((req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(
        JSON.stringify({
          choices: [{message: {role: 'assistant', content: 'bonjour'}, finish_reason: 'stop'}],
          usage: {prompt_tokens: 5, completion_tokens: 2, total_tokens: 7}
        })
      );
    });
    await new Promise(resolve => {
      backend.listen(0, resolve);
    });
    const backendPort = backend.address().port;

    const emulator = new Bedrock(
      {
        host: '127.0.0.1',
        port: 4019,
        backend: {
          protocol: 'openai',
          model: 'llama3.1',
          baseUrl: `http://127.0.0.1:${backendPort}/v1`,
          timeout: 5000
        }
      },
      defaultLog
    );
    await emulator.start();

    // Inject EXACTLY as the plugin's start() does, before constructing the client.
    const prev = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = resolveEndpointUrl({
      host: '127.0.0.1',
      port: 4019
    });
    process.env.AWS_REGION = process.env.AWS_REGION || 'us-east-1';
    process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || 'local';
    process.env.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || 'local';

    const {BedrockRuntimeClient, ConverseCommand} = require('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({}); // unmodified: no endpoint option, no app code change

    try {
      const out = await client.send(
        new ConverseCommand({
          modelId: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
          messages: [{role: 'user', content: [{text: 'hi'}]}]
        })
      );
      t.is(out.stopReason, 'end_turn');
      t.is(out.output.message.content[0].text, 'bonjour');
      t.is(out.usage.totalTokens, 7);
    } finally {
      client.destroy();
      if (prev === undefined) delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
      else process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = prev;
      await emulator.stop();
      await new Promise(resolve => {
        backend.close(resolve);
      });
    }
  }
);
