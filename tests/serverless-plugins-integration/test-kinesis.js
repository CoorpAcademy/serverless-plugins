/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {Kinesis} = require('aws-sdk');

const client = new Kinesis({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:4567'
});

const putRecords = () => {
  return Promise.all([
    client
      .putRecord({
        StreamName: 'MyFirstStream',
        PartitionKey: 'MyFirstMessage',
        Data: 'MyFirstMessage'
      })
      .promise(),
    client
      .putRecord({
        StreamName: 'MySecondStream',
        PartitionKey: 'MySecondMessage',
        Data: 'MySecondMessage'
      })
      .promise(),
    client
      .putRecord({
        StreamName: 'MyThirdStream',
        PartitionKey: 'MyThirdMessage',
        Data: 'MyThirdMessage'
      })
      .promise(),
    client
      .putRecord({
        StreamName: 'MyFourthStream',
        PartitionKey: 'MyFourthMessage',
        Data: 'MyFourthMessage'
      })
      .promise()
  ]);
};

const serverless = spawn('serverless', ['--config', 'serverless.kinesis.yml', 'offline'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Offline.+listening on/.test(output)) {
        putRecords();
      }

      this.count = (this.count || 0) + (output.match(/\[✔]/g) || []).length;
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
