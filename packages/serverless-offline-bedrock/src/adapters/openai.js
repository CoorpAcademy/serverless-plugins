const {filter, flatMap, get, getOr, isEmpty, isNil, join, map, pipe} = require('lodash/fp');

// serverless-offline-bedrock — OpenAI adapter (pure).
//
// Translates the AWS Bedrock Runtime `Converse` request/response shape to and from the OpenAI
// Chat Completions wire shape (`POST /v1/chat/completions`), the de-facto contract exposed by
// Ollama / LocalAI / llama.cpp / LM Studio / vLLM. Both directions are pure, total helpers
// (constitution G1/G2/G3): they build new objects with lodash/fp and never mutate their inputs.

const DEFAULT_MAX_TOKENS = 4096;

// AWS Converse stopReason enum ⊇ these OpenAI finish_reasons. Mapping is verified against the
// Bedrock Runtime `Converse` schema; anything unrecognized falls back to `end_turn` (the SDK
// requires a non-empty stopReason and `end_turn` is the neutral "model finished" value).
const OPENAI_STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'content_filtered'
};

// Total JSON parse: OpenAI returns `tool_calls[].function.arguments` as a JSON *string* whereas
// Converse `toolUse.input` is an object. A malformed string must not crash offline (G5/G12), so
// fall back to an empty object rather than throwing.
const safeJsonParse = value => {
  if (isNil(value)) return {};
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
};

// A Converse toolResult carries an array of content blocks ({text} | {json}); OpenAI's `tool`
// message wants a single string. Join text blocks; JSON-stringify a json block.
const toolResultToString = pipe(
  getOr([], 'content'),
  map(block => (isNil(get('json', block)) ? getOr('', 'text', block) : JSON.stringify(block.json))),
  join('\n')
);

// A single Converse text block collapses to a plain string (max llama.cpp / LM Studio
// compatibility); multiple blocks become OpenAI content-parts.
const collapseText = textBlocks =>
  textBlocks.length === 1
    ? textBlocks[0].text
    : map(block => ({type: 'text', text: block.text}), textBlocks);

// Converse assistant `toolUse` blocks → OpenAI `tool_calls[]`. `input` (object) is re-serialized to
// the JSON *string* OpenAI expects in `function.arguments`.
const toToolCalls = map(block => ({
  id: block.toolUse.toolUseId,
  type: 'function',
  function: {name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input)}
}));

// One Converse message can expand to several OpenAI messages: user `toolResult` blocks each become
// a standalone `{role:'tool'}` message (OpenAI models tool output as separate turns), while text and
// assistant `toolUse` stay on the original message.
const toOpenAiMessagesFor = message => {
  const content = getOr([], 'content', message);
  const textBlocks = filter(block => !isNil(get('text', block)), content);
  const toolUseBlocks = filter(block => !isNil(get('toolUse', block)), content);
  const toolResultBlocks = filter(block => !isNil(get('toolResult', block)), content);

  const toolMessages = map(
    block => ({
      role: 'tool',
      tool_call_id: block.toolResult.toolUseId,
      content: toolResultToString(block.toolResult)
    }),
    toolResultBlocks
  );

  const baseMessages = [];
  if (message.role === 'assistant' && !isEmpty(toolUseBlocks)) {
    baseMessages.push({
      role: 'assistant',
      content: isEmpty(textBlocks) ? null : collapseText(textBlocks),
      tool_calls: toToolCalls(toolUseBlocks)
    });
  } else if (!isEmpty(textBlocks)) {
    baseMessages.push({role: message.role, content: collapseText(textBlocks)});
  }

  // toolResult blocks arrive on a `user` turn; emit the tool messages first so the assistant's
  // preceding tool_calls are answered before any fresh user text.
  return [...toolMessages, ...baseMessages];
};

// Converse `toolChoice` union → OpenAI `tool_choice`. auto→'auto', any→'required',
// tool→{type:'function',function:{name}} (verified against both schemas).
const toToolChoice = toolChoice => {
  if (isNil(toolChoice)) return undefined;
  if (!isNil(get('any', toolChoice))) return 'required';
  if (!isNil(get('tool', toolChoice)))
    return {type: 'function', function: {name: toolChoice.tool.name}};
  return 'auto';
};

const toTools = pipe(
  getOr([], ['toolConfig', 'tools']),
  map(({toolSpec}) => ({
    type: 'function',
    function: {
      name: toolSpec.name,
      description: toolSpec.description,
      parameters: get(['inputSchema', 'json'], toolSpec)
    }
  }))
);

// Converse request → OpenAI Chat Completions body. `system[].text` blocks are joined with `\n` into
// a single prepended `{role:'system'}` message; inferenceConfig maps to max_tokens/temperature/
// top_p/stop; always `stream:false` (streaming is out of MVP scope).
const toOpenAiRequest = (converseRequest, backend) => {
  const systemText = pipe(getOr([], 'system'), map('text'), join('\n'))(converseRequest);
  const systemMessages = isEmpty(systemText) ? [] : [{role: 'system', content: systemText}];

  const messages = [
    ...systemMessages,
    ...flatMap(toOpenAiMessagesFor, getOr([], 'messages', converseRequest))
  ];

  const inference = getOr({}, 'inferenceConfig', converseRequest);
  const tools = toTools(converseRequest);
  const toolChoice = toToolChoice(get(['toolConfig', 'toolChoice'], converseRequest));

  return {
    ...(isNil(inference.maxTokens) ? {} : {max_tokens: inference.maxTokens}),
    ...(isNil(inference.temperature) ? {} : {temperature: inference.temperature}),
    ...(isNil(inference.topP) ? {} : {top_p: inference.topP}),
    ...(isNil(inference.stopSequences) ? {} : {stop: inference.stopSequences}),
    ...(isEmpty(tools) ? {} : {tools}),
    ...(isNil(toolChoice) ? {} : {tool_choice: toolChoice}),
    model: backend.model,
    messages,
    stream: false
  };
};

// OpenAI message → Converse content blocks. A string `content` becomes one text block; `tool_calls`
// each become a `toolUse` block whose JSON-string arguments are parsed back to an object.
const toConverseContent = message => {
  const textBlocks = isEmpty(getOr('', 'content', message)) ? [] : [{text: message.content}];
  const toolUseBlocks = map(
    tc => ({
      toolUse: {
        toolUseId: tc.id,
        name: get(['function', 'name'], tc),
        input: safeJsonParse(get(['function', 'arguments'], tc))
      }
    }),
    getOr([], 'tool_calls', message)
  );
  const blocks = [...textBlocks, ...toolUseBlocks];
  // Converse requires a non-empty content array; a bare stop with no text still needs one block.
  return isEmpty(blocks) ? [{text: ''}] : blocks;
};

// OpenAI Chat Completions response → Converse response. Usage keys differ (prompt/completion/total);
// missing usage coerces to 0 (all three are required members of the Converse `usage` shape).
const fromOpenAiResponse = (openAiResponse, {latencyMs}) => {
  const choice = getOr({}, ['choices', 0], openAiResponse);
  const usage = getOr({}, 'usage', openAiResponse);
  return {
    output: {
      message: {role: 'assistant', content: toConverseContent(getOr({}, 'message', choice))}
    },
    stopReason: getOr('end_turn', choice.finish_reason, OPENAI_STOP_REASON),
    usage: {
      inputTokens: getOr(0, 'prompt_tokens', usage),
      outputTokens: getOr(0, 'completion_tokens', usage),
      totalTokens: getOr(0, 'total_tokens', usage)
    },
    metrics: {latencyMs}
  };
};

module.exports = {
  DEFAULT_MAX_TOKENS,
  OPENAI_STOP_REASON,
  safeJsonParse,
  toolResultToString,
  toOpenAiRequest,
  fromOpenAiResponse
};
