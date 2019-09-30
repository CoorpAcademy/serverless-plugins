/* eslint-disable unicorn/no-process-exit */
const {Writable} = require('stream');
const {spawn} = require('child_process');
const onExit = require('signal-exit');
const {SQS} = require('aws-sdk');

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
        MessageBody: 'MyFirstMessage'
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

const serverless = spawn('serverless', ['--config', 'serverless.sqs.yml', 'offline'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname
});

serverless.stdout.pipe(
  new Writable({
    write(chunk, enc, cb) {
      const output = chunk.toString();

      if (/Offline \[HTTP\] listening on/.test(output)) {
        sendMessages();
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
