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
        QueueUrl: 'http://localhost:9324/queue/AutocreatedImplicitQueue',
        MessageBody: 'AutocreatedImplicitQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedQueue',
        MessageBody: 'AutocreatedQueue'
      })
      .promise(),
    client
      .sendMessage({
        QueueUrl: 'http://localhost:9324/queue/AutocreatedFifoQueue.fifo',
        MessageBody: 'AutocreatedFifoQueue',
        MessageGroupId: '1'
      })
      .promise()
  ]);
};

const serverless = spawn(
  'npx',
  ['serverless', '--config', 'serverless.sqs.autocreate.yml', 'offline', 'start'],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname
  }
);

pump(
  serverless.stdout,
  getSplitLinesTransform(),
  new Writable({
    objectMode: true,
    write(line, enc, cb) {
      if (/Starting Offline SQS/.test(line)) {
        sendMessages()
          .then(() => console.log('sucessfully send messages'))
          .catch(err => {
            console.log('Some issue sending message:s', err.message);
          });
      }

      this.count =
        (this.count || 0) +
        (
          line.match(
            /offline: \(λ: .*\) RequestId: .* Duration: .* ms {2}Billed Duration: .* ms/g
          ) || []
        ).length;
      if (this.count === 3) serverless.kill();
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

async function pruneQueue(QueueName) {
  const {QueueUrl} = await client
    .getQueueUrl({QueueName})
    .promise()
    .catch(err => {
      console.log(`Ignore issue that occured pruning ${QueueName}: ${err.message}`);
      return {QueueUrl: null};
    });
  if (QueueUrl) await client.deleteQueue({QueueUrl}).promise();
}

async function cleanUp() {
  await Promise.all([
    pruneQueue('AutocreatedImplicitQueue'),
    pruneQueue('AutocreatedQueue'),
    pruneQueue('AutocreatedFifoQueue.fifo')
  ]);
}

serverless.on('close', code => {
  cleanUp()
    .then(() => {
      return process.exit(code);
    })
    .catch(err => {
      console.error(`Queue deletion failed: ${err.message}`);
      process.exit(code || 12);
    });
});

onExit((code, signal) => {
  if (signal) serverless.kill(signal);
});
