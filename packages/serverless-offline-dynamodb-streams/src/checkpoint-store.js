const fs = require('fs');
const path = require('path');

const {getOr, isString, isEmpty} = require('lodash/fp');

// #178 (ddb-streams-checkpoint): persist a per-shard restart checkpoint so a restart
// resumes AFTER the last record handed to (and processed by) the lambda handler,
// instead of replaying the whole shard from TRIM_HORIZON on every offline restart.
//
// State shape (gitignored JSON file):
//   { "<streamArn>::<shardId>": "<sequenceNumber>", ... }
// The key namespaces the sequence number by stream so distinct tables/streams never
// collide. Everything in this module is pure except the two thin I/O wrappers
// (loadState / saveState) at the bottom; the decision logic is pure and unit-tested.

const DEFAULT_STATE_FILE = '.serverless-offline-dynamodb-streams.json';

// Build the namespaced state key for a (streamArn, shardId) pair. Pure.
const checkpointKey = (streamArn, shardId) => `${streamArn}::${shardId}`;

// Read the saved sequence number for a shard from a state map, or undefined when
// none is recorded. Pure; tolerates a null/undefined state map.
const getCheckpoint = (state, streamArn, shardId) =>
  getOr(undefined, [checkpointKey(streamArn, shardId)], state);

// Return a NEW state map with the shard's checkpoint advanced to sequenceNumber.
// Non-mutating. A nil/empty sequenceNumber is ignored (returns the state unchanged)
// so a drain sentinel or empty batch never clobbers a real checkpoint.
const setCheckpoint = (state, streamArn, shardId, sequenceNumber) =>
  isEmpty(sequenceNumber) || !isString(sequenceNumber)
    ? {...state}
    : {...state, [checkpointKey(streamArn, shardId)]: sequenceNumber};

// Decide the readable-stream iterator options for a shard, given any saved checkpoint.
//
// - No saved checkpoint  -> honor the configured startingPosition via `iterator`
//   (LATEST / TRIM_HORIZON), the original cold-start behavior.
// - Saved checkpoint      -> resume AFTER that sequence number (AFTER_SEQUENCE_NUMBER),
//   so already-processed records are NOT re-delivered — even under TRIM_HORIZON (#178).
//
// `iterator` MUST be omitted when resuming: the readable gives `options.iterator`
// precedence over `startAfter`, so leaving it set would defeat the resume. Pure.
const resolveIteratorOptions = (state, streamArn, shardId, startingPosition) => {
  const sequenceNumber = getCheckpoint(state, streamArn, shardId);
  return isEmpty(sequenceNumber) ? {iterator: startingPosition} : {startAfter: sequenceNumber};
};

// Resolve the absolute path of the state file from a (possibly relative) configured
// path, anchored at the given working directory. Pure.
const resolveStateFilePath = (stateFile, cwd) => {
  const file = isEmpty(stateFile) ? DEFAULT_STATE_FILE : stateFile;
  return path.isAbsolute(file) ? file : path.join(cwd, file);
};

// --- I/O edges (the only impure functions in this module) ------------------

// Load the persisted state map from disk. Missing file or malformed JSON yields an
// empty map rather than throwing — a corrupt/absent checkpoint must never crash
// offline startup, it just means "cold start". #178 EARS4: no ENOENT spam.
const loadState = stateFilePath => {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
};

// Persist the state map to disk, creating the parent directory if it is missing
// (#178 EARS4: a missing checkpoint dir is created, no ENOENT). Best-effort: a write
// failure is surfaced to the caller, which logs it without aborting the stream.
const saveState = (stateFilePath, state) => {
  fs.mkdirSync(path.dirname(stateFilePath), {recursive: true});
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf8');
};

module.exports = {
  DEFAULT_STATE_FILE,
  checkpointKey,
  getCheckpoint,
  setCheckpoint,
  resolveIteratorOptions,
  resolveStateFilePath,
  loadState,
  saveState
};
