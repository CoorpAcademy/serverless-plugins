const {isNil, omit} = require('lodash/fp');

const extractQueueNameFromARN = arn => {
  const [, , , , , queueName] = arn.split(':');
  return queueName;
};

class SQSEventDefinition {
  constructor(rawSqsEventDefinition, region, accountId) {
    let enabled;
    let queueName;

    switch ('string') {
      case typeof rawSqsEventDefinition: {
        queueName = extractQueueNameFromARN(rawSqsEventDefinition);

        break;
      }
      case typeof rawSqsEventDefinition.arn: {
        queueName = extractQueueNameFromARN(rawSqsEventDefinition.arn);

        break;
      }
      case typeof rawSqsEventDefinition.queueName: {
        queueName = rawSqsEventDefinition.queueName;

        break;
      }
      // No default
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    this.queueName = queueName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'queueName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = SQSEventDefinition;
