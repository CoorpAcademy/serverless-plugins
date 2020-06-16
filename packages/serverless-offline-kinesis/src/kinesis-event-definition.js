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
    let streamName;

    if (typeof rawKinesisEventDefinition === 'string') {
      streamName = extractStreamNameFromARN(rawKinesisEventDefinition);
    } else if (typeof rawKinesisEventDefinition.arn === 'string') {
      streamName = extractStreamNameFromARN(rawKinesisEventDefinition.arn);
    } else if (typeof rawKinesisEventDefinition.streamName === 'string') {
      streamName = rawKinesisEventDefinition.streamName;
    }

    this.enabled = isNil(enabled) ? true : enabled;

    this.arn = `arn:aws:kinesis:${region}:${accountId}:${streamName}`;
    this.streamName = streamName;

    if (typeof rawKinesisEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawKinesisEventDefinition));
    }
  }
}

module.exports = KinesisEventDefinition;
