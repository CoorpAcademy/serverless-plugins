const {isNil, omit} = require('lodash/fp');

const extractQueueNameFromARN = arn => {
  const [, , , , , queueName] = arn.split(':');
  return queueName;
};

class SQSEventDefinition {
  constructor(rawSqsEventDefinition, region, accountId) {
    let enabled;
    let queueName;

    if (typeof rawSqsEventDefinition === 'string') {
      queueName = extractQueueNameFromARN(rawSqsEventDefinition);

      this.enabled = true;
    } else {
      if (typeof rawSqsEventDefinition.arn === 'string') {
        queueName = extractQueueNameFromARN(rawSqsEventDefinition.arn);
      } else if (typeof rawSqsEventDefinition.queueName === 'string') {
        queueName = rawSqsEventDefinition.queueName;
      }

      this.enabled = isNil(rawSqsEventDefinition.enabled) ? true : enabled;
    }

    this.arn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    this.queueName = queueName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'queueName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = SQSEventDefinition;
