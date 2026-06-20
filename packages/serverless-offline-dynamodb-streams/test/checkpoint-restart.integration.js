// #178 (jjohnson1994): integration repro for "stop replaying past DynamoDB stream events on every
// offline restart". Drives the real DynamodbStreams plugin class against local DynamoDB through a
// stop -> recreate cycle and asserts records delivered in the first run are NOT redelivered after a
// restart — only records written in between are. Requires a local DynamoDB at localhost:8000
// (brought up by `npm run test:unit`), so it is gated to the docker-backed run via DDB_LOCAL.
//
// Run standalone:
//   DDB_LOCAL=1 npx ava packages/serverless-offline-dynamodb-streams/test/checkpoint-restart.integration.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const test = require('ava');
const DynamoDB = require('aws-sdk/clients/dynamodb');

const DynamodbStreams = require('../src/dynamodb-streams');

const ENDPOINT = process.env.DDB_LOCAL_ENDPOINT || 'http://localhost:8000';
const REGION = 'eu-west-1';
const skipUnlessLocal = process.env.DDB_LOCAL ? test.serial : test.serial.skip;

const uuid = () => crypto.randomUUID();

const delay = timeout =>
  new Promise(resolve => {
    setTimeout(resolve, timeout);
  });

// Sequentially run an async effect over a list without a raw loop (keeps the suite FP/lint-clean).
const eachSeries = (items, effect) =>
  items.reduce((previous, item) => previous.then(() => effect(item)), Promise.resolve());

// Minimal stand-in for serverless-offline's Lambda registry: every runHandler() records the keys
// of the records it was handed, so the test can assert exactly which records each run delivered.
const makeLambdaStub = delivered => {
  const lambdaFunction = {
    event: null,
    setEvent(event) {
      this.event = event;
    },
    runHandler() {
      this.event.Records.forEach(record => delivered.push(record.dynamodb.Keys.Id.S));
      return Promise.resolve();
    }
  };
  return {get: () => lambdaFunction};
};

const baseOptions = location => ({
  region: REGION,
  accountId: '000000000000',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: ENDPOINT,
  location
});

const putItem = (client, TableName, id) =>
  client.putItem({Item: {Id: {S: id}}, TableName}).promise();

const runOnce = async ({location, tableName, delivered, settle = 2500}) => {
  const dynamodbStreams = new DynamodbStreams(
    makeLambdaStub(delivered),
    baseOptions(location),
    undefined
  );
  await dynamodbStreams.create([{functionKey: 'handler', dynamodbStreams: {tableName}}]);
  dynamodbStreams.start();
  await delay(settle);
  await dynamodbStreams.stop();
  return dynamodbStreams;
};

skipUnlessLocal(
  'does not redeliver already-checkpointed records after an offline restart (#178)',
  async t => {
    const client = new DynamoDB(baseOptions());
    const tableName = `repro-${uuid()}`;
    const location = fs.mkdtempSync(path.join(os.tmpdir(), 'ddb-checkpoint-'));

    await client
      .createTable({
        TableName: tableName,
        AttributeDefinitions: [{AttributeName: 'Id', AttributeType: 'S'}],
        KeySchema: [{AttributeName: 'Id', KeyType: 'HASH'}],
        StreamSpecification: {StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES'},
        ProvisionedThroughput: {ReadCapacityUnits: 1, WriteCapacityUnits: 1}
      })
      .promise();
    await client.waitFor('tableExists', {TableName: tableName}).promise();

    // First run: write 3 records, let them be delivered, then stop (persisting the checkpoint).
    const firstBatch = [uuid(), uuid(), uuid()];
    const deliveredFirst = [];
    // Start the reader first so a TRIM_HORIZON cold start has the shard iterator before writes.
    const first = new DynamodbStreams(
      makeLambdaStub(deliveredFirst),
      baseOptions(location),
      undefined
    );
    await first.create([{functionKey: 'handler', dynamodbStreams: {tableName}}]);
    first.start();
    await delay(500);
    await eachSeries(firstBatch, id => putItem(client, tableName, id));
    await delay(2500);
    await first.stop();

    t.deepEqual(
      [...deliveredFirst].sort(),
      [...firstBatch].sort(),
      'first run delivers exactly the first batch'
    );

    // The checkpoint file must now exist with a saved sequence number for the shard.
    const stateFile = path.join(location, '.serverless-offline-dynamodb-streams');
    t.true(fs.existsSync(stateFile), 'a checkpoint state file is written on stop');

    // Write more records AFTER the first run stopped — these are the only ones the restart should see.
    const secondBatch = [uuid(), uuid()];
    await eachSeries(secondBatch, id => putItem(client, tableName, id));

    // Restart: a brand-new instance reads the persisted checkpoint and must resume PAST the first
    // batch — delivering only the second batch, never replaying the already-processed records.
    const deliveredSecond = [];
    await runOnce({location, tableName, delivered: deliveredSecond, settle: 3000});

    t.deepEqual(
      [...deliveredSecond].sort(),
      [...secondBatch].sort(),
      'restart delivers only the records written after the checkpoint, not the replayed first batch'
    );
    firstBatch.forEach(id =>
      t.false(deliveredSecond.includes(id), `record ${id} must not be redelivered`)
    );
  }
);
