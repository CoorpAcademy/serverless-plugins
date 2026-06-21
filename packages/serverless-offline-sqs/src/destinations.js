const {GetQueueUrlCommand, SendMessageCommand} = require('@aws-sdk/client-sqs');
const {get, has, isNil, isPlainObject, isString} = require('lodash/fp');

// ---------------------------------------------------------------------------
// Lambda async-invoke destinations (onFailure / onSuccess) — pure helpers + a
// single injected-client dispatcher. Extracted from EventBridge._onFailure so the
// same destinations contract can be reused by serverless-offline-sqs and
// serverless-offline-dynamodb-streams (spec B2). SQS-only targets, by design.
// ---------------------------------------------------------------------------

// CloudFormation pseudo-parameters we can resolve offline from the plugin's region/accountId.
// `resources` (the resolved CFN Resources map) is optional and only used to resolve a Ref / Fn::GetAtt
// that points at an AWS::SQS::Queue declared in the stack (spec EARS6).
const pseudoParams = (region, accountId, resources) => ({
  'AWS::Region': region,
  'AWS::AccountId': accountId,
  region,
  accountId,
  resources
});

// resolveQueueRefArn(resources, refName, region, accountId) -> string | undefined
// Mirrors serverless-offline-sqs' resolveSqsRefArn: a Ref / Fn::GetAtt targeting an AWS::SQS::Queue
// declared in resources.Resources resolves to a stable ARN whose last segment is the queue name
// (preferring the declared Properties.QueueName, falling back to the logical id serverless uses for an
// auto-named queue locally). Returns undefined for anything that is not an SQS queue. Pure, non-throwing.
const resolveQueueRefArn = (resources, refName, region, accountId) => {
  if (get([refName, 'Type'], resources) !== 'AWS::SQS::Queue') return undefined;
  const queueName = get([refName, 'Properties', 'QueueName'], resources) || refName;
  return `arn:aws:sqs:${region}:${accountId}:${queueName}`;
};

// resolveCfnValue(value, ctx) -> string | undefined
// Mirrors serverless-offline-sqs' resolver: flattens the intrinsic / pseudo-parameter forms a
// destination ARN can take into a plain string. Resolves a Ref / Fn::GetAtt to an AWS::SQS::Queue
// declared in `ctx.resources` to that queue's ARN (spec EARS6). Returns undefined for anything
// unresolvable offline (Fn::ImportValue, a Ref/Fn::GetAtt to a non-queue or absent resource, a
// non-string) so the caller can warn + skip.
const resolveCfnValue = (value, ctx) => {
  if (isString(value))
    return value.replace(/[#$]\{(AWS::[A-Za-z]+)\}/g, (match, key) =>
      isNil(ctx[key]) ? match : ctx[key]
    );

  if (isPlainObject(value)) {
    if (has('Ref', value)) {
      // A Ref to a pseudo-parameter (AWS::Region/AWS::AccountId) resolves to that value; otherwise try
      // resolving it against the stack Resources as an AWS::SQS::Queue (spec EARS6).
      if (!isNil(ctx[value.Ref])) return ctx[value.Ref];
      return resolveQueueRefArn(ctx.resources, value.Ref, ctx.region, ctx.accountId);
    }
    if (has('Fn::GetAtt', value)) {
      // CloudFormation `{Fn::GetAtt: [<QueueLogicalId>, 'Arn']}` -> the queue's ARN (spec EARS6).
      const [resourceName, attribute] = value['Fn::GetAtt'];
      if (attribute !== 'Arn') return undefined;
      return resolveQueueRefArn(ctx.resources, resourceName, ctx.region, ctx.accountId);
    }
    if (has('Fn::Sub', value)) return resolveCfnValue(value['Fn::Sub'], ctx);
    if (has('Fn::Join', value)) {
      const [separator, parts] = value['Fn::Join'];
      return (parts || []).map(part => resolveCfnValue(part, ctx)).join(separator);
    }
    // Fn::ImportValue (and any other intrinsic) is not resolvable offline.
  }

  return undefined;
};

// resolveDestinationArn(target, ctx) -> string | undefined
// A destination target is a literal string ARN, a {arn: <string|intrinsic>}, or a bare intrinsic.
// Resolves any of these to a string ARN through resolveCfnValue, or undefined when unresolvable.
const resolveDestinationArn = (target, ctx = {}) => {
  if (isNil(target)) return undefined;
  const arn = isPlainObject(target) && has('arn', target) ? target.arn : target;
  const resolved = resolveCfnValue(arn, ctx);
  return isString(resolved) && resolved !== '' ? resolved : undefined;
};

// queueNameFromArn(arn) -> string | undefined
// The queue name is the final ':'-delimited segment (robust to pseudo-params that inject extra ':').
const queueNameFromArn = arn => {
  if (!isString(arn) || arn === '') return undefined;
  const segments = arn.split(':');
  return segments[segments.length - 1] || undefined;
};

// The eventbridge onFailure contract, preserved byte-for-byte (spec EARS8).
const buildFailurePayload = (requestPayload, err) => ({
  requestPayload,
  responsePayload: {errorMessage: err && err.message, errorType: err && err.name}
});

const buildSuccessPayload = (requestPayload, result) => ({
  requestPayload,
  responsePayload: result
});

// dispatchDestination({client, target, ctx, payload, log}) -> Promise<void>
// The single impure edge (still unit-tested with an injected fake client). Best-effort:
//   - nil target            -> no-op (no client call)
//   - unresolvable ARN      -> warn + skip
//   - resolvable target     -> GetQueueUrl + SendMessage
// ANY error is log.warning-ed and swallowed — destinations dispatch never throws or blocks the
// originating event source (spec EARS7, edge cases 2 & 3).
const dispatchDestination = async ({client, target, ctx = {}, payload, log}) => {
  if (isNil(target)) return;

  const arn = resolveDestinationArn(target, ctx);
  if (isNil(arn)) {
    log.warning(
      `destinations: cannot resolve target ARN offline, skipping: ${JSON.stringify(target)}`
    );
    return;
  }

  try {
    const queueName = queueNameFromArn(arn);
    const {QueueUrl} = await client.send(new GetQueueUrlCommand({QueueName: queueName}));
    await client.send(new SendMessageCommand({QueueUrl, MessageBody: JSON.stringify(payload)}));
  } catch (err) {
    log.warning(err && err.stack ? err.stack : String(err));
  }
};

// runDestinations(args) -> Promise<void>
// The orchestrator the event sources call. Gated behind simulateDestinations (default true). On an
// error it dispatches destinations.onFailure; otherwise it dispatches destinations.onSuccess. The SQS
// client is built lazily via makeClient() so NO client is constructed when there is nothing to send
// (spec EARS2, edge case 1).
const runDestinations = async ({
  simulateDestinations,
  destinations,
  ctx = {},
  makeClient,
  log,
  requestPayload,
  error,
  result
}) => {
  if (simulateDestinations === false) return;

  const target = error
    ? destinations && destinations.onFailure
    : destinations && destinations.onSuccess;
  if (isNil(target)) return;

  const payload = error
    ? buildFailurePayload(requestPayload, error)
    : buildSuccessPayload(requestPayload, result);

  await dispatchDestination({client: makeClient(), target, ctx, payload, log});
};

module.exports = {
  pseudoParams,
  resolveQueueRefArn,
  resolveCfnValue,
  resolveDestinationArn,
  queueNameFromArn,
  buildFailurePayload,
  buildSuccessPayload,
  dispatchDestination,
  runDestinations
};
