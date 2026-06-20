const {has, isArray, isPlainObject, isString} = require('lodash/fp');

// A '{'-prefixed string is treated as a JSON object (SecureString) candidate.
const looksLikeJson = value => isString(value) && value.trim().startsWith('{');

// inferType(value) -> 'String' | 'StringList' | 'SecureString'
// Best-effort inference; the built-in resolver does the actual split/parse from the Type.
const inferType = value => {
  if (isArray(value)) return 'StringList';
  if (looksLikeJson(value)) return 'SecureString';
  if (isString(value) && value.includes(',')) return 'StringList';
  return 'String';
};

// Coerce a map value to the raw string the built-in resolver expects.
// Arrays are joined with ',' so the built-in's `.split(',')` reproduces the array.
const toRawValue = value => (isArray(value) ? value.join(',') : value);

// normalizeEntry(entry) -> {value: <string>, type}
// entry is either a plain string/array, or an explicit {value, type} override object.
const normalizeEntry = entry => {
  if (isPlainObject(entry) && has('value', entry)) {
    return {value: toRawValue(entry.value), type: entry.type || inferType(entry.value)};
  }
  return {value: toRawValue(entry), type: inferType(entry)};
};

// resolveParameter(ssmMap, name) -> {Value, Type} | undefined
// undefined signals a miss: the caller falls through to real AWS SSM (#152).
const resolveParameter = (ssmMap, name) => {
  const map = ssmMap || {};
  if (!has(name, map)) return undefined;
  const {value, type} = normalizeEntry(map[name]);
  return {Value: value, Type: type};
};

// shouldExecute(stages, stage) -> boolean
const shouldExecute = (stages, stage) => isArray(stages) && stages.includes(stage);

module.exports = {looksLikeJson, inferType, normalizeEntry, resolveParameter, shouldExecute};
