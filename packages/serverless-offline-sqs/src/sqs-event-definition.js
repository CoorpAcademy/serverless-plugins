const {isNil, omit} = require('lodash/fp');

const extractQueueNameFromARN = arn => {
  const [, , , , , queueName] = arn.split(':');
  return queueName;
};

class SQSEventDefinition {
  constructor(rawSqsEventDefinition, region, accountId) {
    let enabled;
    let arn;
    let queueName;

    if (typeof rawSqsEventDefinition === 'string') {
      arn = rawSqsEventDefinition;
      queueName = extractQueueNameFromARN(arn);
    } else if (typeof rawSqsEventDefinition.arn === 'string') {
      arn = rawSqsEventDefinition.arn;
      queueName = extractQueueNameFromARN(arn);
    } else if (typeof rawSqsEventDefinition.queueName === 'string') {
      queueName = rawSqsEventDefinition.queueName;
      arn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = arn;
    this.queueName = queueName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'queueName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = SQSEventDefinition;
