const {isNil, omit} = require('lodash/fp');

const extractStreamNameFromARN = arn => {
  const [, , , , , StreamURI] = arn.split(':');
  const [, ...StreamNames] = StreamURI.split('/');
  return StreamNames.join('/');
};

class KinesisEventDefinition {
  constructor(rawKinesisEventDefinition, region, accountId) {
    this.batchSize = 10;
    this.startingPosition = 'LATEST';

    let enabled;
    let arn;
    let streamName;

    if (typeof rawKinesisEventDefinition === 'string') {
      arn = rawKinesisEventDefinition;
      streamName = extractStreamNameFromARN(arn);
    } else if (typeof rawKinesisEventDefinition.arn === 'string') {
      arn = rawKinesisEventDefinition.arn;
      streamName = extractStreamNameFromARN(arn);
    } else if (typeof rawKinesisEventDefinition.streamName === 'string') {
      streamName = rawKinesisEventDefinition.streamName;
      arn = `arn:aws:kinesis:${region}:${accountId}:${streamName}`;
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = arn;
    this.streamName = streamName;

    if (typeof rawKinesisEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawKinesisEventDefinition));
    }
  }
}

module.exports = KinesisEventDefinition;
