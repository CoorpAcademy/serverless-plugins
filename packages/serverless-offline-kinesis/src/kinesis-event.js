class KinesisEvent {
  constructor(chunk, region, arn, shardId) {
    this.Records = chunk.map(({SequenceNumber, Data, PartitionKey}) => ({
      kinesis: {
        partitionKey: PartitionKey,
        kinesisSchemaVersion: '1.0',
        data: Data.toString('base64'),
        sequenceNumber: SequenceNumber
      },
      eventSource: 'aws:kinesis',
      eventID: `${shardId}:${SequenceNumber}`,
      invokeIdentityArn: 'arn:aws:iam::serverless:role/offline',
      eventVersion: '1.0',
      eventName: 'aws:kinesis:record',
      eventSourceARN: arn,
      awsRegion: region
    }));
  }
}

module.exports = KinesisEvent;
