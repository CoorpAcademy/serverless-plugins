const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {DynamoDB} = require('aws-sdk');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const client = new DynamoDB({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:8000'
});

// Dynamodb-local doesn't create stream until table isn't empty
const unemptyTables = () =>
  Promise.all(
    ['MyFirstTable', 'MySecondTable', 'MyThirdTable', 'MyFourthTable'].map(TableName =>
      client
        .putItem({
          Item: {id: {S: 'Stub'}},
          TableName
        })
        .promise()
    )
  );

const putItems = () =>
  Promise.all(
    ['First', 'Second', 'Third', 'Fourth'].map(order =>
      client
        .putItem({
          Item: {id: {S: `My${order}Id`}},
          TableName: `My${order}Table`
        })
        .promise()
    )
  );

let setupInProgress = true;
const populateTables = async () => {
  await unemptyTables();
  await delay(1200);
  setupInProgress = false;
  await putItems();
};

const serverless = spawn(
  'sls',
  ['offline', 'start', '--config', 'serverless.dynamodb-streams.yml'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname
  }
);

const set = new Set();
let invocationCount = 0;
pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline Dynamodb Streams/.test(line)) {
        populateTables(); // will run in the background
      }

      if (setupInProgress) return cb(); // do not consider lambda executions before we post the real items

      const matches = /\(λ: (.*)\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g.exec(
        line
      );

      if (matches) {
        invocationCount++;
        set.add(matches[1]);
      }

      if (set.size === 3 && invocationCount === 4) serverless.kill(); // myPromiseHandler is mapped to two tables
      cb();
    }
  })
);

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
