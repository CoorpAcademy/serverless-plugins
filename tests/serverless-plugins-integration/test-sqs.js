const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {SQS} = require('aws-sdk');
const pump = require('pump');
const {getSplitLinesTransform} = require('./utils');

const client = new SQS({
  region: 'eu-west-1',
  accessKeyId: 'local',
  secretAccessKey: 'local',
  endpoint: 'http://localhost:9324'
});

const sendMessages = () => {
  return Promise.all([
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyFirstQueue',
        MessageBody: 'MyFirstMessage',
        MessageAttributes: {
          myAttribute: {DataType: 'String', StringValue: 'myAttribute'}
        }
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MySecondQueue',
        MessageBody: 'MySecondMessage'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyThirdQueue',
        MessageBody: 'MyThirdMessage'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/MyFourthQueue',
        MessageBody: 'MyFourthMessage'
      })
      .promise()
  ]);
};

const serverless = spawn('serverless', ['--config', 'serverless.sqs.yml', 'offline', 'start'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

pump(
  serverless.stdout,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline SQS/.test(line)) {
        sendMessages();
      }

      this.count =
        (this.count || 0) +
        (
          line.match(
            /offline: \(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
          ) || []
        ).length;

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
