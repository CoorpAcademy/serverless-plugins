const {SQS} = require('aws-sdk');
const {delay, runOfflineTest} = require('./utils');

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

// AutocreatedImplicitQueue, AutocreatedQueue, AutocreatedFifoQueue.fifo, MainQueue ->
// autoCreatedHandler. MainQueue redrives to MainDlq, a DLQ declared ONLY in Resources and bound to
// no function: MainQueue can only be created (and only delivers below) if MainDlq was autocreated
// FIRST — otherwise createQueue rejects with AWS.SimpleQueueService.NonExistentQueue (#167/#133/#65).
const S = 'serverless-offline-sqs-dev';
const EXPECTED_KEYS = [
  `${S}-autoCreatedHandler sqs:AutocreatedImplicitQueue`,
  `${S}-autoCreatedHandler sqs:AutocreatedQueue`,
  `${S}-autoCreatedHandler sqs:AutocreatedFifoQueue.fifo`,
  `${S}-autoCreatedHandler sqs:MainQueue`
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
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MainQueue',
        MessageBody: 'MainQueue'
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
