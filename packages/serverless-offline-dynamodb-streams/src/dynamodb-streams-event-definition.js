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

    let enabled;
    let tableName;

    if (typeof rawSqsEventDefinition === 'string') {
      tableName = extractTableNameFromARN(rawSqsEventDefinition);
    } else if (typeof rawSqsEventDefinition.arn === 'string') {
      tableName = extractTableNameFromARN(rawSqsEventDefinition.arn);
    } else if (typeof rawSqsEventDefinition.tableName === 'string') {
      tableName = rawSqsEventDefinition.tableName;
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = `arn:aws:dynamodb:${region}:${accountId}:${tableName}`;
    this.tableName = tableName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = DynamodbStreamsEventDefinition;
