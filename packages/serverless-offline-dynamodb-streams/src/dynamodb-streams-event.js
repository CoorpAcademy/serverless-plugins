const {assign} = require('lodash/fp');

class DynamodbStreamsEvent {
  constructor(Records, region, streamArn) {
    this.Records = Records.map(
      assign({
        eventSourceARN: streamArn,
        awsRegion: region
      })
    );
  }
}

module.exports = DynamodbStreamsEvent;
