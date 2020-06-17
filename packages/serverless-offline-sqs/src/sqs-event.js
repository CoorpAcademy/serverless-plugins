const {mapValues, mapKeys, lowerFirst} = require('lodash/fp');

class SQSEvent {
  constructor(messages, region, arn) {
    this.Records = messages.map(
      ({
        MessageId: messageId,
        ReceiptHandle: receiptHandle,
        Body: body,
        Attributes: attributes,
        MessageAttributes: messageAttributes,
        MD5OfBody: md5OfBody
      }) => ({
        messageId,
        receiptHandle,
        body,
        attributes,
        messageAttributes: mapValues(mapKeys(lowerFirst), messageAttributes),
        md5OfBody,
        eventSource: 'aws:sqs',
        eventSourceARN: arn,
        awsRegion: region
      })
    );
  }
}

module.exports = SQSEvent;
