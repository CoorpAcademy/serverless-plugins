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

const envMatch = [];

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
      envMatch.push(...(output.match(/>> I am sqs-offline( overrided in da function)?/g) || []));

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
  console.log(envMatch);
  const functionOverrides = envMatch.filter(msg => msg.endsWith('overrided in da function'));
  if (envMatch.length !== 4) {
    console.error('Looks like there was some issue with the env logs: missing env');
    process.exit(2);
  }
  if (functionOverrides.length !== 2) {
    console.error('Looks like function overrides were not applied correctl');
    process.exit(2);
  }
  process.exit(code);
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
