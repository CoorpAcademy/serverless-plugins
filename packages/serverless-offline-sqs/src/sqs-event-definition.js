const {has, isNil, isPlainObject, isString, omit} = require('lodash/fp');

// CloudFormation pseudo-parameters we can resolve offline from the plugin's region/accountId.
const pseudoParams = (region, accountId) => ({'AWS::Region': region, 'AWS::AccountId': accountId});

// resolveCfnValue(value, ctx) -> string | undefined
// Flattens the intrinsic / pseudo-parameter forms an SQS event `arn` can take into a plain string
// so the queue name can be extracted. Returns undefined for anything we cannot resolve offline
// (e.g. Fn::ImportValue, Ref to a stack resource) — the caller surfaces that as a clear miss.
//   #74 (DenisOgr): serverless-pseudo-parameters leaves `#{AWS::AccountId}` inside the ARN string.
//   #200 (sndr): an `arn` supplied as `{Fn::Join: [sep, parts]}` (with a nested `{Ref}`) never
//   reached extraction at all, yielding `arn:...:undefined`.
const resolveCfnValue = (value, ctx) => {
  // Substitute both `#{AWS::X}` (serverless-pseudo-parameters) and `${AWS::X}` (Fn::Sub) tokens;
  // unknown tokens are left untouched so a bad ARN stays visibly bad rather than silently wrong.
  if (isString(value))
    return value.replace(/[#$]\{(AWS::[A-Za-z]+)\}/g, (match, key) =>
      isNil(ctx[key]) ? match : ctx[key]
    );

  if (isPlainObject(value)) {
    if (has('Ref', value)) return isNil(ctx[value.Ref]) ? undefined : ctx[value.Ref];
    if (has('Fn::Sub', value)) return resolveCfnValue(value['Fn::Sub'], ctx);
    if (has('Fn::Join', value)) {
      const [separator, parts] = value['Fn::Join'];
      return (parts || []).map(part => resolveCfnValue(part, ctx)).join(separator);
    }
    // Fn::GetAtt is resolved upstream (index._resolveFn); Fn::ImportValue is not resolvable offline.
  }

  return undefined;
};

// extractQueueNameFromARN(arn, region, accountId) -> queueName | undefined
// The queue name is the final ':'-delimited segment of the ARN and never itself contains ':',
// so popping the last segment is robust to pseudo-parameters that inject extra ':' (#74).
const extractQueueNameFromARN = (arn, region, accountId) => {
  const resolved = resolveCfnValue(arn, pseudoParams(region, accountId));
  if (!isString(resolved) || resolved === '') return undefined;
  const segments = resolved.split(':');
  return segments[segments.length - 1] || undefined;
};

class SQSEventDefinition {
  constructor(rawSqsEventDefinition, region, accountId) {
    const isStringDefinition = isString(rawSqsEventDefinition);

    // Prefer an explicit `queueName` (also the #211 override path, which strips `arn`); otherwise
    // derive it from the ARN — resolving intrinsics/pseudo-parameters first (#74, #200).
    const queueName =
      !isStringDefinition && !isNil(rawSqsEventDefinition.queueName)
        ? rawSqsEventDefinition.queueName
        : extractQueueNameFromARN(
            isStringDefinition ? rawSqsEventDefinition : rawSqsEventDefinition.arn,
            region,
            accountId
          );

    this.enabled = true;
    this.arn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    this.queueName = queueName;

    if (!isStringDefinition) {
      Object.assign(this, omit(['arn', 'queueName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = SQSEventDefinition;
module.exports.resolveCfnValue = resolveCfnValue;
module.exports.extractQueueNameFromARN = extractQueueNameFromARN;
