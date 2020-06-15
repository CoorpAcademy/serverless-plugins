const {assign} = require('lodash/fp');

class KinesisEvent {
  constructor(Records, region, streamArn) {
    this.Records = Records.map(
      assign({
        eventSourceARN: streamArn,
        awsRegion: region
      })
    );
  }
}

module.exports = KinesisEvent;
