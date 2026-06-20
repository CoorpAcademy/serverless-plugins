const fs = require('fs');
const path = require('path');

const {getOr, isEmpty, isNil, isPlainObject, set} = require('lodash/fp');

// #178 (jjohnson1994): persist DynamoDB-stream read progress across `serverless offline`
// restarts. Without it the readable is always created with `iterator: TRIM_HORIZON|
// LATEST`, so each restart re-derives a fresh iterator and re-delivers records the
// local stream still retains — replaying already-processed events and (per #178)
// exhausting memory through unbounded re-reads.
//
// The store is a small JSON map: {<streamArn>: {<shardId>: <lastSequenceNumber>}}.
// The transforms below are PURE (state + checkpoint -> next state; state -> startAfter);
// the file read/write at the bottom is the only side effect and stays at the edges.

const DEFAULT_CHECKPOINT_FILE = '.serverless-offline-dynamodb-streams';

// ---------------------------------------------------------------------------
// Pure helpers (state <-> sequence number) — exported for unit tests
// ---------------------------------------------------------------------------

// mergeCheckpoint(state, {streamArn, shardId, sequenceNumber}) -> next state.
// A nil/empty sequence number is a no-op so a spurious checkpoint never clobbers
// real progress. Non-mutating: builds a fresh nested map with `set`.
const mergeCheckpoint = (state, {streamArn, shardId, sequenceNumber}) => {
  if (isNil(sequenceNumber) || sequenceNumber === '') return state;
  return set([streamArn, shardId], sequenceNumber, state);
};

// resolveStartAfter(state, {streamArn, shardId}) -> the saved sequence number to
// resume *after*, or undefined on a cold start (unknown stream/shard).
const resolveStartAfter = (state, {streamArn, shardId}) =>
  getOr(undefined, [streamArn, shardId], state);

// serializeCheckpointState(state) -> stable, human-diffable JSON.
const serializeCheckpointState = state => JSON.stringify(state, null, 2);

// parseCheckpointState(raw) -> state. Tolerant: malformed JSON, empty content or a
// non-object payload all collapse to an empty state rather than throwing.
const parseCheckpointState = raw => {
  if (isNil(raw) || (typeof raw === 'string' && raw.trim() === '')) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
};

// ---------------------------------------------------------------------------
// I/O edges (thin side effects over the pure helpers)
// ---------------------------------------------------------------------------

const resolveCheckpointPath = (location, file = DEFAULT_CHECKPOINT_FILE) =>
  path.isAbsolute(file) ? file : path.join(location || process.cwd(), file);

// readCheckpointState(checkpointPath) -> state. A missing/unreadable file is a cold
// start (empty state), never a crash.
const readCheckpointState = checkpointPath => {
  try {
    return parseCheckpointState(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (err) {
    return {};
  }
};

// writeCheckpointState(checkpointPath, state) -> void. Best-effort: a persisted empty
// state is skipped, and a write failure is swallowed (offline progress is a convenience,
// not a guarantee — the caller logs it).
const writeCheckpointState = (checkpointPath, state) => {
  if (isEmpty(state)) return;
  fs.writeFileSync(checkpointPath, serializeCheckpointState(state));
};

module.exports = {
  DEFAULT_CHECKPOINT_FILE,
  mergeCheckpoint,
  resolveStartAfter,
  serializeCheckpointState,
  parseCheckpointState,
  resolveCheckpointPath,
  readCheckpointState,
  writeCheckpointState
};
