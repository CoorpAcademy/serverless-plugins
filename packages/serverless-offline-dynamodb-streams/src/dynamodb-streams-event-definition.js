const {isNil, omit} = require('lodash/fp');

const extractTableNameFromARN = arn => {
  const [, , , , , TableURI] = arn.split(':');
  const [, TableName] = TableURI.split('/');
  return TableName;
};

class DynamodbStreamsEventDefinition {
  constructor(rawSqsEventDefinition, region, accountId) {
    this.batchSize = 100;
    this.maximumRetryAttempts = 10;
    this.startingPosition = 'LATEST';

    let tableName;

    switch ('string') {
      case typeof rawSqsEventDefinition: {
        tableName = extractTableNameFromARN(rawSqsEventDefinition);

        break;
      }
      case typeof rawSqsEventDefinition.arn: {
        tableName = extractTableNameFromARN(rawSqsEventDefinition.arn);

        break;
      }
      case typeof rawSqsEventDefinition.tableName: {
        tableName = rawSqsEventDefinition.tableName;

        break;
      }
      // No default
    }

    this.enabled = isNil(rawSqsEventDefinition.enabled) ? true : rawSqsEventDefinition.enabled;

    this.arn = `arn:aws:dynamodb:${region}:${accountId}:${tableName}`;
    this.tableName = tableName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = DynamodbStreamsEventDefinition;
