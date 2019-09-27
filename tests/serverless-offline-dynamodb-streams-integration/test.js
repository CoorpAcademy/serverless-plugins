/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {DynamoDB} = require('aws-sdk');

const client = new DynamoDB({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:8000'
});

const putItems = () => {
  return Promise.all([
    client
      .putItem({
        Item: {id: {S: 'MyFirstId'}},
        TableName: 'MyFirstTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: 'MySecondId'}},
        TableName: 'MySecondTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: 'MyThirdId'}},
        TableName: 'MyThirdTable'
      })
      .promise(),
    client
      .putItem({
        Item: {id: {S: 'MyFourthId'}},
        TableName: 'MyFourthTable'
      })
      .promise()
  ]);
};

const serverless = spawn('sls', ['offline'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Offline listening on/.test(output)) {
        putItems();
      }

      this.count = (this.count || 0) + (output.match(/\[✔\]/g) || []).length;
      if (this.count === 4) serverless.kill();
      cb();
    }
  })
);

serverless.stdout.on('data', data => {
  console.log(data.toString());
});

serverless.stderr.on('data', data => {
  console.error(data.toString());
  process.exit(1);
});

serverless.on('close', code => {
  process.exit(code);
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
