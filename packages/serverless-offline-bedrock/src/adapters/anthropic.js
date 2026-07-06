const {filter, get, getOr, isEmpty, isNil, join, map, pipe} = require('lodash/fp');

// serverless-offline-bedrock — Anthropic adapter (pure).
//
// Translates AWS Bedrock Runtime `Converse` to and from the Anthropic Messages wire shape
// (`POST /v1/messages`), exposed by Anthropic-compatible local gateways (LiteLLM, Claude-proxy).
// Converse is modeled directly on the Anthropic Messages API, so the mapping is near-isomorphic.
// Pure, total helpers (G1/G2/G3): new objects via lodash/fp, inputs never mutated.

const DEFAULT_MAX_TOKENS = 4096;

// Anthropic stop_reason enum: end_turn/max_tokens/stop_sequence/tool_use pass straight through
// to Converse; pause_turn/refusal have no Converse equivalent and collapse to end_turn (the SDK
// requires a non-empty stopReason).
const ANTHROPIC_STOP_REASON = {
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  tool_use: 'tool_use',
  pause_turn: 'end_turn',
  refusal: 'end_turn'
};

// A Converse toolResult content array ({text} | {json}) → the Anthropic tool_result `content` list.
// Text blocks become {type:'text'}; a json block is JSON-stringified into a text block.
const toolResultContent = pipe(
  getOr([], 'content'),
  map(block =>
    isNil(get('json', block))
      ? {type: 'text', text: getOr('', 'text', block)}
      : {type: 'text', text: JSON.stringify(block.json)}
  )
);

// One Converse message → one Anthropic message. Each Converse content block maps to its Anthropic
// counterpart: text→{type:'text'}, toolUse→{type:'tool_use'} (input stays an OBJECT, unlike OpenAI's
// JSON string), toolResult→{type:'tool_result', is_error:(status==='error')}.
const toAnthropicContentBlock = block => {
  if (!isNil(get('text', block))) return {type: 'text', text: block.text};
  if (!isNil(get('toolUse', block)))
    return {
      type: 'tool_use',
      id: block.toolUse.toolUseId,
      name: block.toolUse.name,
      input: block.toolUse.input
    };
  if (!isNil(get('toolResult', block)))
    return {
      type: 'tool_result',
      tool_use_id: block.toolResult.toolUseId,
      content: toolResultContent(block.toolResult),
      // Converse toolResult.status is 'success' | 'error'; Anthropic flags failures with is_error.
      is_error: get(['toolResult', 'status'], block) === 'error'
    };
  return undefined;
};

const toAnthropicMessage = message => ({
  role: message.role,
  content: pipe(getOr([], 'content'), map(toAnthropicContentBlock), filter(Boolean))(message)
});

const toTools = pipe(
  getOr([], ['toolConfig', 'tools']),
  map(({toolSpec}) => ({
    name: toolSpec.name,
    description: toolSpec.description,
    input_schema: get(['inputSchema', 'json'], toolSpec)
  }))
);

// Converse toolChoice union → Anthropic tool_choice: auto→{type:'auto'}, any→{type:'any'},
// tool→{type:'tool',name} (verified against both schemas).
const toToolChoice = toolChoice => {
  if (isNil(toolChoice)) return undefined;
  if (!isNil(get('any', toolChoice))) return {type: 'any'};
  if (!isNil(get('tool', toolChoice))) return {type: 'tool', name: toolChoice.tool.name};
  return {type: 'auto'};
};

// Converse request → Anthropic Messages body. `system[].text` blocks join with `\n` into the
// top-level `system` string; inferenceConfig maps to max_tokens/temperature/top_p/stop_sequences.
// Anthropic REQUIRES max_tokens, which Converse may omit — inject backend.defaultMaxTokens (4096).
const toAnthropicRequest = (converseRequest, backend) => {
  const systemText = pipe(getOr([], 'system'), map('text'), join('\n'))(converseRequest);
  const inference = getOr({}, 'inferenceConfig', converseRequest);
  const tools = toTools(converseRequest);
  const toolChoice = toToolChoice(get(['toolConfig', 'toolChoice'], converseRequest));
  const maxTokens = isNil(inference.maxTokens)
    ? getOr(DEFAULT_MAX_TOKENS, 'defaultMaxTokens', backend)
    : inference.maxTokens;

  return {
    ...(isEmpty(systemText) ? {} : {system: systemText}),
    ...(isNil(inference.temperature) ? {} : {temperature: inference.temperature}),
    ...(isNil(inference.topP) ? {} : {top_p: inference.topP}),
    ...(isNil(inference.stopSequences) ? {} : {stop_sequences: inference.stopSequences}),
    ...(isEmpty(tools) ? {} : {tools}),
    ...(isNil(toolChoice) ? {} : {tool_choice: toolChoice}),
    model: backend.model,
    messages: map(toAnthropicMessage, getOr([], 'messages', converseRequest)),
    max_tokens: maxTokens
  };
};

// Anthropic content block → Converse content block. text→{text}; tool_use→{toolUse} (input stays
// an object — no JSON parse needed, unlike OpenAI).
const fromAnthropicContentBlock = block => {
  if (block.type === 'text') return {text: block.text};
  if (block.type === 'tool_use')
    return {toolUse: {toolUseId: block.id, name: block.name, input: getOr({}, 'input', block)}};
  return undefined;
};

// Anthropic Messages response → Converse response. Anthropic reports input/output tokens but no
// total, so totalTokens = input + output; missing usage coerces to 0 (required Converse members).
const fromAnthropicResponse = (anthropicResponse, {latencyMs}) => {
  const blocks = pipe(
    getOr([], 'content'),
    map(fromAnthropicContentBlock),
    filter(Boolean)
  )(anthropicResponse);
  const usage = getOr({}, 'usage', anthropicResponse);
  const inputTokens = getOr(0, 'input_tokens', usage);
  const outputTokens = getOr(0, 'output_tokens', usage);
  return {
    // Converse requires a non-empty content array even for an empty completion.
    output: {message: {role: 'assistant', content: isEmpty(blocks) ? [{text: ''}] : blocks}},
    stopReason: getOr('end_turn', get('stop_reason', anthropicResponse), ANTHROPIC_STOP_REASON),
    usage: {inputTokens, outputTokens, totalTokens: inputTokens + outputTokens},
    metrics: {latencyMs}
  };
};

module.exports = {
  DEFAULT_MAX_TOKENS,
  ANTHROPIC_STOP_REASON,
  toAnthropicRequest,
  fromAnthropicResponse
};
