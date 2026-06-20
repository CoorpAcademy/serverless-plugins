const {find, getOr, includes, isNil} = require('lodash/fp');

// #164 (mdrijwan/rynvelt): when a shardId is requested but absent, DO NOT silently fall back to
// Shards[0] (origin/master `data.StreamDescription.Shards[0].ShardId`). Return undefined so the
// caller can throw a clear "Shard <id> does not exist". With no requested shardId, the first shard
// is still the sensible default.
const selectShardId = (shards, requestedShardId) => {
  if (isNil(requestedShardId)) return getOr(undefined, '[0].ShardId', shards);
  const match = find(shard => shard.ShardId === requestedShardId, shards || []);
  return match ? match.ShardId : undefined;
};

// #154 (mshick) + #164 (mdrijwan): a cached shard iterator can rotate/expire (local DynamoDB shards
// are ephemeral). origin/master only retried 'TrimmedDataAccessException'; recover the iterator on
// the full set of "iterator is stale, re-describe the stream" errors instead of emitting 'error'.
const RECOVERABLE_ITERATOR_ERRORS = [
  'TrimmedDataAccessException',
  'ExpiredIteratorException',
  'ResourceNotFoundException' // message: "Invalid ShardId in ShardIterator"
];
const isRecoverableIteratorError = err =>
  !isNil(err) && includes(getOr(undefined, 'name', err), RECOVERABLE_ITERATOR_ERRORS);

// #154/#164: recovery must be BOUNDED — re-describe at most `max` times, then surface the error so a
// permanently-broken stream still fails instead of spinning forever.
const nextRetryState = ({attempt, max}) =>
  attempt < max ? {retry: true, attempt: attempt + 1, max} : {retry: false, attempt, max};

// #54 (asprouse) / #82 (kalitamih) / #163 (mcopik): origin/master set `drain = true` whenever
// `NextShardIterator` was absent (line 120), which on local emulators happens on an OPEN shard once
// the batch is drained -> premature `end`. Drain ONLY when the consumer closed the stream or the
// shard is genuinely sealed. An absent NextShardIterator on an open, non-closed stream does NOT drain.
const shouldDrain = ({closed, sealed}) => Boolean(closed) || Boolean(sealed);

// #163 (mcopik): keep polling for new records as long as the stream is open and the consumer has not
// closed it — including on an empty batch with no NextShardIterator (re-fetch a fresh iterator on the
// next read). Stop only when draining.
const shouldKeepPolling = ({closed, sealed}) => !shouldDrain({closed, sealed});

// #197 (cnuss): never issue a read once the stream is closed/destroyed (guards the final
// `_read()`/`getRecords` that fired against a shutting-down endpoint -> ECONNREFUSED on SIGINT).
// Mirrors origin/master's `if ((drain && !pending) || !iterator) return ...` plus the new `closed` guard.
const canRead = ({closed, iterator, drain, pending}) => {
  if (closed) return false;
  if (isNil(iterator)) return false;
  if (drain && !pending) return false;
  return true;
};

module.exports = {
  selectShardId,
  isRecoverableIteratorError,
  nextRetryState,
  shouldDrain,
  shouldKeepPolling,
  canRead,
  RECOVERABLE_ITERATOR_ERRORS
};
