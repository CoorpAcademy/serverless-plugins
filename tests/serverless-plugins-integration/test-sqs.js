const {chunk} = require('lodash/fp');
const {SQS} = require('aws-sdk');
const {delay, runOfflineTest} = require('./utils');

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

// MyFirstQueue + MySecondQueue (myPromiseHandler), MyThirdQueue (myCallbackHandler),
// MyFourthQueue (mySecondCallbackHandler), MyLargestBatchSizeQueue (myLargestBatchSizeHandler).
const S = 'serverless-offline-sqs-dev';
const EXPECTED_KEYS = [
  `${S}-myPromiseHandler sqs:MyFirstQueue`,
  `${S}-myPromiseHandler sqs:MySecondQueue`,
  `${S}-myCallbackHandler sqs:MyThirdQueue`,
  `${S}-mySecondCallbackHandler sqs:MyFourthQueue`,
  `${S}-myLargestBatchSizeHandler sqs:MyLargestBatchSizeQueue`
];
// 70 messages are sent to MyLargestBatchSizeQueue with batchSize 70 — assert they are actually
// delivered batched (a single invocation of many records), not one record per invocation.
const EXPECT_BATCH = {
  [`${S}-myLargestBatchSizeHandler sqs:MyLargestBatchSizeQueue`]: 10
};

const sendMessages = async () => {
  await delay(1000);
  await Promise.all([
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyFirstQueue',
        MessageBody: 'MyFirstMessage',
        MessageAttributes: {myAttribute: {DataType: 'String', StringValue: 'myAttribute'}}
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MySecondQueue',
        MessageBody: 'MySecondMessage'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyThirdQueue',
        MessageBody: 'MyThirdMessage'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyFourthQueue',
        MessageBody: 'MyFourthMessage'
      })
      .promise(),
    ...chunk(
      10,
      Array.from({length: 70}).map((_, Id) => ({
        Id: `${Id}`,
        MessageBody: 'MyLargestBatchSizeQueue'
      }))
    ).map(Entries =>
      client
        .sendMessageBatch({
          QueueUrl: 'http://localhost:9324/queue/MyLargestBatchSizeQueue',
          Entries
        })
        .promise()
    )
  ]);
};

runOfflineTest({
  config: 'serverless.sqs.yml',
  label: 'test-sqs',
  expectedKeys: EXPECTED_KEYS,
  expectBatch: EXPECT_BATCH,
  readyPattern: /Starting Offline SQS/,
  onReady: sendMessages
});
