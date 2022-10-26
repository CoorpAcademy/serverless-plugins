const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {Kinesis} = require('aws-sdk');
const pump = require('pump');
const {delay, getSplitLinesTransform} = require('./utils');

const client = new Kinesis({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:4567'
});

const putRecords = async () => {
  await delay(1000);

  await Promise.all([
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

const serverless = spawn('sls', ['offline', 'start', '--config', 'serverless.kinesis.yml'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

pump(
  serverless.stderr,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline Kinesis/.test(line)) {
        putRecords();
      }

      this.count =
        (this.count || 0) +
        (line.match(/\(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g) || [])
          .length;
      if (this.count === 4) serverless.kill();
      cb();
    }
  })
);

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
