const {DynamoDBClient, PutItemCommand} = require('@aws-sdk/client-dynamodb');
const {delay, runOfflineTest} = require('./utils');

const client = new DynamoDBClient({
  region: 'eu-west-1',
  credentials: {accessKeyId: 'local', secretAccessKey: 'local'},
  endpoint: 'http://localhost:8000'
});

// MyFirstTable + MySecondTable (myPromiseHandler), MyThirdTable (myCallbackHandler),
// MyFourthTable (mySecondCallbackHandler) => 4 distinct invocations.
const S = 'serverless-offline-dynamodb-streams-dev';
const EXPECTED_KEYS = [
  `${S}-myPromiseHandler dynamodb:MyFirstTable`,
  `${S}-myPromiseHandler dynamodb:MySecondTable`,
  `${S}-myCallbackHandler dynamodb:MyThirdTable`,
  `${S}-mySecondCallbackHandler dynamodb:MyFourthTable`
];

const TABLES = ['MyFirstTable', 'MySecondTable', 'MyThirdTable', 'MyFourthTable'];

const putItem = (TableName, id) =>
  client.send(new PutItemCommand({Item: {id: {S: id}}, TableName}));

// Dynamodb-local only surfaces stream records once a table is non-empty, so seed every table,
// let the readers attach, then write the records the handlers should receive.
const populateTables = async () => {
  await Promise.all(TABLES.map(TableName => putItem(TableName, 'Stub')));
  await delay(1500);
  await Promise.all(TABLES.map(TableName => putItem(TableName, `${TableName}Id`)));
};

runOfflineTest({
  config: 'serverless.dynamodb-streams.yml',
  label: 'test-dynamodb-streams',
  expectedKeys: EXPECTED_KEYS,
  readyPattern: /Starting Offline Dynamodb Streams/,
  onReady: populateTables
});
