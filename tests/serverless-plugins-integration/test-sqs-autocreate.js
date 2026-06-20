const {SQS} = require('aws-sdk');
const {delay, runOfflineTest} = require('./utils');

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

// AutocreatedImplicitQueue, AutocreatedQueue, AutocreatedFifoQueue.fifo -> autoCreatedHandler.
const S = 'serverless-offline-sqs-dev';
const EXPECTED_KEYS = [
  `${S}-autoCreatedHandler sqs:AutocreatedImplicitQueue`,
  `${S}-autoCreatedHandler sqs:AutocreatedQueue`,
  `${S}-autoCreatedHandler sqs:AutocreatedFifoQueue.fifo`
];

const sendMessages = async () => {
  await delay(1000);
  await Promise.all([
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedImplicitQueue',
        MessageBody: 'AutocreatedImplicitQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedQueue',
        MessageBody: 'AutocreatedQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedFifoQueue.fifo',
        MessageBody: 'AutocreatedFifoQueue',
        MessageGroupId: '1'
      })
      .promise()
  ]);
};

runOfflineTest({
  config: 'serverless.sqs.autocreate.yml',
  label: 'test-sqs-autocreate',
  expectedKeys: EXPECTED_KEYS,
  readyPattern: /Starting Offline SQS/,
  onReady: sendMessages
});
