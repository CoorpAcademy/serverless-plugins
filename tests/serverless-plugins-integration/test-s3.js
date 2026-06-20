const Minio = require('minio');
const {delay, runOfflineTest} = require('./utils');

const client = new Minio.Client({
  region: 'eu-west-1',
  endPoint: 'localhost',
  port: 9000,
  accessKey: 'local',
  secretKey: 'locallocal',
  useSSL: false
});

const PATH = './files/test.txt';

// documents/{first,second} -> promise (2); pictures/{first,second} -> promise AND callback (4);
// files/{first,second} -> callback (2); others/correct/test.csv -> promise (prefix+suffix rule, 1).
// => 9 distinct (functionName, object) invocations.
const S = 'serverless-offline-s3-dev';
const EXPECTED_KEYS = [
  `${S}-myPromiseHandler s3:documents/first.txt`,
  `${S}-myPromiseHandler s3:documents/second.txt`,
  `${S}-myPromiseHandler s3:pictures/first.txt`,
  `${S}-myPromiseHandler s3:pictures/second.txt`,
  `${S}-myPromiseHandler s3:others/correct/test.csv`,
  `${S}-myCallbackHandler s3:files/first.txt`,
  `${S}-myCallbackHandler s3:files/second.txt`,
  `${S}-mySecondCallbackHandler s3:pictures/first.txt`,
  `${S}-mySecondCallbackHandler s3:pictures/second.txt`
];
// The `others` event has rules prefix `correct/` + suffix `.csv`; only correct/test.csv must match.
const FORBIDDEN_KEYS = [
  `${S}-myPromiseHandler s3:others/correct/test.txt`,
  `${S}-myPromiseHandler s3:others/wrong/test.csv`,
  `${S}-myPromiseHandler s3:others/wrong/test.txt`
];

const uploadFiles = async () => {
  await delay(1000);
  await Promise.all([
    client.fPutObject('documents', 'first.txt', PATH),
    client.fPutObject('pictures', 'first.txt', PATH),
    client.fPutObject('files', 'first.txt', PATH),
    client.fPutObject('documents', 'second.txt', PATH),
    client.fPutObject('pictures', 'second.txt', PATH),
    client.fPutObject('files', 'second.txt', PATH),
    client.fPutObject('others', 'correct/test.txt', PATH),
    client.fPutObject('others', 'wrong/test.csv', PATH),
    client.fPutObject('others', 'correct/test.csv', PATH),
    client.fPutObject('others', 'wrong/test.txt', PATH)
  ]);
};

runOfflineTest({
  config: 'serverless.s3.yml',
  label: 'test-s3',
  expectedKeys: EXPECTED_KEYS,
  forbiddenKeys: FORBIDDEN_KEYS,
  readyPattern: /Starting Offline S3/,
  onReady: uploadFiles
});
