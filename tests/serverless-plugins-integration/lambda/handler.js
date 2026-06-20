// Emit a stable, greppable marker per invocation so the integration tests can count lambda
// calls independent of the serverless-offline log format (the old `Billed Duration` line was
// removed in serverless-offline v14). The marker carries the function name (so the same record
// hitting two handlers counts twice) and a per-record identity (so retries de-duplicate).
// STABLE per (handler, source): the identity is the event source only (bucket/key for S3, the
// eventSourceARN for queues/streams/tables) — NOT the runtime messageId/sequenceNumber. This way a
// retried or split-across-invocations delivery dedupes to the same key, so surplus markers can never
// mask a handler that never fired (the count becomes an exact (handler, source) coverage check).
const recordIdentity = record => {
  if (record.s3) return `s3:${record.s3.bucket.name}/${record.s3.object.key}`;
  // Resource name (last ARN segment) — stable, readable, and decoupled from region/account format.
  const resource = (record.eventSourceARN || '').split(':').pop() || 'unknown';
  if (record.messageId) return `sqs:${resource}`;
  if (record.kinesis) return `kinesis:${resource}`;
  if (record.dynamodb) return `dynamodb:${resource}`;
  return 'unknown';
};

const mark = (event, context) => {
  const records = (event && event.Records) || [];
  const identity = records.length > 0 ? recordIdentity(records[0]) : 'no-records';
  // trailing count lets a test assert batching (e.g. a 70-message SQS batch in one invocation).
  console.log(`__INVOKED__ ${context.functionName} ${identity} ${records.length}`);
};

module.exports.promise = (event, context) => {
  mark(event, context);
  return Promise.resolve();
};

module.exports.callback = (event, context, cb) => {
  mark(event, context);
  cb();
};

// #132: a plain HTTP (API Gateway) handler. An http event carries no `Records`, so it emits its own
// `__INVOKED__ <fn> http:<path>` marker. Used by test-sqs-http to assert that an HTTP route and an
// SQS listener register and fire in the SAME `serverless-offline` run (SQS+HTTP co-registration).
module.exports.http = (event, context) => {
  const path = (event && (event.path || event.rawPath)) || 'unknown';
  console.log(`__INVOKED__ ${context.functionName} http:${path} 1`);
  return {statusCode: 200, body: JSON.stringify({ok: true})};
};
