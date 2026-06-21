const {KinesisClient, PutRecordCommand} = require('@aws-sdk/client-kinesis');
const {NodeHttpHandler} = require('@smithy/node-http-handler');
const {delay, runOfflineTest} = require('./utils');

const client = new KinesisClient({
  region: 'eu-west-1',
  credentials: {accessKeyId: 'local', secretAccessKey: 'local'},
  endpoint: 'http://localhost:4567',
  // #248 (aws-sdk v3): @aws-sdk/client-kinesis defaults to NodeHttp2Handler, but kinesalite only
  // speaks HTTP/1.1 — force the HTTP/1.1 handler (same fix as the plugin's client-config).
  requestHandler: new NodeHttpHandler()
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
      client.send(
        new PutRecordCommand({
          StreamName: `My${order}Stream`,
          PartitionKey: `My${order}Message`,
          // #248 (aws-sdk v3): Data must be a Uint8Array, not a string as in v2.
          Data: Buffer.from(`My${order}Message`)
        })
      )
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
