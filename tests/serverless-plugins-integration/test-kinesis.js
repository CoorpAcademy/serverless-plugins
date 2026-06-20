const {Kinesis} = require('aws-sdk');
const {delay, runOfflineTest} = require('./utils');

const client = new Kinesis({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:4567'
});

// MyFirstStream + MySecondStream (myPromiseHandler), MyThirdStream (myCallbackHandler),
// MyFourthStream (mySecondCallbackHandler) => 4 distinct invocations.
const S = 'serverless-offline-kinesis-dev';
const EXPECTED_KEYS = [
  `${S}-myPromiseHandler kinesis:MyFirstStream`,
  `${S}-myPromiseHandler kinesis:MySecondStream`,
  `${S}-myCallbackHandler kinesis:MyThirdStream`,
  `${S}-mySecondCallbackHandler kinesis:MyFourthStream`
];

const putRecords = async () => {
  await delay(1000);
  await Promise.all(
    ['First', 'Second', 'Third', 'Fourth'].map(order =>
      client
        .putRecord({
          StreamName: `My${order}Stream`,
          PartitionKey: `My${order}Message`,
          Data: `My${order}Message`
        })
        .promise()
    )
  );
};

runOfflineTest({
  config: 'serverless.kinesis.yml',
  label: 'test-kinesis',
  expectedKeys: EXPECTED_KEYS,
  readyPattern: /Starting Offline Kinesis/,
  onReady: putRecords
});
