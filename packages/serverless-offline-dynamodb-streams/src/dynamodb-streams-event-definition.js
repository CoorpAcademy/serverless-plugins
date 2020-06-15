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
    let arn;
    let tableName;

    if (typeof rawSqsEventDefinition === 'string') {
      arn = rawSqsEventDefinition;
      tableName = extractTableNameFromARN(arn);
    } else if (typeof rawSqsEventDefinition.arn === 'string') {
      arn = rawSqsEventDefinition.arn;
      tableName = extractTableNameFromARN(arn);
    } else if (typeof rawSqsEventDefinition.tableName === 'string') {
      tableName = rawSqsEventDefinition.tableName;
      arn = `arn:aws:dynamodb:${region}:${accountId}:${tableName}`;
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = arn;
    this.tableName = tableName;

    if (typeof rawSqsEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawSqsEventDefinition));
    }
  }
}

module.exports = DynamodbStreamsEventDefinition;
