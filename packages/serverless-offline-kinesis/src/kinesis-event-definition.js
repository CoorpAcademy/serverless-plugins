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

    let streamName;

    switch ('string') {
      case typeof rawKinesisEventDefinition: {
        streamName = extractStreamNameFromARN(rawKinesisEventDefinition);

        break;
      }
      case typeof rawKinesisEventDefinition.arn: {
        streamName = extractStreamNameFromARN(rawKinesisEventDefinition.arn);

        break;
      }
      case typeof rawKinesisEventDefinition.streamName: {
        streamName = rawKinesisEventDefinition.streamName;

        break;
      }
      // No default
    }

    this.enabled = isNil(rawKinesisEventDefinition.enabled) 
      ? true : rawKinesisEventDefinition.enabled;

    this.arn = `arn:aws:kinesis:${region}:${accountId}:${streamName}`;
    this.streamName = streamName;

    if (typeof rawKinesisEventDefinition !== 'string') {
      Object.assign(this, omit(['arn', 'tableName', 'enabled'], rawKinesisEventDefinition));
    }
  }
}

module.exports = KinesisEventDefinition;
